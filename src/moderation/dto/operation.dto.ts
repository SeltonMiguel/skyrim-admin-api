import {
  ApiExtraModels,
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from '@nestjs/swagger';
import { CommandStatus } from '../../game-bridge/command-state.js';
import type { TerminalStatus } from '../../game-bridge/command-state.js';
import { MODERATION_COMMAND_TYPES } from '../moderation-command.contracts.js';
import type {
  ModerationCommandType,
  ModerationPayload,
  ModerationResult,
} from '../moderation-command.contracts.js';
export class ModerationBanPayloadDto {
  @ApiProperty({ minLength: 1, maxLength: 128 }) playerId: string;
  @ApiPropertyOptional({ minLength: 1, maxLength: 500 }) reason?: string;
}
export class ModerationPlayerModePayloadDto {
  @ApiProperty({ minLength: 1, maxLength: 128 }) playerId: string;
  @ApiProperty() enabled: boolean;
}
export class ModerationStaffModePayloadDto {
  @ApiProperty({ format: 'uuid' }) actorStaffId: string;
  @ApiProperty() enabled: boolean;
}
export class ModerationTeleportPayloadDto {
  @ApiProperty({ format: 'uuid' }) actorStaffId: string;
  @ApiProperty({ minLength: 1, maxLength: 128 }) targetPlayerId: string;
}
export class ModerationAnnouncementPayloadDto {
  @ApiProperty({ minLength: 1, maxLength: 500 }) message: string;
}
export class ModerationBanResultDto {
  @ApiProperty({ minLength: 1, maxLength: 128 }) playerId: string;
  @ApiProperty({ enum: [true] }) banned: true;
}
export class ModerationUnbanResultDto {
  @ApiProperty({ minLength: 1, maxLength: 128 }) playerId: string;
  @ApiProperty({ enum: [false] }) banned: false;
}
export class ModerationAnnouncementResultDto {
  @ApiProperty({ enum: [true] }) sent: true;
}
export class ModerationTeleportResultDto {
  @ApiProperty({ format: 'uuid' }) actorStaffId: string;
  @ApiProperty({ minLength: 1, maxLength: 128 }) targetPlayerId: string;
  @ApiProperty({ enum: [true] }) teleported: true;
}
const payloadSchemas = [
  ModerationBanPayloadDto,
  ModerationPlayerModePayloadDto,
  ModerationStaffModePayloadDto,
  ModerationTeleportPayloadDto,
  ModerationAnnouncementPayloadDto,
];
const resultSchemas = [
  ModerationBanResultDto,
  ModerationUnbanResultDto,
  ModerationPlayerModePayloadDto,
  ModerationStaffModePayloadDto,
  ModerationAnnouncementResultDto,
  ModerationTeleportResultDto,
];
export class ModerationOperationReferenceDto {
  @ApiProperty({ format: 'uuid' }) commandId: string;
  @ApiProperty({ format: 'uuid' }) gameServerId: string;
  @ApiProperty({ enum: MODERATION_COMMAND_TYPES }) type: ModerationCommandType;
  @ApiProperty({ enum: CommandStatus }) status: CommandStatus;
  @ApiProperty({ format: 'uuid' }) correlationId: string;
  @ApiProperty({ type: String, nullable: true }) requestId: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt: Date;
}
@ApiExtraModels(...resultSchemas)
export class ModerationOperationResultDto {
  @ApiProperty({
    enum: [
      CommandStatus.SUCCEEDED,
      CommandStatus.FAILED,
      CommandStatus.TIMEOUT,
    ],
  })
  outcome: TerminalStatus;
  @ApiProperty({
    nullable: true,
    oneOf: resultSchemas.map((type) => ({ $ref: getSchemaPath(type) })),
    description:
      'Closed result selected by operation type; null for FAILED/TIMEOUT.',
  })
  result: ModerationResult | null;
  @ApiProperty({ type: String, nullable: true }) errorCode: string | null;
  @ApiProperty({ type: String, nullable: true }) errorMessage: string | null;
  @ApiProperty({ format: 'date-time' }) receivedAt: Date;
}
@ApiExtraModels(...payloadSchemas)
export class ModerationOperationDetailDto extends ModerationOperationReferenceDto {
  @ApiProperty({
    oneOf: payloadSchemas.map((type) => ({ $ref: getSchemaPath(type) })),
  })
  payload: ModerationPayload;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  requestedByStaffId: string | null;
  @ApiProperty() dispatchAttempts: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastDispatchAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  acknowledgedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  completedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  ackDeadlineAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  executionDeadlineAt: Date | null;
  @ApiProperty({ type: ModerationOperationResultDto, nullable: true })
  result: ModerationOperationResultDto | null;
}
