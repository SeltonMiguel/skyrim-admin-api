import { ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';
import { CommandStatus } from '../../game-bridge/command-state.js';
import type { TerminalStatus } from '../../game-bridge/command-state.js';
import { WORLD_COMMAND_TYPES } from '../world-command.contracts.js';
import type {
  WorldCommandType,
  WorldPayload,
  WorldResult,
} from '../world-command.contracts.js';
import {
  WorldTimeBodyDto,
  WorldWeatherBodyDto,
  WorldSpawnBodyDto,
} from './world.dto.js';
import { MAX_SPAWN_QUANTITY } from '../world-command.contracts.js';
export class WorldSpawnPayloadDto extends WorldSpawnBodyDto {
  @ApiProperty({ format: 'uuid' }) actorStaffId: string;
}
export class WorldStateResultDto {
  @ApiProperty({ minimum: 0, maximum: 24, exclusiveMaximum: true })
  gameHour: number;
  @ApiProperty({ type: String, nullable: true, minLength: 1, maxLength: 128 })
  weatherId: string | null;
}
export class WorldSpawnResultDto {
  @ApiProperty({ format: 'uuid' }) actorStaffId: string;
  @ApiProperty({ minLength: 1, maxLength: 128 }) baseFormId: string;
  @ApiProperty({ type: 'integer', minimum: 1, maximum: MAX_SPAWN_QUANTITY })
  requestedQuantity: number;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    maximum: MAX_SPAWN_QUANTITY,
    description:
      'Cannot exceed requestedQuantity. Partial/zero spawn is reported explicitly.',
  })
  spawnedQuantity: number;
}
const payloadSchemas = [
  WorldTimeBodyDto,
  WorldWeatherBodyDto,
  WorldSpawnPayloadDto,
];
const resultSchemas = [
  WorldStateResultDto,
  WorldTimeBodyDto,
  WorldWeatherBodyDto,
  WorldSpawnResultDto,
];
export class WorldOperationReferenceDto {
  @ApiProperty({ format: 'uuid' }) commandId: string;
  @ApiProperty({ format: 'uuid' }) gameServerId: string;
  @ApiProperty({ enum: WORLD_COMMAND_TYPES }) type: WorldCommandType;
  @ApiProperty({ enum: CommandStatus }) status: CommandStatus;
  @ApiProperty({ format: 'uuid' }) correlationId: string;
  @ApiProperty({ type: String, nullable: true }) requestId: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt: Date;
}
@ApiExtraModels(...resultSchemas)
export class WorldOperationResultDto {
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
    anyOf: resultSchemas.map((type) => ({ $ref: getSchemaPath(type) })),
    description:
      'Closed result selected by operation type; null for FAILED/TIMEOUT.',
  })
  result: WorldResult | null;
  @ApiProperty({ type: String, nullable: true }) errorCode: string | null;
  @ApiProperty({ type: String, nullable: true }) errorMessage: string | null;
  @ApiProperty({ format: 'date-time' }) receivedAt: Date;
}
@ApiExtraModels(...payloadSchemas)
export class WorldOperationDetailDto extends WorldOperationReferenceDto {
  @ApiProperty({
    anyOf: [
      { type: 'object', additionalProperties: false, maxProperties: 0 },
      ...payloadSchemas.map((type) => ({ $ref: getSchemaPath(type) })),
    ],
  })
  payload: WorldPayload;
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
  @ApiProperty({ type: WorldOperationResultDto, nullable: true })
  result: WorldOperationResultDto | null;
}
