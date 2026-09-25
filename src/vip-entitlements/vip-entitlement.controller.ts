import { Controller, Get, Header, Param, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { HttpErrorDto } from '../common/filters/http-error.dto.js';
import {
  CurrentPlayer,
  PlayerAuthGuard,
} from '../player-auth/player-auth.guard.js';
import type { AuthenticatedPlayer } from '../player-auth/player-auth.types.js';
import { VipEntitlementService } from './vip-entitlement.service.js';
import {
  VipCharacterRouteDto,
  VipEffectiveDto,
  VipEntitlementListDto,
} from './dto/vip-entitlement.dto.js';

// Read-only: players never grant, revoke, buy or pay here.
@ApiTags('player-vip')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@UseGuards(PlayerAuthGuard)
@Controller({ path: 'player/vip', version: '1' })
export class PlayerVipController {
  constructor(private readonly entitlements: VipEntitlementService) {}
  @Get('entitlements')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Effective account (PLAYER) VIP entitlements.' })
  @ApiOkResponse({ type: VipEntitlementListDto })
  list(@CurrentPlayer() auth: AuthenticatedPlayer) {
    return this.entitlements.forPlayer(auth.actor);
  }
}
@ApiTags('player-vip')
@ApiBearerAuth()
@ApiBadRequestResponse({ type: HttpErrorDto })
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiNotFoundResponse({
  type: HttpErrorDto,
  description: 'Character link not VERIFIED for this player.',
})
@UseGuards(PlayerAuthGuard)
@Controller({
  path: 'player/me/characters/:characterLinkId/vip',
  version: '1',
})
export class CharacterVipController {
  constructor(private readonly entitlements: VipEntitlementService) {}
  @Get('entitlements')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Effective CHARACTER VIP entitlements of your character.',
  })
  @ApiOkResponse({ type: VipEntitlementListDto })
  list(
    @Param() route: VipCharacterRouteDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.entitlements.forCharacter(auth.actor, route.characterLinkId);
  }
  @Get('effective')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Account and character entitlements side by side, scope kept per entry.',
  })
  @ApiOkResponse({ type: VipEffectiveDto })
  effective(
    @Param() route: VipCharacterRouteDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.entitlements.effective(auth.actor, route.characterLinkId);
  }
}
