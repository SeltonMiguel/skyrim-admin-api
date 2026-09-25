import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, In } from 'typeorm';
import type { SelectQueryBuilder } from 'typeorm';
import { pageResult } from '../admin-queries/query-pagination.js';
import { AuditService } from '../audit/audit.service.js';
import {
  AuditAction,
  AuditOutcome,
  AuditResource,
} from '../audit/audit.types.js';
import { idempotencyScope } from '../actors/actor.contracts.js';
import type { Actor, PlayerActor } from '../actors/actor.contracts.js';
import { idempotencyKey } from '../actor-operations/actor-command.service.js';
import { LedgerRejectionError } from '../economy/economy-ledger.service.js';
import type { GameServer } from '../game-bridge/entities/game-server.entity.js';
import { PlayerStatus } from '../player-accounts/player-account.contracts.js';
import type { PlayerCharacter } from '../player-characters/entities/player-character.entity.js';
import { CharacterLinkStatus } from '../player-characters/player-character.contracts.js';
import { RealtimeEventBus } from '../realtime-events/realtime-event-bus.js';
import type {
  RealtimeData,
  RealtimeEventType,
} from '../realtime-events/realtime-event-bus.js';
import { PlayerMarketplaceListing } from './entities/player-marketplace-listing.entity.js';
import { PlayerMarketplacePurchase } from './entities/player-marketplace-purchase.entity.js';
import type { PlayerMarketplaceRequest } from './entities/player-marketplace-request.entity.js';
import type { PlayerMarketplaceItemRelease } from './entities/player-marketplace-item-release.entity.js';
import { MarketEscrowService } from './market-escrow.service.js';
import {
  ListingStatus,
  MarketRequestOperation as Op,
  PurchaseStatus,
  ReleaseReason,
  ReleaseStatus,
} from './player-marketplace.contracts.js';
import type {
  ListingBrowseQueryDto,
  ListingDto,
  MarketListQueryDto,
  OwnListingDto,
  PurchaseDto,
} from './dto/player-marketplace.dto.js';

type Link = PlayerCharacter & { player: { status: PlayerStatus } };
export interface PendingMarketEvent {
  type: RealtimeEventType;
  data: RealtimeData;
  playerIds: string[];
}
const listingNotFound = () => new NotFoundException('Listing not found');
const purchaseNotFound = () => new NotFoundException('Purchase not found');
const characterNotFound = () => new NotFoundException('Character not found');
const LEDGER_MESSAGES: Record<string, string> = {
  INSUFFICIENT_FUNDS: 'Insufficient funds',
  BALANCE_LIMIT: 'Balance limit reached',
};
// A listing is offered publicly only while ACTIVE, on an enabled game
// server and while its seller character has a VERIFIED owner whose account
// is ACTIVE: exactly the listings a purchase could currently succeed on.
// Seller views, cancel and the Agent settlement ignore server availability.
const SERVER_ENABLED = `EXISTS (SELECT 1 FROM game_servers s WHERE s.id = listing.game_server_id AND s.enabled)`;
const SELLER_AVAILABLE = `EXISTS (SELECT 1 FROM player_characters c JOIN players p ON p.id = c.player_id
  WHERE c.game_server_id = listing.game_server_id AND c.character_external_id = listing.seller_character_id
    AND c.status = 'VERIFIED' AND p.status = 'ACTIVE')`;

// Listings belong to the seller character identity and purchases to the
// buyer character identity; an own VERIFIED link only authorizes the
// current player to act for one of them.
//
// Lock order in every transaction: idempotency claim (unique key), listing
// row FOR UPDATE, purchase row FOR UPDATE, character links, escrow row,
// then economy accounts (ascending id, inside the ledger). A listing is only
// ever mutated under its row lock, so purchases, cancels, custody and
// settlement of one listing serialize.
@Injectable()
export class PlayerMarketplaceService {
  constructor(
    private readonly database: DataSource,
    private readonly audit: AuditService,
    private readonly events: RealtimeEventBus,
    private readonly escrow: MarketEscrowService,
  ) {}

