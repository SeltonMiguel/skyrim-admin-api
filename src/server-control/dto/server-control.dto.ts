import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
import {
  SERVER_CONTROL_ERRORS,
  SERVER_CONTROL_TYPES,
  ServerControlStatus,
} from '../server-control.contracts.js';
import type {
  ServerControlErrorCode,
  ServerControlType,
} from '../server-control.contracts.js';

export class ServerControlRouteDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() serverId: string;
}
// No fields: the route fixes the operation; any property is rejected.
export class EmptyServerControlBodyDto {}
export class ServerControlOperationReferenceDto {
  @ApiProperty({ format: 'uuid' }) operationId: string;
  @ApiProperty({ format: 'uuid' }) gameServerId: string;
  @ApiProperty({ enum: SERVER_CONTROL_TYPES }) type: ServerControlType;
  @ApiProperty({
    enum: ServerControlStatus,
    description:
      'PENDING persisted, not yet sent (or sent and not reconciled after a crash); DISPATCHED sent once to the Host Agent (or delivery could not be refuted), never resent; SUCCEEDED the Agent reported the effect; FAILED definitely no effect (never delivered, or a definite Agent failure); UNCERTAIN terminal, the backend cannot say whether the action ran (no result before the deadline, or the Agent could not prove it) and it is never retried automatically.',
  })
  status: ServerControlStatus;
  @ApiProperty({ format: 'uuid' }) correlationId: string;
  @ApiProperty({ type: String, nullable: true }) requestId: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt: Date;
}
export class ServerControlOperationDetailDto extends ServerControlOperationReferenceDto {
  @ApiProperty({ format: 'uuid' }) requestedByStaffId: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  dispatchedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  completedAt: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    enum: Object.keys(SERVER_CONTROL_ERRORS),
    description:
      'Set for FAILED (AGENT_UNAVAILABLE, AGENT_REJECTED, SERVER_DISABLED, DISPATCH_EXPIRED, DELIVERY_EXPIRED, INVALID_PROCESS_STATE, EXECUTION_FAILED) and UNCERTAIN (RESULT_TIMEOUT, OUTCOME_UNKNOWN).',
  })
  errorCode: ServerControlErrorCode | null;
  @ApiProperty({ type: String, nullable: true }) errorMessage: string | null;
}
