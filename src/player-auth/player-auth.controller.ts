import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { HttpErrorDto } from '../common/filters/http-error.dto.js';
import { DiscordIdentityProvider } from './discord-identity.provider.js';
import { PlayerAuthService } from './player-auth.service.js';
import { CurrentPlayer, PlayerAuthGuard } from './player-auth.guard.js';
import { PlayerAuthRateLimitGuard } from './player-auth-rate-limit.js';
import type { AuthenticatedPlayer } from './player-auth.types.js';
import {
  DiscordExchangeDto,
  EmptyPlayerQueryDto,
  PlayerAuthResponseDto,
  PlayerMeDto,
  PlayerRefreshDto,
} from './dto/player-auth.dto.js';

@ApiTags('player-auth')
@ApiBadRequestResponse({ type: HttpErrorDto })
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiForbiddenResponse({
  type: HttpErrorDto,
  description: 'Player account SUSPENDED or BANNED.',
})
@Controller({ path: 'player/auth', version: '1' })
export class PlayerAuthController {
  constructor(
    private readonly auth: PlayerAuthService,
    private readonly discord: DiscordIdentityProvider,
  ) {}
  @Post('discord/exchange')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(PlayerAuthRateLimitGuard)
  @ApiOperation({
    summary: 'Redeem a Discord authorization code for player tokens.',
    description:
      'Creates the player on the first valid login. OAuth state and the browser callback are validated by the Electron flow.',
  })
  @ApiOkResponse({ type: PlayerAuthResponseDto })
  @ApiTooManyRequestsResponse({ type: HttpErrorDto })
  @ApiServiceUnavailableResponse({
    type: HttpErrorDto,
    description: 'Discord not configured or unavailable.',
  })
  async discordExchange(@Body() dto: DiscordExchangeDto) {
    const identity = await this.discord.exchange({
      authorizationCode: dto.authorizationCode,
      redirectUri: dto.redirectUri,
      codeVerifier: dto.codeVerifier,
    });
    return this.auth.login(identity);
  }
  @Post('refresh')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(PlayerAuthRateLimitGuard)
  @ApiOkResponse({ type: PlayerAuthResponseDto })
  @ApiTooManyRequestsResponse({ type: HttpErrorDto })
  refresh(@Body() dto: PlayerRefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }
  @Post('logout')
  @HttpCode(204)
  @UseGuards(PlayerAuthGuard)
  @ApiBearerAuth()
  @ApiNoContentResponse({
    description: 'Current player session revoked; its tokens stop working.',
  })
  logout(@CurrentPlayer() auth: AuthenticatedPlayer) {
    return this.auth.logout(auth);
  }
}
@ApiTags('player')
@ApiBearerAuth()
@ApiBadRequestResponse({ type: HttpErrorDto })
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiForbiddenResponse({ type: HttpErrorDto })
@UseGuards(PlayerAuthGuard)
@Controller({ path: 'player', version: '1' })
export class PlayerMeController {
  constructor(private readonly auth: PlayerAuthService) {}
  // Always derived from the token; no query or body can select a player.
  @Get('me')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: PlayerMeDto })
  me(
    @Query() _query: EmptyPlayerQueryDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.auth.me(auth.player);
  }
}
