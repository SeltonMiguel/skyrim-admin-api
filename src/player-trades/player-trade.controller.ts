import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
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
import { PlayerTradeService } from './player-trade.service.js';
import {
  AcceptTradeBodyDto,
  CreateTradeBodyDto,
  TradeCharacterDto,
  TradeCharacterRouteDto,
  TradeDto,
  TradeListQueryDto,
  TradePageDto,
  TradeRouteDto,
  UpdateTradeOfferBodyDto,
} from './dto/player-trade.dto.js';

const IdempotencyHeader = () =>
  ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      '1–128 ASCII letters, digits or ._:-; scoped to the player. The same key with the same request replays it; with other content returns 409.',
  });

@ApiTags('player-trades')
@ApiBearerAuth()
@ApiBadRequestResponse({ type: HttpErrorDto })
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiNotFoundResponse({ type: HttpErrorDto })
@ApiConflictResponse({ type: HttpErrorDto })
@ApiServiceUnavailableResponse({
  type: HttpErrorDto,
  description: 'Audit unavailable; nothing changed.',
})
@UseGuards(PlayerAuthGuard)
@Controller({ path: 'player/trades', version: '1' })
export class PlayerTradeController {
  constructor(private readonly trades: PlayerTradeService) {}
  @Post()
  @HttpCode(201)
  @IdempotencyHeader()
  @ApiOperation({
    summary: 'Open a trade with a VERIFIED character of the same server.',
  })
  @ApiCreatedResponse({ type: TradeDto })
  create(
    @Body() body: CreateTradeBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.trades.create(auth.actor, key, body);
  }
  @Get(':tradeId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Read a trade your character takes part in.' })
  @ApiOkResponse({ type: TradeDto })
  get(
    @Param() route: TradeRouteDto,
    @Query() query: TradeCharacterDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.trades.get(auth.actor, route.tradeId, query.characterLinkId);
  }
  @Put(':tradeId/offer')
  @IdempotencyHeader()
  @ApiOperation({
    summary: 'Replace your side of the offer (NEGOTIATING only).',
    description: 'Increments the offer version and resets both acceptances.',
  })
  @ApiOkResponse({ type: TradeDto })
  offer(
    @Param() route: TradeRouteDto,
    @Body() body: UpdateTradeOfferBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.trades.updateOffer(auth.actor, key, route.tradeId, {
      characterLinkId: body.characterLinkId,
      gold: body.gold,
      items: body.items,
    });
  }
  @Post(':tradeId/accept')
  @HttpCode(200)
  @IdempotencyHeader()
  @ApiOperation({
    summary: "Accept the counterparty's current offer.",
    description:
      'When both sides accepted, GOLD is reserved in escrow; currency-only trades complete at once, trades with game items wait for the Agent.',
  })
  @ApiOkResponse({ type: TradeDto })
  accept(
    @Param() route: TradeRouteDto,
    @Body() body: AcceptTradeBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.trades.accept(auth.actor, key, route.tradeId, body);
  }
  @Post(':tradeId/cancel')
  @HttpCode(200)
  @IdempotencyHeader()
  @ApiOperation({
    summary: 'Cancel a NEGOTIATING trade.',
    description:
      '409 while awaiting game confirmation or once completed/failed; cancelling a cancelled trade is a no-op.',
  })
  @ApiOkResponse({ type: TradeDto })
  cancel(
    @Param() route: TradeRouteDto,
    @Body() body: TradeCharacterDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.trades.cancel(
      auth.actor,
      key,
      route.tradeId,
      body.characterLinkId,
    );
  }
}
@ApiTags('player-trades')
@ApiBearerAuth()
@ApiBadRequestResponse({ type: HttpErrorDto })
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiNotFoundResponse({
  type: HttpErrorDto,
  description: 'Character link not VERIFIED for this player.',
})
@UseGuards(PlayerAuthGuard)
@Controller({
  path: 'player/me/characters/:characterLinkId/trades',
  version: '1',
})
export class CharacterTradeController {
  constructor(private readonly trades: PlayerTradeService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Trades of your character, newest first.' })
  @ApiOkResponse({ type: TradePageDto })
  list(
    @Param() route: TradeCharacterRouteDto,
    @Query() query: TradeListQueryDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.trades.list(auth.actor, route.characterLinkId, query);
  }
}
