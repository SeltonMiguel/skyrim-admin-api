import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Post,
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
import { PlayerMarketplaceService } from './player-marketplace.service.js';
import {
  CreateListingBodyDto,
  ListingBrowseQueryDto,
  ListingDto,
  ListingPageDto,
  ListingRouteDto,
  MarketCharacterDto,
  MarketCharacterRouteDto,
  MarketListQueryDto,
  OwnListingDto,
  OwnListingPageDto,
  PurchaseDto,
  PurchasePageDto,
} from './dto/player-marketplace.dto.js';

const IdempotencyHeader = () =>
  ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      '1–128 ASCII letters, digits or ._:-; scoped to the player. The same key with the same request replays it; with other content returns 409.',
  });

@ApiTags('player-marketplace')
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
@Controller({ path: 'player/marketplace/listings', version: '1' })
export class PlayerMarketplaceController {
  constructor(private readonly market: PlayerMarketplaceService) {}
  @Post()
  @HttpCode(201)
  @IdempotencyHeader()
  @ApiOperation({
    summary: 'List one game item of your VERIFIED character for GOLD.',
    description:
      'The listing starts PENDING_CUSTODY and becomes purchasable only after the Agent confirms it holds the item. Nothing is debited.',
  })
  @ApiCreatedResponse({ type: OwnListingDto })
  create(
    @Body() body: CreateListingBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.market.create(auth.actor, key, body);
  }
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'ACTIVE listings, newest first.' })
  @ApiOkResponse({ type: ListingPageDto })
  browse(@Query() query: ListingBrowseQueryDto) {
    return this.market.browse(query);
  }
  @Get(':listingId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Read an ACTIVE listing.' })
  @ApiOkResponse({ type: ListingDto })
  get(@Param() route: ListingRouteDto) {
    return this.market.get(route.listingId);
  }
  @Post(':listingId/purchase')
  @HttpCode(201)
  @IdempotencyHeader()
  @ApiOperation({
    summary: 'Buy an ACTIVE listing with your VERIFIED character.',
    description:
      'Reserves the price in escrow and the listing; the purchase then awaits the Agent.',
  })
  @ApiCreatedResponse({ type: PurchaseDto })
  purchase(
    @Param() route: ListingRouteDto,
    @Body() body: MarketCharacterDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.market.purchase(
      auth.actor,
      key,
      route.listingId,
      body.characterLinkId,
    );
  }
  @Post(':listingId/cancel')
  @HttpCode(200)
  @IdempotencyHeader()
  @ApiOperation({
    summary: 'Cancel your PENDING_CUSTODY or ACTIVE listing.',
    description:
      '409 while RESERVED or once SOLD/FAILED; cancelling a cancelled listing is a no-op.',
  })
  @ApiOkResponse({ type: OwnListingDto })
  cancel(
    @Param() route: ListingRouteDto,
    @Body() body: MarketCharacterDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.market.cancel(
      auth.actor,
      key,
      route.listingId,
      body.characterLinkId,
    );
  }
}
@ApiTags('player-marketplace')
@ApiBearerAuth()
@ApiBadRequestResponse({ type: HttpErrorDto })
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiNotFoundResponse({
  type: HttpErrorDto,
  description: 'Character link not VERIFIED for this player.',
})
@UseGuards(PlayerAuthGuard)
@Controller({
  path: 'player/me/characters/:characterLinkId/marketplace',
  version: '1',
})
export class CharacterMarketplaceController {
  constructor(private readonly market: PlayerMarketplaceService) {}
  @Get('listings')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Listings of your character in every status, newest first.',
  })
  @ApiOkResponse({ type: OwnListingPageDto })
  listings(
    @Param() route: MarketCharacterRouteDto,
    @Query() query: MarketListQueryDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.market.ownListings(auth.actor, route.characterLinkId, query);
  }
  @Get('purchases')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Purchases of your character, newest first.' })
  @ApiOkResponse({ type: PurchasePageDto })
  purchases(
    @Param() route: MarketCharacterRouteDto,
    @Query() query: MarketListQueryDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.market.ownPurchases(auth.actor, route.characterLinkId, query);
  }
}
