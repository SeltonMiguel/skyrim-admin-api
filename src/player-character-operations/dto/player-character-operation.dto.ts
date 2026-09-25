import { ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, IsUUID } from 'class-validator';
import { externalId } from '../../game-bridge/command-validation.js';
import { CommandStatus } from '../../game-bridge/command-state.js';
import type { TerminalStatus } from '../../game-bridge/command-state.js';
import {
  CharacterHoldsResultDto,
  CharacterHorsesResultDto,
  CharacterPropertiesResultDto,
} from '../../character-management/dto/operation.dto.js';
import type {
  HoldsResult,
  HorsesResult,
  PropertiesResult,
} from '../../character-management/character-command.contracts.js';
import { PLAYER_CHARACTER_QUERY_TYPES } from '../player-character-query.contracts.js';
import type { PlayerCharacterQueryType } from '../player-character-query.contracts.js';
import {
  CHARACTER_SEXES,
  MAX_ATTRIBUTE_VALUE,
  MAX_CHARACTER_LEVEL,
  MAX_SKILL_LEVEL,
  MIN_SKILL_LEVEL,
  SKILL_NAMES,
} from '../character-profile.contracts.js';
import type {
  CharacterProfileResult,
  CharacterSex,
} from '../character-profile.contracts.js';

export class PlayerCharacterRouteDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() gameServerId: string;
  @ApiProperty({
    minLength: 1,
    maxLength: 128,
    description: 'Opaque character id; must be VERIFIED for the player.',
  })
  @Transform(({ value }: { value: unknown }) => externalId(value))
  @IsString()
  characterId: string;
}
export class PlayerOperationRouteDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() operationId: string;
}
export class EmptyPlayerQueryBodyDto {}
export class CharacterProfileDto {
  @ApiProperty() characterId: string;
  @ApiProperty({ minLength: 1, maxLength: 128 }) name: string;
  @ApiProperty({ type: 'integer', minimum: 1, maximum: MAX_CHARACTER_LEVEL })
  level: number;
  @ApiProperty({ minLength: 1, maxLength: 128, description: 'Opaque race id.' })
  race: string;
  @ApiProperty({ enum: CHARACTER_SEXES }) sex: CharacterSex;
  @ApiProperty({ minimum: 0, maximum: MAX_ATTRIBUTE_VALUE }) health: number;
  @ApiProperty({ minimum: 0, maximum: MAX_ATTRIBUTE_VALUE }) magicka: number;
  @ApiProperty({ minimum: 0, maximum: MAX_ATTRIBUTE_VALUE }) stamina: number;
}
const skillSchema = {
  type: 'integer',
  minimum: MIN_SKILL_LEVEL,
  maximum: MAX_SKILL_LEVEL,
} as const;
export class CharacterSkillsDto {
  @ApiProperty() characterId: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: false,
    required: [...SKILL_NAMES],
    properties: Object.fromEntries(
      SKILL_NAMES.map((name) => [name, skillSchema]),
    ),
    description: 'Base skill levels 0–100, without temporary modifiers.',
  })
  skills: Record<string, number>;
}
export class PlayerCharacterOperationReferenceDto {
  @ApiProperty({ format: 'uuid' }) operationId: string;
  @ApiProperty({ enum: PLAYER_CHARACTER_QUERY_TYPES })
  type: PlayerCharacterQueryType;
  @ApiProperty({ format: 'uuid' }) gameServerId: string;
  @ApiProperty() characterId: string;
  @ApiProperty({
    enum: CommandStatus,
    description: 'Accepted/persisted is not Skyrim execution success.',
  })
  status: CommandStatus;
  @ApiProperty({ format: 'date-time' }) createdAt: Date;
}
// Properties (houses), holds and horses (mounts) reuse the Etapa 05 result
// shapes unchanged.
@ApiExtraModels(
  CharacterProfileDto,
  CharacterSkillsDto,
  CharacterPropertiesResultDto,
  CharacterHoldsResultDto,
  CharacterHorsesResultDto,
)
export class PlayerCharacterOperationResultDto {
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
    oneOf: [
      { $ref: getSchemaPath(CharacterProfileDto) },
      { $ref: getSchemaPath(CharacterSkillsDto) },
      { $ref: getSchemaPath(CharacterPropertiesResultDto) },
      { $ref: getSchemaPath(CharacterHoldsResultDto) },
      { $ref: getSchemaPath(CharacterHorsesResultDto) },
    ],
    description: 'Validated Skyrim result; null for FAILED/TIMEOUT.',
  })
  data:
    | CharacterProfileResult
    | PropertiesResult
    | HoldsResult
    | HorsesResult
    | null;
  @ApiProperty({ type: String, nullable: true }) errorCode: string | null;
  @ApiProperty({ format: 'date-time' }) receivedAt: Date;
}
export class PlayerCharacterOperationDto extends PlayerCharacterOperationReferenceDto {
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  completedAt: Date | null;
  @ApiProperty({ type: PlayerCharacterOperationResultDto, nullable: true })
  result: PlayerCharacterOperationResultDto | null;
}
