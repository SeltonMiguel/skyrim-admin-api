import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsString, IsUUID, ValidateIf } from 'class-validator';
import { externalId } from '../../game-bridge/command-validation.js';
import {
  moderationText,
  MAX_MODERATION_TEXT_LENGTH,
} from '../moderation-validation.js';
export class ModerationServerRouteDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() serverId: string;
}
export class ModerationPlayerRouteDto extends ModerationServerRouteDto {
  @ApiProperty({ minLength: 1, maxLength: 128 })
  @Transform(({ value }: { value: unknown }) => externalId(value))
  @IsString()
  playerId: string;
}
export class BanBodyDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: MAX_MODERATION_TEXT_LENGTH })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) =>
    value === undefined ? undefined : moderationText(value),
  )
  @IsString()
  reason?: string;
}
export class ModeBodyDto {
  @ApiProperty({ description: 'Explicit desired state; never a toggle.' })
  @IsBoolean()
  enabled: boolean;
}
export class AnnouncementBodyDto {
  @ApiProperty({
    minLength: 1,
    maxLength: MAX_MODERATION_TEXT_LENGTH,
    description: 'Trimmed plain literal text, never executed.',
  })
  @Transform(({ value }: { value: unknown }) => moderationText(value))
  @IsString()
  message: string;
}
export class TeleportBodyDto {
  @ApiProperty({ minLength: 1, maxLength: 128 })
  @Transform(({ value }: { value: unknown }) => externalId(value))
  @IsString()
  targetPlayerId: string;
}
export class EmptyModerationBodyDto {}
