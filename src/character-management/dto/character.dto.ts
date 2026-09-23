import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsString, IsUUID, Max, Min } from 'class-validator';
import {
  externalId,
  MAX_CHARACTER_QUANTITY,
  MAX_EXTERNAL_ID_LENGTH,
} from '../character-validation.js';

export class CharacterRouteDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  serverId: string;
  @ApiProperty({
    maxLength: MAX_EXTERNAL_ID_LENGTH,
    description:
      'Opaque server-scoped identifier; trimmed; control characters forbidden.',
  })
  @Transform(({ value }: { value: unknown }) => externalId(value))
  @IsString()
  characterId: string;
}
export class CharacterQueryBodyDto {}

export class ItemBodyDto {
  @ApiProperty({
    maxLength: MAX_EXTERNAL_ID_LENGTH,
    description: 'Opaque identifier, not an executable expression.',
  })
  @Transform(({ value }: { value: unknown }) => externalId(value))
  @IsString()
  itemId: string;
  @ApiProperty({ minimum: 1, maximum: MAX_CHARACTER_QUANTITY, type: 'integer' })
  @IsInt()
  @Min(1)
  @Max(MAX_CHARACTER_QUANTITY)
  quantity: number;
}

export class PropertyBodyDto {
  @ApiProperty({
    maxLength: MAX_EXTERNAL_ID_LENGTH,
    description: 'Opaque identifier, not an executable expression.',
  })
  @Transform(({ value }: { value: unknown }) => externalId(value))
  @IsString()
  propertyId: string;
}

export class HoldBodyDto {
  @ApiProperty({
    maxLength: MAX_EXTERNAL_ID_LENGTH,
    description: 'Opaque identifier, not an executable expression.',
  })
  @Transform(({ value }: { value: unknown }) => externalId(value))
  @IsString()
  holdId: string;
}

export class HorseBodyDto {
  @ApiProperty({
    maxLength: MAX_EXTERNAL_ID_LENGTH,
    description: 'Opaque identifier, not an executable expression.',
  })
  @Transform(({ value }: { value: unknown }) => externalId(value))
  @IsString()
  horseId: string;
}

export class TitleBodyDto {
  @ApiProperty({
    maxLength: MAX_EXTERNAL_ID_LENGTH,
    description: 'Opaque identifier, not an executable expression.',
  })
  @Transform(({ value }: { value: unknown }) => externalId(value))
  @IsString()
  titleId: string;
}

export class SpellBodyDto {
  @ApiProperty({
    maxLength: MAX_EXTERNAL_ID_LENGTH,
    description: 'Opaque identifier, not an executable expression.',
  })
  @Transform(({ value }: { value: unknown }) => externalId(value))
  @IsString()
  spellId: string;
}

export class FactionBodyDto {
  @ApiProperty({
    maxLength: MAX_EXTERNAL_ID_LENGTH,
    description: 'Opaque identifier, not an executable expression.',
  })
  @Transform(({ value }: { value: unknown }) => externalId(value))
  @IsString()
  factionId: string;
}
