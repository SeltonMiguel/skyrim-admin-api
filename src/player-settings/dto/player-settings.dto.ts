import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsString, ValidateIf } from 'class-validator';
import {
  MAX_LOCALE_LENGTH,
  MAX_TIME_ZONE_LENGTH,
  settingsLocale,
  settingsTimeZone,
} from '../player-settings.contracts.js';

const present = (_: object, value: unknown) => value !== undefined;
const normalized =
  (normalize: (value: unknown) => string) =>
  ({ value }: { value: unknown }) =>
    value === undefined ? value : normalize(value);

// Partial: only the fields sent change. The player comes from the token.
export class UpdatePlayerSettingsBodyDto {
  @ApiPropertyOptional({
    maxLength: MAX_LOCALE_LENGTH,
    example: 'pt-BR',
    description:
      'BCP 47 language tag supported by the server runtime; stored canonicalized (en-us -> en-US).',
  })
  @ValidateIf(present)
  @Transform(normalized(settingsLocale))
  @IsString()
  locale?: string;
  @ApiPropertyOptional({
    maxLength: MAX_TIME_ZONE_LENGTH,
    example: 'America/Sao_Paulo',
    description:
      'IANA time zone known to the server runtime; stored as resolved (utc -> UTC). Offsets are refused.',
  })
  @ValidateIf(present)
  @Transform(normalized(settingsTimeZone))
  @IsString()
  timeZone?: string;
  @ApiPropertyOptional({
    description: 'Other players may send you new DIRECT messages.',
  })
  @ValidateIf(present)
  @IsBoolean()
  allowDirectMessages?: boolean;
  @ApiPropertyOptional({
    description: 'Other players may open new trades with your characters.',
  })
  @ValidateIf(present)
  @IsBoolean()
  allowTradeRequests?: boolean;
  @ApiPropertyOptional({
    description: 'Your characters may receive new group invites.',
  })
  @ValidateIf(present)
  @IsBoolean()
  allowGroupInvites?: boolean;
  @ApiPropertyOptional({
    description: 'Your characters may receive new guild invites.',
  })
  @ValidateIf(present)
  @IsBoolean()
  allowGuildInvites?: boolean;
}
export class PlayerSettingsDto {
  @ApiProperty() locale: string;
  @ApiProperty() timeZone: string;
  @ApiProperty() allowDirectMessages: boolean;
  @ApiProperty() allowTradeRequests: boolean;
  @ApiProperty() allowGroupInvites: boolean;
  @ApiProperty() allowGuildInvites: boolean;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'null while the defaults were never changed.',
  })
  updatedAt: Date | null;
}
