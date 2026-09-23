import {
  ApiExtraModels,
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from '@nestjs/swagger';
import { CommandStatus } from '../../game-bridge/command-state.js';
import type { TerminalStatus } from '../../game-bridge/command-state.js';
import { CHARACTER_COMMAND_TYPES } from '../character-command.contracts.js';
import type {
  CharacterCommandType,
  CharacterPayload,
  CharacterResult,
} from '../character-command.contracts.js';

export class CharacterQueryPayloadDto {
  @ApiProperty({ maxLength: 128 }) characterId: string;
}
export class CharacterItemPayloadDto extends CharacterQueryPayloadDto {
  @ApiProperty({ maxLength: 128 }) itemId: string;
  @ApiProperty({ type: 'integer', minimum: 1, maximum: 10000 })
  quantity: number;
}
export class CharacterPropertyPayloadDto extends CharacterQueryPayloadDto {
  @ApiProperty({ maxLength: 128 }) propertyId: string;
}
export class CharacterHoldPayloadDto extends CharacterQueryPayloadDto {
  @ApiProperty({ maxLength: 128 }) holdId: string;
}
export class CharacterHorsePayloadDto extends CharacterQueryPayloadDto {
  @ApiProperty({ maxLength: 128 }) horseId: string;
}
export class CharacterTitlePayloadDto extends CharacterQueryPayloadDto {
  @ApiProperty({ maxLength: 128 }) titleId: string;
}
export class CharacterSpellPayloadDto extends CharacterQueryPayloadDto {
  @ApiProperty({ maxLength: 128 }) spellId: string;
}
export class CharacterFactionPayloadDto extends CharacterQueryPayloadDto {
  @ApiProperty({ maxLength: 128 }) factionId: string;
}
export class CharacterItemEntryDto {
  @ApiProperty({ maxLength: 128 }) itemId: string;
  @ApiPropertyOptional({ maxLength: 128 }) displayName?: string;
  @ApiProperty({ type: 'integer', minimum: 1, maximum: 10000 })
  quantity: number;
}
export class CharacterInventoryResultDto extends CharacterQueryPayloadDto {
  @ApiProperty({ type: CharacterItemEntryDto, isArray: true, maxItems: 512 })
  items: CharacterItemEntryDto[];
}
export class CharacterPropertyEntryDto {
  @ApiProperty({ maxLength: 128 }) propertyId: string;
  @ApiPropertyOptional({ maxLength: 128 }) displayName?: string;
}
export class CharacterPropertiesResultDto extends CharacterQueryPayloadDto {
  @ApiProperty({
    type: CharacterPropertyEntryDto,
    isArray: true,
    maxItems: 512,
  })
  properties: CharacterPropertyEntryDto[];
}
export class CharacterHoldEntryDto {
  @ApiProperty({ maxLength: 128 }) holdId: string;
  @ApiPropertyOptional({ maxLength: 128 }) displayName?: string;
}
export class CharacterHoldsResultDto extends CharacterQueryPayloadDto {
  @ApiProperty({ type: CharacterHoldEntryDto, isArray: true, maxItems: 512 })
  holds: CharacterHoldEntryDto[];
}
export class CharacterHorseEntryDto {
  @ApiProperty({ maxLength: 128 }) horseId: string;
  @ApiPropertyOptional({ maxLength: 128 }) displayName?: string;
}
export class CharacterHorsesResultDto extends CharacterQueryPayloadDto {
  @ApiProperty({ type: CharacterHorseEntryDto, isArray: true, maxItems: 512 })
  horses: CharacterHorseEntryDto[];
}
export class CharacterFactionEntryDto {
  @ApiProperty({ maxLength: 128 }) factionId: string;
  @ApiPropertyOptional({ maxLength: 128 }) displayName?: string;
}
export class CharacterFactionsResultDto extends CharacterQueryPayloadDto {
  @ApiProperty({ type: CharacterFactionEntryDto, isArray: true, maxItems: 512 })
  factions: CharacterFactionEntryDto[];
}
export class CharacterMutationResultDto extends CharacterQueryPayloadDto {
  @ApiProperty({ enum: [true] }) applied: true;
  @ApiProperty({ maxLength: 128 }) targetId: string;
}
const payloadSchemas = [
  CharacterQueryPayloadDto,
  CharacterItemPayloadDto,
  CharacterPropertyPayloadDto,
  CharacterHoldPayloadDto,
  CharacterHorsePayloadDto,
  CharacterTitlePayloadDto,
  CharacterSpellPayloadDto,
  CharacterFactionPayloadDto,
];
const resultSchemas = [
  CharacterInventoryResultDto,
  CharacterPropertiesResultDto,
  CharacterHoldsResultDto,
  CharacterHorsesResultDto,
  CharacterFactionsResultDto,
  CharacterMutationResultDto,
];
export class CharacterOperationReferenceDto {
  @ApiProperty({ format: 'uuid' }) commandId: string;
  @ApiProperty({ format: 'uuid' }) gameServerId: string;
  @ApiProperty() characterId: string;
  @ApiProperty({ enum: CHARACTER_COMMAND_TYPES }) type: CharacterCommandType;
  @ApiProperty({ enum: CommandStatus }) status: CommandStatus;
  @ApiProperty({ format: 'uuid' }) correlationId: string;
  @ApiProperty({ type: String, nullable: true }) requestId: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt: Date;
}
@ApiExtraModels(...resultSchemas)
export class CharacterOperationResultDto {
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
      'Validated result for the operation type; null for FAILED/TIMEOUT.',
  })
  result: CharacterResult | null;
  @ApiProperty({ type: String, nullable: true }) errorCode: string | null;
  @ApiProperty({ type: String, nullable: true }) errorMessage: string | null;
  @ApiProperty({ format: 'date-time' }) receivedAt: Date;
}
@ApiExtraModels(...payloadSchemas)
export class CharacterOperationDetailDto extends CharacterOperationReferenceDto {
  @ApiProperty({
    oneOf: payloadSchemas.map((type) => ({ $ref: getSchemaPath(type) })),
    description: 'Closed payload schema selected by command type.',
  })
  payload: CharacterPayload;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  requestedByStaffId: string | null;
  @ApiProperty() dispatchAttempts: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastDispatchAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  ackDeadlineAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  executionDeadlineAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  acknowledgedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  completedAt: Date | null;
  @ApiProperty({ type: CharacterOperationResultDto, nullable: true })
  result: CharacterOperationResultDto | null;
}
