import { AuditAction as A } from '../audit/audit.types.js';
import { Permission as P } from '../rbac/permissions.js';

// Operational lifecycle requests for the future Agent. Never GameCommand types:
// there is no payload, no free-form command and no generic execute operation.
export const SERVER_CONTROL_TYPES = [
  'SERVER_START',
  'SERVER_PAUSE',
  'SERVER_RESTART',
] as const;
export type ServerControlType = (typeof SERVER_CONTROL_TYPES)[number];
export function isServerControlType(
  value: unknown,
): value is ServerControlType {
  return SERVER_CONTROL_TYPES.includes(value as ServerControlType);
}

// PENDING: persisted, not yet handed to a transport.
// DISPATCHED: transport accepted, or delivery could not be refuted; never resent.
// SUCCEEDED: reserved for the Agent result receiver (Etapa 11); unreachable now.
// FAILED: definitely not delivered (no Agent, rejected, or server disabled).
export enum ServerControlStatus {
  PENDING = 'PENDING',
  DISPATCHED = 'DISPATCHED',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
}
export const SERVER_CONTROL_ERRORS = {
  AGENT_UNAVAILABLE: 'No server control Agent connected',
  AGENT_REJECTED: 'Server control transport rejected the request',
  SERVER_DISABLED: 'Game server disabled',
} as const;
export type ServerControlErrorCode = keyof typeof SERVER_CONTROL_ERRORS;

export const SERVER_CONTROL_POLICY: Readonly<
  Record<
    ServerControlType,
    { permission: P; auditAction: A; path: 'start' | 'pause' | 'restart' }
  >
> = {
  SERVER_START: {
    permission: P.SERVER_START,
    auditAction: A.SERVER_START_REQUESTED,
    path: 'start',
  },
  SERVER_PAUSE: {
    permission: P.SERVER_PAUSE,
    auditAction: A.SERVER_PAUSE_REQUESTED,
    path: 'pause',
  },
  SERVER_RESTART: {
    permission: P.SERVER_RESTART,
    auditAction: A.SERVER_RESTART_REQUESTED,
    path: 'restart',
  },
};
