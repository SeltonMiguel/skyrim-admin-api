import { isUUID } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { MAX_COMMAND_RESULT_BYTES } from '../game-bridge/command-limits.js';
import {
  PROTOCOL_VERSION,
  REMOTE_FAILURE_CODES,
  UNCERTAIN_OUTCOME,
} from '../game-bridge/command-contract.js';
import type { RemoteFailureCode } from '../game-bridge/command-contract.js';

// Host Agent WebSocket protocol v1 (Etapa 11.1). The version is the one the
// Game Bridge already persists in game_connections.protocol_version; there
// is no fallback to any other version.
export const AGENT_PATH = '/api/v1/agent';
export const AGENT_PROTOCOL_VERSION = PROTOCOL_VERSION;
// One place for the frame ceiling: a maximal GameCommand result (64 KiB)
// plus envelope and JSON overhead. ws closes larger frames (1009) itself,
// before any parse.
export const MAX_AGENT_FRAME_BYTES = 128 * 1024;
export const MAX_AGENT_CAPABILITIES = 64;
if (MAX_AGENT_FRAME_BYTES < 2 * MAX_COMMAND_RESULT_BYTES)
  throw new Error('Agent frame limit must hold a maximal command result');

// Frames the Agent may send. HELLO only as the first frame; DOMAIN_EVENT
// and SERVER_CONTROL_RESULT are typed but answered with NOT_IMPLEMENTED
// until 11.3–11.4.
export const AGENT_INBOUND_TYPES = [
  'HELLO',
  'HEARTBEAT',
  'COMMAND_ACK',
  'COMMAND_RESULT',
  'DOMAIN_EVENT',
  'SERVER_CONTROL_RESULT',
  'ERROR',
] as const;
// Frames the backend sends. SERVER_CONTROL and WORK_ITEMS are declared for
// later substeps and never sent yet.
export const AGENT_OUTBOUND_TYPES = [
  'AUTHENTICATED',
  'HEARTBEAT_ACK',
  'ERROR',
  'COMMAND',
  'COMMAND_RESULT_ACK',
  'SERVER_CONTROL',
  'WORK_ITEMS',
] as const;
// Declared for 11.4; an Agent sending it now breaks the protocol.
export const AGENT_FUTURE_INBOUND_TYPES = ['WORK_SYNC'] as const;
export type AgentInboundType = (typeof AGENT_INBOUND_TYPES)[number];
export type AgentOutboundType = (typeof AGENT_OUTBOUND_TYPES)[number];

// Process state reported by the Host Agent; independent from SKSE
// readiness. There is no separate CRASHED state: a crashed process is
// STOPPED (or RESTARTING while the Agent recovers it).
export enum GameProcessState {
  UNKNOWN = 'UNKNOWN',
  STOPPED = 'STOPPED',
  STARTING = 'STARTING',
  RUNNING = 'RUNNING',
  PAUSED = 'PAUSED',
  STOPPING = 'STOPPING',
  RESTARTING = 'RESTARTING',
}
export interface AgentRuntime {
  gameProcessState: GameProcessState;
  skseReady: boolean;
}
// Game ready = process RUNNING and the local SKSE bridge ready. A connected
// Agent alone never means Skyrim is available.
export const isRuntimeReady = (runtime: AgentRuntime) =>
  runtime.gameProcessState === GameProcessState.RUNNING && runtime.skseReady;

// Application close codes (4000–4999), distinct from the realtime surface.
export const AgentClose = {
  AUTH_TIMEOUT: 4000,
  UNAUTHORIZED: 4001,
  PROTOCOL_ERROR: 4003,
  PROTOCOL_UNSUPPORTED: 4005,
  SUPERSEDED: 4006,
  HEARTBEAT_TIMEOUT: 4008,
  CREDENTIAL_REVOKED: 4009,
  SERVER_MISMATCH: 4010,
  SESSION_CLOSED: 4011,
  RATE_LIMITED: 4012,
  SHUTDOWN: 1001,
} as const;
export type AgentCloseReason = keyof typeof AgentClose;
// Closed catalog carried by ERROR frames; never exception text or stacks.
export type AgentErrorCode =
  | 'NOT_IMPLEMENTED'
  | 'INVALID_MESSAGE'
  | 'UNKNOWN_COMMAND'
  | 'NOT_DISPATCHED'
  | 'RESULT_CONFLICT'
  | 'TEMPORARILY_UNAVAILABLE';

export interface AgentEnvelope<T extends string = string> {
  protocolVersion: typeof AGENT_PROTOCOL_VERSION;
  type: T;
  messageId: string;
  gameServerId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}
export interface HelloPayload extends AgentRuntime {
  credentialId: string;
  credentialSecret: string;
  agentVersion: string;
  capabilities: string[];
}
export type HeartbeatPayload = AgentRuntime & { capabilities?: string[] };

export class AgentProtocolError extends Error {
  constructor(readonly reason: 'PROTOCOL_ERROR' | 'PROTOCOL_UNSUPPORTED') {
    super(reason);
  }
}
const invalid = (): never => {
  throw new AgentProtocolError('PROTOCOL_ERROR');
};
const plain = (value: unknown): Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  Object.getPrototypeOf(value) === Object.prototype
    ? (value as Record<string, unknown>)
    : invalid();
function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const keys = Object.keys(value);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  )
    invalid();
}
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const uuid = (value: unknown): string =>
  typeof value === 'string' && isUUID(value) ? value.toLowerCase() : invalid();

