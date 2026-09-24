import type { Actor } from '../actors/actor.contracts.js';
import {
  worldPayload,
  worldResult,
  WORLD_COMMAND_TYPES,
  isWorldCommand,
} from '../world-management/world-command.contracts.js';
import type { WorldCommandMap } from '../world-management/world-command.contracts.js';
import {
  moderationPayload,
  moderationResult,
  MODERATION_COMMAND_TYPES,
  isModerationCommand,
} from '../moderation/moderation-command.contracts.js';
import type { ModerationCommandMap } from '../moderation/moderation-command.contracts.js';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { canonicalJson } from './canonical-json.js';
import { isUUID } from 'class-validator';
import { CommandStatus } from './command-state.js';
import type { GameCommand } from './entities/game-command.entity.js';

import {
  characterPayload,
  characterResult,
  CHARACTER_COMMAND_TYPES,
  isCharacterCommand,
} from '../character-management/character-command.contracts.js';
import type { CharacterCommandMap } from '../character-management/character-command.contracts.js';
import { MAX_COMMAND_PAYLOAD_BYTES } from './command-limits.js';
export {
  MAX_COMMAND_PAYLOAD_BYTES,
  MAX_COMMAND_RESULT_BYTES,
} from './command-limits.js';

export const PROTOCOL_VERSION = '1' as const;
export interface CommandMap
  extends CharacterCommandMap, ModerationCommandMap, WorldCommandMap {
  BRIDGE_PING: { payload: { nonce: string }; result: { nonce: string } };
}
export type CommandType = keyof CommandMap;
export const COMMAND_TYPES: readonly CommandType[] = [
  'BRIDGE_PING',
  ...CHARACTER_COMMAND_TYPES,
  ...MODERATION_COMMAND_TYPES,
  ...WORLD_COMMAND_TYPES,
];
export type CommandPayload<T extends CommandType> = CommandMap[T]['payload'];
export type CommandResult<T extends CommandType> = CommandMap[T]['result'];
export type SubmitCommand = {
  [T in CommandType]: {
    gameServerId: string;
    type: T;
    payload: CommandPayload<T>;
    idempotencyKey: string;
    // Legacy staff attribution; mutually exclusive with actor.
    requestedByStaffId?: string;
    // Internal origin; never taken from HTTP input. Absent means the shared
    // STAFF scope without attribution (existing internal submits).
    actor?: Actor;
  };
}[CommandType];
export interface BridgeMessage {
  protocolVersion: typeof PROTOCOL_VERSION;
  serverId: string;
  connectionId: string;
  commandId: string;
  correlationId: string;
}
export type ResultMessage<T extends CommandType = CommandType> = BridgeMessage &
  (
    | {
        outcome: CommandStatus.SUCCEEDED;
        result: CommandResult<T>;
      }
    | {
        outcome: CommandStatus.FAILED;
        errorCode: 'PING_REJECTED' | 'BRIDGE_ERROR';
      }
  );
export interface CommandEnvelope<T extends CommandType = CommandType> {
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  correlationId: string;
  serverId: string;
  connectionId: string;
  idempotencyKey: string;
  type: T;
  payload: CommandPayload<T>;
  issuedAt: string;
  ackDeadlineAt: string;
  executionDeadlineAt: string;
}
export function identifier(value: string, name: string, max = 128): void {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  )
    throw new BadRequestException(`Invalid ${name}`);
}
export function uuid(value: string): void {
  if (typeof value !== 'string' || !isUUID(value))
    throw new BadRequestException('Invalid UUID');
}
// A small allowlisted contract avoids recursive JSON types and never interprets strings.
// Validate and copy before the first await so caller mutation cannot change the command.
export function pingData(value: unknown): CommandPayload<'BRIDGE_PING'> {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new BadRequestException('Invalid BRIDGE_PING data');
  const keys = Reflect.ownKeys(value);
  const descriptor = Object.getOwnPropertyDescriptor(value, 'nonce');
  if (
    keys.length !== 1 ||
    keys[0] !== 'nonce' ||
    !descriptor ||
    !('value' in descriptor)
  )
    throw new BadRequestException('Invalid BRIDGE_PING data');
  const nonce: unknown = descriptor.value;
  if (
    typeof nonce !== 'string' ||
    Buffer.byteLength(nonce, 'utf8') > MAX_COMMAND_PAYLOAD_BYTES
  )
    throw new BadRequestException('BRIDGE_PING data too large or invalid');
  identifier(nonce, 'nonce');
  const data = { nonce };
  if (
    Buffer.byteLength(JSON.stringify(data), 'utf8') > MAX_COMMAND_PAYLOAD_BYTES
  )
    throw new BadRequestException('BRIDGE_PING data too large');
  return data;
}
export function commandPayload<T extends CommandType>(
  type: T,
  payload: unknown,
): CommandPayload<T> {
  if (type === 'BRIDGE_PING') return pingData(payload) as CommandPayload<T>;
  if (isCharacterCommand(type))
    return characterPayload(type, payload) as CommandPayload<T>;
  if (isModerationCommand(type))
    return moderationPayload(type, payload) as CommandPayload<T>;
  if (isWorldCommand(type))
    return worldPayload(type, payload) as CommandPayload<T>;
  throw new BadRequestException('Unsupported command type');
}
export function commandResult<T extends CommandType>(
  type: T,
  value: unknown,
  payload: unknown,
): CommandResult<T> {
  if (type === 'BRIDGE_PING') {
    const result = pingData(value);
    if (result.nonce !== pingData(payload).nonce)
      throw new ConflictException('Result nonce mismatch');
    return result as CommandResult<T>;
  }
  if (isCharacterCommand(type))
    return characterResult(type, value, payload) as CommandResult<T>;
  if (isModerationCommand(type))
    return moderationResult(type, value, payload) as CommandResult<T>;
  if (isWorldCommand(type))
    return worldResult(type, value, payload) as CommandResult<T>;
  throw new BadRequestException('Unsupported command type');
}
export function sameCommand(
  existing: Pick<GameCommand, 'type' | 'payload'>,
  type: CommandType,
  payload: object,
): boolean {
  return (
    existing.type === type &&
    canonicalJson(
      commandPayload(existing.type, existing.payload),
      MAX_COMMAND_PAYLOAD_BYTES,
    ) ===
      canonicalJson(commandPayload(type, payload), MAX_COMMAND_PAYLOAD_BYTES)
  );
}
export function validateMessage(message: BridgeMessage): void {
  if (message.protocolVersion !== PROTOCOL_VERSION)
    throw new BadRequestException('Unsupported protocol version');
  uuid(message.serverId);
  uuid(message.connectionId);
  uuid(message.commandId);
  uuid(message.correlationId);
}
export function envelope(command: GameCommand): CommandEnvelope {
  if (
    !command.dispatchedConnectionId ||
    !command.ackDeadlineAt ||
    !command.executionDeadlineAt
  )
    throw new Error('Command dispatch metadata missing');
  return {
    protocolVersion: PROTOCOL_VERSION,
    commandId: command.id,
    correlationId: command.correlationId,
    serverId: command.gameServerId,
    connectionId: command.dispatchedConnectionId,
    idempotencyKey: command.idempotencyKey,
    type: command.type,
    payload: commandPayload(command.type, command.payload),
    issuedAt: command.createdAt.toISOString(),
    ackDeadlineAt: command.ackDeadlineAt.toISOString(),
    executionDeadlineAt: command.executionDeadlineAt.toISOString(),
  };
}
