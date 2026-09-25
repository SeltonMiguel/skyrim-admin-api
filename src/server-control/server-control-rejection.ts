import { ConflictException } from '@nestjs/common';

export type ServerControlRejectionCode =
  | 'SERVER_MISMATCH'
  | 'CORRELATION_MISMATCH'
  | 'OPERATION_MISMATCH'
  | 'INACTIVE_SESSION'
  | 'NOT_DISPATCHED'
  | 'RESULT_CONFLICT';
const MESSAGES: Record<ServerControlRejectionCode, string> = {
  SERVER_MISMATCH: 'Result does not match the operation',
  CORRELATION_MISMATCH: 'Result does not match the operation',
  OPERATION_MISMATCH: 'Result action does not match the operation',
  INACTIVE_SESSION: 'Agent session no longer active',
  NOT_DISPATCHED: 'Operation was never dispatched',
  RESULT_CONFLICT: 'Operation already completed with another result',
};
// Typed refusal of a Server Control result, mapped to protocol answers by
// the Agent adapter.
export class ServerControlRejection extends ConflictException {
  constructor(readonly code: ServerControlRejectionCode) {
    super(MESSAGES[code]);
  }
}