// Parses and copies one text frame. Unknown or extra keys are rejected,
// matching the closed validation used by the rest of the project. A wrong
// protocol version is reported separately so the Agent learns why.
export function parseEnvelope(raw: string): AgentEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return invalid();
  }
  const frame = plain(value);
  exactKeys(frame, [
    'protocolVersion',
    'type',
    'messageId',
    'gameServerId',
    'occurredAt',
    'payload',
  ]);
  if (typeof frame.protocolVersion !== 'string') invalid();
  if (frame.protocolVersion !== AGENT_PROTOCOL_VERSION)
    throw new AgentProtocolError('PROTOCOL_UNSUPPORTED');
  if (
    typeof frame.type !== 'string' ||
    typeof frame.occurredAt !== 'string' ||
    !ISO_UTC.test(frame.occurredAt) ||
    Number.isNaN(Date.parse(frame.occurredAt))
  )
    invalid();
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    type: frame.type as string,
    messageId: uuid(frame.messageId),
    gameServerId: uuid(frame.gameServerId),
    occurredAt: frame.occurredAt as string,
    payload: { ...plain(frame.payload) },
  };
}
export const isInboundType = (type: string): type is AgentInboundType =>
  (AGENT_INBOUND_TYPES as readonly string[]).includes(type);

// 256-bit secrets are 43 base64url characters without padding.
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const VERSION = /^[A-Za-z0-9._:-]{1,64}$/;
// Capabilities express operational compatibility, never authorization.
const CAPABILITY = /^[A-Z][A-Z0-9_]{0,63}$/;
function capabilities(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_AGENT_CAPABILITIES) invalid();
  const list = (value as unknown[]).map((item) =>
    typeof item === 'string' && CAPABILITY.test(item) ? item : invalid(),
  );
  if (new Set(list).size !== list.length) invalid();
  return list;
}
function runtime(payload: Record<string, unknown>): AgentRuntime {
  if (
    !Object.values(GameProcessState).includes(
      payload.gameProcessState as GameProcessState,
    ) ||
    typeof payload.skseReady !== 'boolean'
  )
    invalid();
  return {
    gameProcessState: payload.gameProcessState as GameProcessState,
    skseReady: payload.skseReady as boolean,
  };
}
export function helloPayload(payload: Record<string, unknown>): HelloPayload {
  exactKeys(payload, [
    'credentialId',
    'credentialSecret',
    'agentVersion',
    'capabilities',
    'gameProcessState',
    'skseReady',
  ]);
  if (
    typeof payload.credentialSecret !== 'string' ||
    !SECRET.test(payload.credentialSecret) ||
    typeof payload.agentVersion !== 'string' ||
    !VERSION.test(payload.agentVersion)
  )
    invalid();
  return {
    credentialId: uuid(payload.credentialId),
    credentialSecret: payload.credentialSecret as string,
    agentVersion: payload.agentVersion as string,
    capabilities: capabilities(payload.capabilities),
    ...runtime(payload),
  };
}
// Capabilities may change with the running game (e.g. a plugin update);
// omitting them keeps the ones announced before.
export function heartbeatPayload(
  payload: Record<string, unknown>,
): HeartbeatPayload {
  exactKeys(payload, ['gameProcessState', 'skseReady'], ['capabilities']);
  return {
    ...runtime(payload),
    ...(payload.capabilities === undefined
      ? {}
      : { capabilities: capabilities(payload.capabilities) }),
  };
}

// COMMAND_ACK: the Agent received this delivery attempt. The session (and
// so the connection) comes from the socket, never from the payload.
export interface CommandAckPayload {
  commandId: string;
  correlationId: string;
  attempt: number;
}
export function commandAckPayload(
  payload: Record<string, unknown>,
): CommandAckPayload {
  exactKeys(payload, ['commandId', 'correlationId', 'attempt']);
  if (
    typeof payload.attempt !== 'number' ||
    !Number.isSafeInteger(payload.attempt) ||
    payload.attempt < 1
  )
    invalid();
  return {
    commandId: uuid(payload.commandId),
    correlationId: uuid(payload.correlationId),
    attempt: payload.attempt as number,
  };
}
// COMMAND_RESULT: the outcome of the command (any attempt, any session of
// the server). No free-text message is accepted: the backend stores its
// own catalog message. The typed result is validated per command type by
// the Game Bridge.
export type CommandResultPayload = {
  commandId: string;
  correlationId: string;
} & (
  | { outcome: 'SUCCEEDED'; result: unknown }
  | { outcome: 'FAILED'; errorCode: RemoteFailureCode }
  | { outcome: typeof UNCERTAIN_OUTCOME }
);
export function commandResultPayload(
  payload: Record<string, unknown>,
): CommandResultPayload {
  const ids = {
    commandId: uuid(payload.commandId),
    correlationId: uuid(payload.correlationId),
  };
  switch (payload.outcome) {
    case 'SUCCEEDED':
      exactKeys(payload, ['commandId', 'correlationId', 'outcome', 'result']);
      return { ...ids, outcome: 'SUCCEEDED', result: payload.result };
    case 'FAILED':
      exactKeys(payload, [
        'commandId',
        'correlationId',
        'outcome',
        'errorCode',
      ]);
      if (
        !REMOTE_FAILURE_CODES.includes(payload.errorCode as RemoteFailureCode)
      )
        invalid();
      return {
        ...ids,
        outcome: 'FAILED',
        errorCode: payload.errorCode as RemoteFailureCode,
      };
    case UNCERTAIN_OUTCOME:
      exactKeys(payload, ['commandId', 'correlationId', 'outcome']);
      return { ...ids, outcome: UNCERTAIN_OUTCOME };
    default:
      return invalid();
  }
}

export function outbound(
  type: AgentOutboundType,
  gameServerId: string,
  payload: Record<string, unknown>,
  now: Date,
): AgentEnvelope<AgentOutboundType> {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    type,
    messageId: randomUUID(),
    gameServerId,
    occurredAt: now.toISOString(),
    payload,
  };
}
