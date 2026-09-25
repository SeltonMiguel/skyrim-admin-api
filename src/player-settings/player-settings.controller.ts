import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Patch,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { HttpErrorDto } from '../common/filters/http-error.dto.js';
import {
  CurrentPlayer,
  PlayerAuthGuard,
} from '../player-auth/player-auth.guard.js';
import type { AuthenticatedPlayer } from '../player-auth/player-auth.types.js';
import { PlayerSettingsService } from './player-settings.service.js';
import {
  PlayerSettingsDto,
  UpdatePlayerSettingsBodyDto,
} from './dto/player-settings.dto.js';

@ApiTags('player-settings')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@UseGuards(PlayerAuthGuard)
@Controller({ path: 'player/settings', version: '1' })
export class PlayerSettingsController {
  constructor(private readonly settings: PlayerSettingsService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Your account preferences (defaults until changed).',
  })
  @ApiOkResponse({ type: PlayerSettingsDto })
  get(@CurrentPlayer() auth: AuthenticatedPlayer) {
    return this.settings.get(auth.actor);
  }
  @Patch()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Change some of your account preferences.',
    description:
      'Idempotent by value: sending the current values changes, audits and publishes nothing. Privacy flags only affect new interactions from other players.',
  })
  @ApiOkResponse({ type: PlayerSettingsDto })
  @ApiBadRequestResponse({ type: HttpErrorDto })
  @ApiServiceUnavailableResponse({
    type: HttpErrorDto,
    description: 'Audit unavailable; nothing changed.',
  })
  update(
    @Body() body: UpdatePlayerSettingsBodyDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.settings.update(auth.actor, body);
  }
}
