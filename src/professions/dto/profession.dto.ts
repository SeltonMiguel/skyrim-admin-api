import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsUUID } from 'class-validator';
import {
  MAX_PROFESSION_EXPERIENCE,
  MAX_PROFESSION_LEVEL,
  Profession,
} from '../profession.contracts.js';

export class ProfessionRouteDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() characterLinkId: string;
}
// Only the profession: experience, level and identity are never client input.
export class SelectProfessionDto {
  @ApiProperty({ enum: Profession }) @IsEnum(Profession) profession: Profession;
}
export class ProfessionDto {
  @ApiProperty({ format: 'uuid' }) characterLinkId: string;
  @ApiProperty({
    enum: Profession,
    nullable: true,
    description: 'null when the character has not selected a profession.',
  })
  profession: Profession | null;
  @ApiProperty({
    type: 'integer',
    minimum: 1,
    maximum: MAX_PROFESSION_LEVEL,
    required: false,
  })
  level?: number;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    maximum: MAX_PROFESSION_EXPERIENCE,
    required: false,
  })
  experience?: number;
  @ApiProperty({
    type: 'integer',
    nullable: true,
    required: false,
    description:
      'Cumulative XP for the next level, 100 * level^2; null at level 100.',
  })
  nextLevelExperience?: number | null;
}
