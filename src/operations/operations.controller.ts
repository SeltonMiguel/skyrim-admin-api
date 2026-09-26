import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentStaff } from '../auth/decorators/current-staff.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import type { AuthenticatedStaff } from '../auth/auth.types.js';
import { HttpErrorDto } from '../common/filters/http-error.dto.js';
import { PermissionGuard } from '../rbac/permission.guard.js';
import { Permission as P } from '../rbac/permissions.js';
import { RequirePermissions } from '../rbac/require-permissions.decorator.js';
import {
  ChatQueryDto,
  PlayerStatusDto,
  ReasonDto,
  ReceiptQueryDto,
  ReleaseQueueQueryDto,
  ResolveDeliveryDto,
  ResolveReleaseDto,
  ResolveServerControlDto,
  ServerControlQueueQueryDto,
  VipQueueQueryDto,
  WalletAdjustmentDto,
  WalletRouteDto,
  WorkQueueQueryDto,
} from './dto/operations.dto.js';
import { OperationsQueryService } from './operations-query.service.js';
import { PlayerModerationService } from './player-moderation.service.js';
import { RecoveryService } from './recovery.service.js';

const uuid = new ParseUUIDPipe();
const KEY = 'idempotency-key';

// Staff operational recovery (12.4). Staff JWT only (a Player or Agent
// token is 401), one narrow permission per domain (fail-closed guard),
// strict DTOs. Every POST requires an Idempotency-Key and a reason, is
// rate limited per Staff user and returns the operator action result
// (a replay returns the same result with replayed=true).
@ApiTags('operations')
@ApiBearerAuth()
@ApiBadRequestResponse({ type: HttpErrorDto })
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiForbiddenResponse({ type: HttpErrorDto })
@ApiNotFoundResponse({ type: HttpErrorDto })
@ApiConflictResponse({
  type: HttpErrorDto,
  description:
    'The item is not in a state this action accepts (already resolved, not waiting, not provably safe), or the Idempotency-Key was used for another request.',
})
@ApiTooManyRequestsResponse({ type: HttpErrorDto })
@ApiServiceUnavailableResponse({
  type: HttpErrorDto,
  description: 'Audit unavailable; the action rolled back.',
})
@ApiHeader({
  name: 'Idempotency-Key',
  required: false,
  description:
    'Required on every POST: 1–128 ASCII letters, digits or ._:-, per Staff user.',
})
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller({ path: 'operations', version: '1' })
export class OperationsController {
  constructor(
    private readonly queries: OperationsQueryService,
    private readonly recovery: RecoveryService,
    private readonly moderation: PlayerModerationService,
  ) {}

  @Get('summary')
  @RequirePermissions(P.OPERATIONS_READ)
  @ApiOperation({
    summary: 'Counts, stale counts and oldest age of every operator queue.',
  })
  summary() {
    return this.queries.summary();
  }
  @Get('domain-event-receipts')
  @RequirePermissions(P.OPERATIONS_READ)
  @ApiOperation({
    summary:
      'Final DOMAIN_EVENT rejections (kind, reason, eventId); never the payload.',
  })
  receipts(@Query() query: ReceiptQueryDto) {
    return this.queries.receipts(query);
  }

  // Server Control.
  @Get('server-control/uncertain')
  @RequirePermissions(P.SERVER_CONTROL_RESOLVE)
  @ApiOperation({
    summary:
      'UNCERTAIN Server Control operations (oldest first), of the types the caller may read.',
  })
  serverControl(
    @Query() query: ServerControlQueueQueryDto,
    @CurrentStaff() auth: AuthenticatedStaff,
  ) {
    return this.queries.serverControl(auth, query);
  }
  @Post('server-control/:operationId/resolve')
  @HttpCode(200)
  @RequirePermissions(P.SERVER_CONTROL_RESOLVE)
  @ApiOperation({
    summary:
      'Record what the operator verified for an UNCERTAIN operation. Never retries; status and errorCode stay.',
    description:
      'Requires SERVER_CONTROL_RESOLVE and the permission of the operation type.',
  })
  resolveServerControl(
    @Param('operationId', uuid) operationId: string,
    @Body() body: ResolveServerControlDto,
    @Headers(KEY) key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
  ) {
    return this.recovery.resolveServerControl(
      auth,
      key,
      operationId,
      body.resolution,
      body.reason,
    );
  }

