import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
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
import { EmptyQueryDto } from '../admin-queries/dto/query.dto.js';
import {
  CurrentPlayer,
  PlayerAuthGuard,
} from '../player-auth/player-auth.guard.js';
import type { AuthenticatedPlayer } from '../player-auth/player-auth.types.js';
import { WalletService } from './wallet.service.js';
import {
  WalletDto,
  WalletRouteDto,
  WalletTransactionPageDto,
  WalletTransactionsQueryDto,
} from './dto/wallet.dto.js';

// Read-only in 10.12: no route credits, debits or transfers money.
@ApiTags('player-wallet')
@ApiBearerAuth()
@ApiBadRequestResponse({ type: HttpErrorDto })
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiNotFoundResponse({
  type: HttpErrorDto,
  description: 'Character link not VERIFIED for this player.',
})
@UseGuards(PlayerAuthGuard)
@Controller({
  path: 'player/me/characters/:characterLinkId/wallet',
  version: '1',
})
export class WalletController {
  constructor(private readonly wallets: WalletService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'GOLD balance of your character.' })
  @ApiOkResponse({ type: WalletDto })
  get(
    @Param() route: WalletRouteDto,
    @Query() _query: EmptyQueryDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.wallets.wallet(auth.actor, route.characterLinkId);
  }
  @Get('transactions')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: "Your character's GOLD movements, newest first.",
  })
  @ApiOkResponse({ type: WalletTransactionPageDto })
  transactions(
    @Param() route: WalletRouteDto,
    @Query() query: WalletTransactionsQueryDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.wallets.transactions(auth.actor, route.characterLinkId, query);
  }
}
