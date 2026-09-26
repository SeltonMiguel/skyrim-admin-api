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

// At-most-once lifecycle (Etapa 11.3). The delivery boundary is the claim:
// once dispatch_claimed_at is committed the operation may have reached the
// Host Agent and is never sent again, by anyone, for any reason.
// PENDING: persisted; before the claim nothing was sent. After a claim (a
//   crash between claim and send reconciliation) it is possibly delivered.
// DISPATCHED: handed to the transport, or delivery could not be refuted.
// SUCCEEDED: the Agent reported the intended effect.
// FAILED: definitely no effect: never delivered (no eligible Agent, disabled
//   server, proven non-delivery) or the Agent reported a definite failure.
// UNCERTAIN: terminal; the backend cannot say whether the action ran (no
//   result before the deadline, or the Agent itself could not prove it).
export enum ServerControlStatus {
  PENDING = 'PENDING',
  DISPATCHED = 'DISPATCHED',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  UNCERTAIN = 'UNCERTAIN',
}
export const SERVER_CONTROL_TERMINAL = [
  ServerControlStatus.SUCCEEDED,
  ServerControlStatus.FAILED,
  ServerControlStatus.UNCERTAIN,
] as const;
// Definite failures the Host Agent may report (closed, no free text).
export const SERVER_CONTROL_REMOTE_FAILURES = [
  'DELIVERY_EXPIRED', // received after notAfter: refused, nothing executed
  'INVALID_PROCESS_STATE', // action not applicable to the current process
  'EXECUTION_FAILED', // attempted; the process definitely did not change
] as const;
export type ServerControlRemoteFailure =
  (typeof SERVER_CONTROL_REMOTE_FAILURES)[number];
export const SERVER_CONTROL_ERRORS = {
  AGENT_UNAVAILABLE: 'No server control Agent connected',
  AGENT_REJECTED: 'Server control transport rejected the request',
  SERVER_DISABLED: 'Game server disabled',
  DISPATCH_EXPIRED:
    'No eligible server control Agent before the dispatch deadline',
  DELIVERY_EXPIRED: 'Agent refused the operation after its delivery window',
  INVALID_PROCESS_STATE:
    'Operation not applicable to the current game process state',
  EXECUTION_FAILED: 'Agent reported that the operation failed without effect',
  // UNCERTAIN reasons.
  RESULT_TIMEOUT: 'No result before the deadline; outcome unknown',
  OUTCOME_UNKNOWN: 'Agent could not determine whether the operation ran',
} as const satisfies Record<ServerControlRemoteFailure, string> &
  Record<string, string>;
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
// Operator resolution of an UNCERTAIN operation (12.4), after checking the
// real server state out of band. Never a retry: the original outcome stays.
export const SERVER_CONTROL_RESOLUTIONS = [
  'RESOLVED_SUCCEEDED',
  'RESOLVED_FAILED',
] as const;
export type ServerControlResolution =
  (typeof SERVER_CONTROL_RESOLUTIONS)[number];