  // Trades.
  @Get('trades/awaiting')
  @RequirePermissions(P.PLAYER_TRADE_RECOVER)
  @ApiOperation({
    summary:
      'Trades AWAITING_GAME_CONFIRMATION (oldest lock first) with escrow and last Agent rejection.',
  })
  trades(@Query() query: WorkQueueQueryDto) {
    return this.queries.trades(query);
  }
  @Post('trades/:tradeId/requeue')
  @HttpCode(200)
  @RequirePermissions(P.PLAYER_TRADE_RECOVER)
  @ApiOperation({
    summary:
      'REQUEUE_SAME_WORK: offer the same trade (same workId) to the Agent again. Creates nothing and moves no GOLD.',
  })
  requeueTrade(
    @Param('tradeId', uuid) tradeId: string,
    @Body() body: ReasonDto,
    @Headers(KEY) key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
  ) {
    return this.recovery.requeueTrade(auth, key, tradeId, body.reason);
  }

  // Marketplace.
  @Get('marketplace/custody')
  @RequirePermissions(P.PLAYER_MARKETPLACE_RECOVER)
  @ApiOperation({ summary: 'Listings PENDING_CUSTODY (oldest first).' })
  custody(@Query() query: WorkQueueQueryDto) {
    return this.queries.custody(query);
  }
  @Post('marketplace/custody/:listingId/requeue')
  @HttpCode(200)
  @RequirePermissions(P.PLAYER_MARKETPLACE_RECOVER)
  @ApiOperation({
    summary:
      'REQUEUE_SAME_WORK for a PENDING_CUSTODY listing (same workId). Never cancels.',
  })
  requeueCustody(
    @Param('listingId', uuid) listingId: string,
    @Body() body: ReasonDto,
    @Headers(KEY) key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
  ) {
    return this.recovery.requeueCustody(auth, key, listingId, body.reason);
  }
  @Get('marketplace/settlements')
  @RequirePermissions(P.PLAYER_MARKETPLACE_RECOVER)
  @ApiOperation({
    summary: 'Purchases AWAITING_GAME_CONFIRMATION with reserved GOLD.',
  })
  settlements(@Query() query: WorkQueueQueryDto) {
    return this.queries.settlements(query);
  }
  @Post('marketplace/settlements/:purchaseId/requeue')
  @HttpCode(200)
  @RequirePermissions(P.PLAYER_MARKETPLACE_RECOVER)
  @ApiOperation({
    summary:
      'REQUEUE_SAME_WORK for an AWAITING purchase (same workId). Never settles or refunds.',
  })
  requeueSettlement(
    @Param('purchaseId', uuid) purchaseId: string,
    @Body() body: ReasonDto,
    @Headers(KEY) key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
  ) {
    return this.recovery.requeueSettlement(auth, key, purchaseId, body.reason);
  }
  @Get('marketplace/releases')
  @RequirePermissions(P.PLAYER_MARKETPLACE_RECOVER)
  @ApiOperation({
    summary: 'Item releases PENDING or FAILED, with operator resolution.',
  })
  releases(@Query() query: ReleaseQueueQueryDto) {
    return this.queries.releases(query);
  }
  @Post('marketplace/releases/:releaseId/requeue')
  @HttpCode(200)
  @RequirePermissions(P.PLAYER_MARKETPLACE_RECOVER)
  @ApiOperation({
    summary: 'REQUEUE_SAME_WORK for a PENDING release (same workId).',
  })
  requeueRelease(
    @Param('releaseId', uuid) releaseId: string,
    @Body() body: ReasonDto,
    @Headers(KEY) key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
  ) {
    return this.recovery.requeueRelease(auth, key, releaseId, body.reason);
  }
  @Post('marketplace/releases/:releaseId/acknowledge')
  @HttpCode(200)
  @RequirePermissions(P.PLAYER_MARKETPLACE_RECOVER)
  @ApiOperation({
    summary:
      'ACKNOWLEDGE a FAILED release (audited, no state change). A FAILED release is never retried.',
  })
  acknowledgeRelease(
    @Param('releaseId', uuid) releaseId: string,
    @Body() body: ReasonDto,
    @Headers(KEY) key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
  ) {
    return this.recovery.acknowledgeRelease(auth, key, releaseId, body.reason);
  }
  @Post('marketplace/releases/:releaseId/resolve')
  @HttpCode(200)
  @RequirePermissions(P.PLAYER_MARKETPLACE_RECOVER)
  @ApiOperation({
    summary:
      'Record the manual resolution of a FAILED release (item with the seller, or handled out of band).',
  })
  resolveRelease(
    @Param('releaseId', uuid) releaseId: string,
    @Body() body: ResolveReleaseDto,
    @Headers(KEY) key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
  ) {
    return this.recovery.resolveRelease(
      auth,
      key,
      releaseId,
      body.resolution,
      body.reason,
    );
  }