  // Runs the mutation; events are published only after commit. Ledger
  // rejections become a 409 for the Player API unless the caller (the
  // Agent settlement) handles them itself.
  async mutate<T>(
    work: (manager: EntityManager, events: PendingMarketEvent[]) => Promise<T>,
    mapLedgerRejections = true,
  ): Promise<T> {
    const events: PendingMarketEvent[] = [];
    let result: T;
    try {
      result = await this.database.transaction((manager) =>
        work(manager, events),
      );
    } catch (error) {
      if (mapLedgerRejections && error instanceof LedgerRejectionError)
        throw new ConflictException(
          LEDGER_MESSAGES[error.reason] ?? 'Purchase rejected',
        );
      throw error;
    }
    for (const event of events)
      this.events.publish(event.type, event.data, {
        playerIds: event.playerIds,
      });
    return result;
  }
  async createRelease(
    manager: EntityManager,
    listing: PlayerMarketplaceListing,
    reason: ReleaseReason,
  ): Promise<void> {
    await manager
      .getRepository<PlayerMarketplaceItemRelease>(
        'PlayerMarketplaceItemRelease',
      )
      .insert({
        listingId: listing.id,
        gameServerId: listing.gameServerId,
        sellerCharacterId: listing.sellerCharacterId,
        reason,
        status: ReleaseStatus.PENDING,
      });
  }
  listings(manager: EntityManager) {
    return manager.getRepository<PlayerMarketplaceListing>(
      'PlayerMarketplaceListing',
    );
  }
  purchases(manager: EntityManager) {
    return manager.getRepository<PlayerMarketplacePurchase>(
      'PlayerMarketplacePurchase',
    );
  }
  private async ownLink(
    manager: EntityManager,
    actor: PlayerActor,
    id: string,
    lock = false,
  ): Promise<PlayerCharacter> {
    const link = await manager
      .getRepository<PlayerCharacter>('PlayerCharacter')
      .findOne({
        where: {
          id,
          playerId: actor.playerId,
          status: CharacterLinkStatus.VERIFIED,
        },
        ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
      });
    if (!link) throw characterNotFound();
    return link;
  }
  async lockListing(
    manager: EntityManager,
    id: string,
  ): Promise<PlayerMarketplaceListing> {
    if (!isUUID(id)) throw listingNotFound();
    const listing = await this.listings(manager).findOne({
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!listing) throw listingNotFound();
    return listing;
  }
  // Only the current owner of the seller character sees or cancels it.
  private assertSeller(
    listing: PlayerMarketplaceListing,
    link: PlayerCharacter,
  ): void {
    if (
      link.gameServerId !== listing.gameServerId ||
      link.characterExternalId !== listing.sellerCharacterId
    )
      throw listingNotFound();
  }
  // Current VERIFIED owners of the given characters on one server.
  private async owners(
    manager: EntityManager,
    gameServerId: string,
    characterIds: string[],
  ): Promise<Map<string, Link>> {
    const links = (await manager
      .getRepository<PlayerCharacter>('PlayerCharacter')
      .find({
        where: {
          gameServerId,
          characterExternalId: In([...new Set(characterIds)]),
          status: CharacterLinkStatus.VERIFIED,
        },
        relations: { player: true },
      })) as Link[];
    return new Map(links.map((l) => [l.characterExternalId, l]));
  }
  // Realtime recipients: the current VERIFIED owners, never strangers.
  async playersOf(
    manager: EntityManager,
    gameServerId: string,
    characterIds: (string | null)[],
  ): Promise<string[]> {
    const ids = characterIds.filter((id): id is string => id !== null);
    if (!ids.length) return [];
    const owners = await this.owners(manager, gameServerId, ids);
    return [...owners.values()].map((l) => l.playerId);
  }
  private async servers(manager: EntityManager, ids: string[]) {
    const rows = await manager
      .getRepository<GameServer>('GameServer')
      .findBy({ id: In([...new Set(ids)]) });
    return new Map(
      rows.map((s) => [
        s.id,
        { id: s.id, code: s.code, name: s.name, enabled: s.enabled },
      ]),
    );
  }
  async listingViews(
    manager: EntityManager,
    listings: PlayerMarketplaceListing[],
  ): Promise<ListingDto[]> {
    if (!listings.length) return [];
    const servers = await this.servers(
      manager,
      listings.map((l) => l.gameServerId),
    );
    return listings.map((listing) => ({
      listingId: listing.id,
      gameServer: servers.get(listing.gameServerId)!,
      sellerCharacterId: listing.sellerCharacterId,
      itemId: listing.itemExternalId,
      quantity: listing.quantity,
      priceGold: listing.priceGold,
      status: listing.status,
      createdAt: listing.createdAt,
    }));
  }
  private async ownViews(
    manager: EntityManager,
    listings: PlayerMarketplaceListing[],
    characterLinkId: string,
  ): Promise<OwnListingDto[]> {
    const views = await this.listingViews(manager, listings);
    return listings.map((listing, index) => ({
      ...views[index],
      characterLinkId,
      buyerCharacterId: listing.reservedByCharacterId,
      reservedAt: listing.reservedAt,
      soldAt: listing.soldAt,
      cancelledAt: listing.cancelledAt,
      failedAt: listing.failedAt,
      updatedAt: listing.updatedAt,
    }));
  }
  private async purchaseViews(
    manager: EntityManager,
    purchases: PlayerMarketplacePurchase[],
  ): Promise<PurchaseDto[]> {
    if (!purchases.length) return [];
    const listings = await this.listings(manager).findBy({
      id: In(purchases.map((p) => p.listingId)),
    });
    const views = new Map(
      (await this.listingViews(manager, listings)).map((v) => [v.listingId, v]),
    );
    return purchases.map((purchase) => ({
      purchaseId: purchase.id,
      listing: views.get(purchase.listingId)!,
      buyerCharacterId: purchase.buyerCharacterId,
      status: purchase.status,
      createdAt: purchase.createdAt,
      updatedAt: purchase.updatedAt,
      completedAt: purchase.completedAt,
      failedAt: purchase.failedAt,
    }));
  }
  record(
    manager: EntityManager,
    actor: Actor,
    action: AuditAction,
    listing: PlayerMarketplaceListing,
    extra: Record<string, unknown>,
    statusCode?: number,
  ) {
    return this.audit.record(
      {
        actor,
        action,
        resourceType: AuditResource.PLAYER_MARKETPLACE,
        resourceId: listing.id,
        metadata: {
          listingId: listing.id,
          gameServerId: listing.gameServerId,
          sellerCharacterId: listing.sellerCharacterId,
          itemExternalId: listing.itemExternalId,
          quantity: listing.quantity,
          priceGold: listing.priceGold,
          status: listing.status,
          ...extra,
        },
        outcome: AuditOutcome.SUCCESS,
        statusCode,
      },
      manager,
    );
  }
  data(listing: PlayerMarketplaceListing, extra: RealtimeData = {}) {
    return {
      listingId: listing.id,
      gameServerId: listing.gameServerId,
      status: listing.status,
      sellerCharacterId: listing.sellerCharacterId,
      itemId: listing.itemExternalId,
      quantity: listing.quantity,
      priceGold: listing.priceGold,
      ...extra,
    } satisfies RealtimeData;
  }
  // Claims the Idempotency-Key for this player in the mutation transaction.
  // Returns the listing id of an earlier identical request (replay), or null.
  private async claim(
    manager: EntityManager,
    actor: PlayerActor,
    key: string,
    operation: Op,
    content: unknown,
    listingId: string,
  ): Promise<string | null> {
    const scope = idempotencyScope(actor);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([operation, content]))
      .digest('hex');
    const inserted: unknown[] = await manager.query(
      `INSERT INTO player_marketplace_requests(idempotency_scope, idempotency_key, player_id, operation, request_fingerprint, listing_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_scope, idempotency_key) DO NOTHING RETURNING id`,
      [scope, key, actor.playerId, operation, fingerprint, listingId],
    );
    if (inserted.length) return null;
    const existing = await manager
      .getRepository<PlayerMarketplaceRequest>('PlayerMarketplaceRequest')
      .findOneByOrFail({ idempotencyScope: scope, idempotencyKey: key });
    if (
      existing.operation !== operation ||
      existing.requestFingerprint !== fingerprint
    )
      throw new ConflictException(
        'Idempotency-Key already used with different content',
      );
    return existing.listingId;
  }
  // A replayed seller request answers with the listing as it is now, to
  // its current owner only.
  private async sellerReplay(
    manager: EntityManager,
    actor: PlayerActor,
    listingId: string,
    characterLinkId: string,
  ): Promise<OwnListingDto> {
    const listing = await this.listings(manager).findOneByOrFail({
      id: listingId,
    });
    const link = await this.ownLink(manager, actor, characterLinkId);
    this.assertSeller(listing, link);
    return (await this.ownViews(manager, [listing], link.id))[0];
  }

