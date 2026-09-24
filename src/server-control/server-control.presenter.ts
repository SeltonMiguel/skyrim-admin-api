import type { ServerControlOperation } from './entities/server-control-operation.entity.js';
import { SERVER_CONTROL_ERRORS } from './server-control.contracts.js';
import type {
  ServerControlOperationDetailDto,
  ServerControlOperationReferenceDto,
} from './dto/server-control.dto.js';

// Explicit allowlist: never the Idempotency-Key or the internal dispatch claim.
export function serverControlReference(
  operation: ServerControlOperation,
): ServerControlOperationReferenceDto {
  return {
    operationId: operation.id,
    gameServerId: operation.gameServerId,
    type: operation.type,
    status: operation.status,
    correlationId: operation.correlationId,
    requestId: operation.requestId,
    createdAt: operation.createdAt,
  };
}
export function serverControlDetail(
  operation: ServerControlOperation,
): ServerControlOperationDetailDto {
  return {
    ...serverControlReference(operation),
    requestedByStaffId: operation.requestedByStaffId,
    dispatchedAt: operation.dispatchedAt,
    completedAt: operation.completedAt,
    errorCode: operation.errorCode,
    errorMessage: operation.errorCode
      ? SERVER_CONTROL_ERRORS[operation.errorCode]
      : null,
  };
}