  // VIP deliveries.
  @Get('vip-deliveries')
  @RequirePermissions(P.VIP_DELIVERY_RECOVER)
  @ApiOperation({
    summary:
      'VIP deliveries (default FAILED and UNCERTAIN), with the command evidence and whether RETRY_SAFE applies.',
  })
  vipDeliveries(@Query() query: VipQueueQueryDto) {
    return this.queries.vipDeliveries(query);
  }
  @Get('vip-deliveries/:deliveryId')
  @RequirePermissions(P.VIP_DELIVERY_RECOVER)
  @ApiOperation({ summary: 'One VIP delivery with its previous attempts.' })
  vipDelivery(@Param('deliveryId', uuid) deliveryId: string) {
    return this.queries.vipDelivery(deliveryId);
  }
  @Post('vip-deliveries/:deliveryId/retry')
  @HttpCode(200)
  @RequirePermissions(P.VIP_DELIVERY_RECOVER)
  @ApiOperation({
    summary:
      'RETRY_SAFE: a new attempt (new command) only after a proven pre-effect failure or a CONFIRMED_NOT_DELIVERED resolution.',
  })
  retryDelivery(
    @Param('deliveryId', uuid) deliveryId: string,
    @Body() body: ReasonDto,
    @Headers(KEY) key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
  ) {
    return this.recovery.retryDelivery(auth, key, deliveryId, body.reason);
  }
  @Post('vip-deliveries/:deliveryId/resolve')
  @HttpCode(200)
  @RequirePermissions(P.VIP_DELIVERY_RECOVER)
  @ApiOperation({
    summary:
      'Record what the operator verified in game for a FAILED/UNCERTAIN delivery.',
  })
  resolveDelivery(
    @Param('deliveryId', uuid) deliveryId: string,
    @Body() body: ResolveDeliveryDto,
    @Headers(KEY) key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
  ) {
    return this.recovery.resolveDelivery(
      auth,
      key,
      deliveryId,
      body.resolution,
      body.reason,
    );
  }

  // Player accounts.
  @Get('players/:playerId')
  @RequirePermissions(P.PLAYER_ACCOUNT_MODERATE)
  @ApiOperation({ summary: 'Player account status and active sessions.' })
  player(@Param('playerId', uuid) playerId: string) {
    return this.queries.player(playerId);
  }
  @Post('players/:playerId/status')
  @HttpCode(200)
  @RequirePermissions(P.PLAYER_ACCOUNT_MODERATE)
  @ApiOperation({
    summary:
      'Set ACTIVE, SUSPENDED or BANNED. Leaving ACTIVE revokes every session and closes its realtime; ACTIVE revives none.',
  })
  playerStatus(
    @Param('playerId', uuid) playerId: string,
    @Body() body: PlayerStatusDto,
    @Headers(KEY) key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
  ) {
    return this.moderation.setPlayerStatus(
      auth,
      key,
      playerId,
      body.status,
      body.reason,
    );
  }

  // Economy.
  @Get('economy/:gameServerId/wallets/:characterExternalId')
  @RequirePermissions(P.PLAYER_ECONOMY_ADJUST)
  @ApiOperation({ summary: 'Current GOLD balance of a character wallet.' })
  wallet(@Param() route: WalletRouteDto) {
    return this.queries.wallet(route.gameServerId, route.characterExternalId);
  }
  @Post('economy/adjustments')
  @HttpCode(200)
  @RequirePermissions(P.PLAYER_ECONOMY_ADJUST)
  @ApiOperation({
    summary:
      'CREDIT or DEBIT a positive amount through the ledger (STAFF_ADJUSTMENT). There is no set-balance.',
  })
  adjust(
    @Body() body: WalletAdjustmentDto,
    @Headers(KEY) key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
  ) {
    return this.moderation.adjustWallet(auth, key, body);
  }

  // Chat.
  @Get('chat/messages')
  @RequirePermissions(P.PLAYER_CHAT_MODERATE)
  @ApiOperation({
    summary:
      'Channel messages (GLOBAL, GROUP, GUILD) of one server, newest first. DIRECT messages are read by id only.',
  })
  chatMessages(@Query() query: ChatQueryDto) {
    return this.queries.chatMessages(query);
  }
  @Get('chat/messages/:messageId')
  @RequirePermissions(P.PLAYER_CHAT_MODERATE)
  @ApiOperation({ summary: 'One chat message, by id (e.g. from a report).' })
  chatMessage(@Param('messageId', uuid) messageId: string) {
    return this.queries.chatMessage(messageId);
  }
  @Post('chat/messages/:messageId/hide')
  @HttpCode(200)
  @RequirePermissions(P.PLAYER_CHAT_MODERATE)
  @ApiOperation({
    summary:
      'Hide a message from every Player read. Never deletes; content kept as evidence.',
  })
  hideChatMessage(
    @Param('messageId', uuid) messageId: string,
    @Body() body: ReasonDto,
    @Headers(KEY) key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
  ) {
    return this.moderation.hideChatMessage(auth, key, messageId, body.reason);
  }
}