  async create(
    actor: PlayerActor,
    key: string | undefined,
    input: {
      characterLinkId: string;
      itemId: string;
      quantity: number;
      priceGold: number;
    },
  ): Promise<OwnListingDto> {
    const idempotency = idempotencyKey(key);
    const listingId = randomUUID();
    return this.mutate(async (manager) => {
      const replay = await this.claim(
        manager,
        actor,
        idempotency,
        Op.CREATE,
        [input.characterLinkId, input.itemId, input.quantity, input.priceGold],
        listingId,
      );
      if (replay)
        return this.sellerReplay(manager, actor, replay, input.characterLinkId);
      const link = await this.ownLink(
        manager,
        actor,
        input.characterLinkId,
        true,
      );
      const server = await manager
        .getRepository<GameServer>('GameServer')
        .findOneByOrFail({ id: link.gameServerId });
      if (!server.enabled) throw new ConflictException('Game server disabled');
      // Nothing is debited and the item is not presumed to exist: the
      // listing waits for the Agent to take custody.
      await this.listings(manager).insert({
        id: listingId,
        gameServerId: link.gameServerId,
        sellerCharacterId: link.characterExternalId,
        itemExternalId: input.itemId,
        quantity: input.quantity,
        priceGold: input.priceGold,
        status: ListingStatus.PENDING_CUSTODY,
      });
      const saved = await this.listings(manager).findOneByOrFail({
        id: listingId,
      });
      await this.record(
        manager,
        actor,
        AuditAction.PLAYER_MARKETPLACE_LISTING_CREATED,
        saved,
        {},
        201,
      );
      return (await this.ownViews(manager, [saved], link.id))[0];
    });
  }
  // PENDING_CUSTODY or ACTIVE -> CANCELLED (the Agent returns any held
  // item). CANCELLED again is a no-op; RESERVED, SOLD and FAILED are 409.
  async cancel(
    actor: PlayerActor,
    key: string | undefined,
    listingId: string,
    characterLinkId: string,
  ): Promise<OwnListingDto> {
    const idempotency = idempotencyKey(key);
    return this.mutate(async (manager, events) => {
      const replay = await this.claim(
        manager,
        actor,
        idempotency,
        Op.CANCEL,
        [listingId, characterLinkId],
        isUUID(listingId) ? listingId : randomUUID(),
      );
      if (replay)
        return this.sellerReplay(manager, actor, replay, characterLinkId);
      const listing = await this.lockListing(manager, listingId);
      const link = await this.ownLink(manager, actor, characterLinkId);
      this.assertSeller(listing, link);
      if (listing.status === ListingStatus.CANCELLED)
        return (await this.ownViews(manager, [listing], link.id))[0];
      if (listing.status === ListingStatus.RESERVED)
        throw new ConflictException(
          'Listing is reserved by a purchase and cannot be cancelled',
        );
      if (
        listing.status !== ListingStatus.PENDING_CUSTODY &&
        listing.status !== ListingStatus.ACTIVE
      )
        throw new ConflictException('Listing already finished');
      await this.listings(manager).update(listing.id, {
        status: ListingStatus.CANCELLED,
        cancelledAt: new Date(),
      });
      // An ACTIVE listing's item is in the Agent's custody: its return to
      // the seller is tracked until the Agent reports it (Etapa 11.4). A
      // PENDING_CUSTODY listing has no confirmed custody yet: a late
      // CUSTODIED event creates the persistent release in its transaction.
      if (listing.status === ListingStatus.ACTIVE)
        await this.createRelease(manager, listing, ReleaseReason.CANCELLED);
      const saved = await this.listings(manager).findOneByOrFail({
        id: listing.id,
      });
      await this.record(
        manager,
        actor,
        AuditAction.PLAYER_MARKETPLACE_LISTING_CANCELLED,
        saved,
        { previousStatus: listing.status },
        200,
      );
      events.push({
        type: 'MARKETPLACE_LISTING_CANCELLED',
        data: this.data(saved, { previousStatus: listing.status }),
        playerIds: await this.playersOf(manager, saved.gameServerId, [
          saved.sellerCharacterId,
        ]),
      });
      return (await this.ownViews(manager, [saved], link.id))[0];
    });
  }
  // ACTIVE -> RESERVED with the buyer's GOLD in MARKET_ESCROW and one
  // purchase AWAITING_GAME_CONFIRMATION, atomically.
  async purchase(
    actor: PlayerActor,
    key: string | undefined,
    listingId: string,
    characterLinkId: string,
  ): Promise<PurchaseDto> {
    const idempotency = idempotencyKey(key);
    const purchaseId = randomUUID();
    return this.mutate(async (manager, events) => {
      const replay = await this.claim(
        manager,
        actor,
        idempotency,
        Op.PURCHASE,
        [listingId, characterLinkId],
        isUUID(listingId) ? listingId : randomUUID(),
      );
      if (replay) {
        const purchase = await this.purchases(manager).findOneByOrFail({
          listingId: replay,
        });
        const listing = await this.listings(manager).findOneByOrFail({
          id: replay,
        });
        const link = await this.ownLink(manager, actor, characterLinkId);
        if (
          link.gameServerId !== listing.gameServerId ||
          link.characterExternalId !== purchase.buyerCharacterId
        )
          throw purchaseNotFound();
        return (await this.purchaseViews(manager, [purchase]))[0];
      }
      const listing = await this.lockListing(manager, listingId);
      const link = await this.ownLink(manager, actor, characterLinkId);
      if (listing.status !== ListingStatus.ACTIVE)
        throw new ConflictException('Listing is not available');
      if (link.gameServerId !== listing.gameServerId)
        throw new ConflictException('Listing is on another game server');
      if (link.characterExternalId === listing.sellerCharacterId)
        throw new ConflictException('Cannot buy your own listing');
      const server = await manager
        .getRepository<GameServer>('GameServer')
        .findOneByOrFail({ id: listing.gameServerId });
      if (!server.enabled) throw new ConflictException('Game server disabled');
      const seller = (
        await this.owners(manager, listing.gameServerId, [
          listing.sellerCharacterId,
        ])
      ).get(listing.sellerCharacterId);
      if (seller?.player.status !== PlayerStatus.ACTIVE)
        throw new ConflictException('Seller unavailable');
      await this.purchases(manager).insert({
        id: purchaseId,
        listingId: listing.id,
        buyerCharacterId: link.characterExternalId,
        status: PurchaseStatus.AWAITING_GAME_CONFIRMATION,
      });
      await this.escrow.reserve(
        manager,
        listing,
        { id: purchaseId, buyerCharacterId: link.characterExternalId },
        actor,
      );
      await this.listings(manager).update(listing.id, {
        status: ListingStatus.RESERVED,
        reservedByCharacterId: link.characterExternalId,
        reservedAt: new Date(),
      });
      const saved = await this.listings(manager).findOneByOrFail({
        id: listing.id,
      });
      const purchase = await this.purchases(manager).findOneByOrFail({
        id: purchaseId,
      });
      await this.record(
        manager,
        actor,
        AuditAction.PLAYER_MARKETPLACE_PURCHASE_CREATED,
        saved,
        {
          purchaseId,
          buyerCharacterId: purchase.buyerCharacterId,
          purchaseStatus: purchase.status,
        },
        201,
      );
      events.push({
        type: 'MARKETPLACE_LISTING_RESERVED',
        data: this.data(saved, {
          purchaseId,
          buyerCharacterId: purchase.buyerCharacterId,
          purchaseStatus: purchase.status,
        }),
        playerIds: await this.playersOf(manager, saved.gameServerId, [
          saved.sellerCharacterId,
          purchase.buyerCharacterId,
        ]),
      });
      return (await this.purchaseViews(manager, [purchase]))[0];
    });
  }

