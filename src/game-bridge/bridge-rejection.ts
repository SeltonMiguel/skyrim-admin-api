import { ConflictException } from '@nestjs/common';

// Typed reasons for refusing an ACK/RESULT, so transports can answer
// precisely without parsing messages. Still 409 Conflict for HTTP callers.
export type BridgeRejectionCode =
  | 'SERVER_MISMATCH'
  | 'CORRELATION_MISMATCH'
  | 'STALE_ATTEMPT'
  | 'INACTIVE_SESSION'
  | 'NOT_DISPATCHED'
  | 'RESULT_CONFLICT';
const MESSAGES: Record<BridgeRejectionCode, string> = {
  SERVER_MISMATCH: 'Bridge message does not match command',
  CORRELATION_MISMATCH: 'Bridge message does not match command',
  STALE_ATTEMPT: 'Bridge message does not match command',
  INACTIVE_SESSION: 'Bridge connection no longer active',
  NOT_DISPATCHED: 'Command was never dispatched',
  RESULT_CONFLICT: 'Command already completed with another result',
};
export class BridgeRejection extends ConflictException {
  constructor(readonly code: BridgeRejectionCode) {
    super(MESSAGES[code]);
  }
}
