import { NotFoundException } from '@nestjs/common';
import type { GameCommand } from '../game-bridge/entities/game-command.entity.js';
import type { GameCommandResult } from '../game-bridge/entities/game-command-result.entity.js';
import {
  characterPayload,
  characterResult,
  isCharacterCommand,
} from './character-command.contracts.js';
import type {
  CharacterOperationReferenceDto,
  CharacterOperationDetailDto,
} from './dto/operation.dto.js';

export function operationReference(
  command: GameCommand,
): CharacterOperationReferenceDto {
  if (!isCharacterCommand(command.type))
    throw new NotFoundException('Character operation not found');
  return {
    commandId: command.id,
    gameServerId: command.gameServerId,
    characterId: characterPayload(command.type, command.payload).characterId,
    type: command.type,
    status: command.status,
    correlationId: command.correlationId,
    requestId: command.requestId,
    createdAt: command.createdAt,
  };
}
export function operationDetail(
  command: GameCommand & { result: GameCommandResult | null },
): CharacterOperationDetailDto {
  if (!isCharacterCommand(command.type))
    throw new NotFoundException('Character operation not found');
  const result = command.result;
  return {
    ...operationReference(command),
    requestedByStaffId: command.requestedByStaffId,
    dispatchAttempts: command.dispatchAttempts,
    lastDispatchAt: command.lastDispatchAt,
    acknowledgedAt: command.acknowledgedAt,
    completedAt: command.completedAt,
    payload: characterPayload(command.type, command.payload),
    ackDeadlineAt: command.ackDeadlineAt,
    executionDeadlineAt: command.executionDeadlineAt,
    result: result
      ? {
          outcome: result.outcome,
          result:
            result.result === null
              ? null
              : characterResult(command.type, result.result, command.payload),
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
          receivedAt: result.receivedAt,
        }
      : null,
  };
}