  private available(builder: SelectQueryBuilder<PlayerMarketplaceListing>) {
    return builder
      .where('listing.status = :active', { active: ListingStatus.ACTIVE })
      .andWhere(SERVER_ENABLED)
      .andWhere(SELLER_AVAILABLE);
  }
  async browse(query: ListingBrowseQueryDto) {
    if (
      query.minPrice !== undefined &&
      query.maxPrice !== undefined &&
      query.minPrice > query.maxPrice
    )
      throw new BadRequestException('minPrice must not exceed maxPrice');
    const manager = this.database.manager;
    const builder = this.available(
      this.listings(manager).createQueryBuilder('listing'),
    );
    if (query.gameServerId)
      builder.andWhere('listing.gameServerId = :server', {
        server: query.gameServerId,
      });
    if (query.minPrice !== undefined)
      builder.andWhere('listing.priceGold >= :min', { min: query.minPrice });
    if (query.maxPrice !== undefined)
      builder.andWhere('listing.priceGold <= :max', { max: query.maxPrice });
    const [listings, total] = await builder
      .orderBy('listing.createdAt', 'DESC')
      .addOrderBy('listing.id', 'DESC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();
    return pageResult(await this.listingViews(manager, listings), total, query);
  }
  // Public (authenticated) read: ACTIVE and purchasable only; anything else
  // is 404 here and visible to its seller through the own listings.
  async get(listingId: string): Promise<ListingDto> {
    if (!isUUID(listingId)) throw listingNotFound();
    const manager = this.database.manager;
    const listing = await this.available(
      this.listings(manager).createQueryBuilder('listing'),
    )
      .andWhere('listing.id = :id', { id: listingId })
      .getOne();
    if (!listing) throw listingNotFound();
    return (await this.listingViews(manager, [listing]))[0];
  }
  async ownListings(
    actor: PlayerActor,
    characterLinkId: string,
    query: MarketListQueryDto,
  ) {
    const manager = this.database.manager;
    const link = await this.ownLink(manager, actor, characterLinkId);
    const [listings, total] = await this.listings(manager)
      .createQueryBuilder('listing')
      .where('listing.gameServerId = :server', { server: link.gameServerId })
      .andWhere('listing.sellerCharacterId = :character', {
        character: link.characterExternalId,
      })
      .orderBy('listing.createdAt', 'DESC')
      .addOrderBy('listing.id', 'DESC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();
    return pageResult(
      await this.ownViews(manager, listings, link.id),
      total,
      query,
    );
  }
  async ownPurchases(
    actor: PlayerActor,
    characterLinkId: string,
    query: MarketListQueryDto,
  ) {
    const manager = this.database.manager;
    const link = await this.ownLink(manager, actor, characterLinkId);
    const [purchases, total] = await this.purchases(manager)
      .createQueryBuilder('purchase')
      .innerJoin('purchase.listing', 'listing')
      .where('listing.gameServerId = :server', { server: link.gameServerId })
      .andWhere('purchase.buyerCharacterId = :character', {
        character: link.characterExternalId,
      })
      .orderBy('purchase.createdAt', 'DESC')
      .addOrderBy('purchase.id', 'DESC')
      .offset((query.page - 1) * query.limit)
      .limit(query.limit)
      .getManyAndCount();
    return pageResult(
      await this.purchaseViews(manager, purchases),
      total,
      query,
    );
  }
}
