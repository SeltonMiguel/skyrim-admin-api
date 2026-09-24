import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length, Matches } from 'class-validator';
import {
  IdentityProvider,
  PlayerStatus,
} from '../../player-accounts/player-account.contracts.js';

// Authorization code obtained by the Electron flow (Etapa 11). The backend
// redeems it with its own client secret; the client never sees the secret.
export class DiscordExchangeDto {
  @ApiProperty({ writeOnly: true, minLength: 1, maxLength: 2048 })
  @IsString()
  @Length(1, 2048)
  @Matches(/^[\x21-\x7e]+$/)
  authorizationCode: string;
  @ApiProperty({
    maxLength: 2048,
    description: 'Must exactly match a configured DISCORD_REDIRECT_URIS entry.',
  })
  @IsString()
  @Length(1, 2048)
  redirectUri: string;
  @ApiPropertyOptional({
    writeOnly: true,
    minLength: 43,
    maxLength: 128,
    description: 'RFC 7636 PKCE verifier, forwarded to the token endpoint.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9\-._~]{43,128}$/)
  codeVerifier?: string;
}
export class PlayerRefreshDto {
  @ApiProperty({ writeOnly: true })
  @IsString()
  @Length(1, 4096)
  refreshToken: string;
}
export class EmptyPlayerQueryDto {}
export class PlayerIdentitySummaryDto {
  @ApiProperty({ enum: IdentityProvider }) provider: IdentityProvider;
  @ApiProperty({ format: 'date-time' }) linkedAt: Date;
}
export class PlayerMeDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() displayName: string;
  @ApiProperty({ enum: PlayerStatus }) status: PlayerStatus;
  @ApiProperty({ type: PlayerIdentitySummaryDto, isArray: true })
  identities: PlayerIdentitySummaryDto[];
}
export class PlayerAuthResponseDto {
  @ApiProperty() accessToken: string;
  @ApiProperty() refreshToken: string;
  @ApiProperty({ example: 900 }) expiresIn: number;
  @ApiProperty({ format: 'date-time' }) refreshExpiresAt: Date;
  @ApiProperty({ type: PlayerMeDto }) player: PlayerMeDto;
}
