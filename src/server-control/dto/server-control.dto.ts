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
      'PENDING persisted; DISPATCHED handed to (or possibly delivered by) the transport; FAILED definitely not delivered. Never proof the server started, paused or restarted.',
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
  })
  errorCode: ServerControlErrorCode | null;
  @ApiProperty({ type: String, nullable: true }) errorMessage: string | null;
}
