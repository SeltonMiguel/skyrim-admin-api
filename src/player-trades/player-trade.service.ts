import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, In } from 'typeorm';
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
import { PlayerSettingsService } from '../player-settings/player-settings.service.js';
import { PlayerInteraction } from '../player-settings/player-settings.contracts.js';
import { RealtimeEventBus } from '../realtime-events/realtime-event-bus.js';
import type {
  RealtimeData,
  RealtimeEventType,
} from '../realtime-events/realtime-event-bus.js';
import { PlayerTrade } from './entities/player-trade.entity.js';
import { PlayerTradeOffer } from './entities/player-trade-offer.entity.js';
import { PlayerTradeItem } from './entities/player-trade-item.entity.js';
import type { PlayerTradeRequest } from './entities/player-trade-request.entity.js';
import { TradeEscrowService } from './trade-escrow.service.js';
import {
  otherSide,
  TradeRequestOperation as Op,
  TradeSide,
  TradeStatus,
} from './player-trade.contracts.js';
import type { TradeOfferInput } from './player-trade.contracts.js';
import type { TradeDto, TradeListQueryDto } from './dto/player-trade.dto.js';

type Link = PlayerCharacter & { player: { status: PlayerStatus } };
type Offer = PlayerTradeOffer & { items: PlayerTradeItem[] };
export interface PendingTradeEvent {
  type: RealtimeEventType;
  data: RealtimeData;
  playerIds: string[];
}
const tradeNotFound = () => new NotFoundException('Trade not found');
const characterNotFound = () => new NotFoundException('Character not found');
const LEDGER_MESSAGES: Record<string, string> = {
  INSUFFICIENT_FUNDS: 'Insufficient funds',
  BALANCE_LIMIT: 'Balance limit reached',
};

// Trades belong to the two character identities; an own VERIFIED link only
// authorizes the current player to act for one of them.
//
// Lock order in every transaction: idempotency claim (unique key), trade row
// FOR UPDATE, character links, offers/items/escrows, then economy accounts
// (ascending id, inside the ledger). A trade is only ever mutated under its
// row lock, so accepts, offer edits and cancels on one trade serialize.
@Injectable()
export class PlayerTradeService {
  constructor(
    private readonly database: DataSource,
    private readonly audit: AuditService,
    private readonly events: RealtimeEventBus,
    private readonly escrow: TradeEscrowService,
    private readonly settings: PlayerSettingsService,
  ) {}

  // Runs the mutation; events are published only after commit.
  // Ledger rejections become a 409 for the Player API unless the caller
  // (the Agent settlement) handles them itself.
  async mutate<T>(
    work: (manager: EntityManager, events: PendingTradeEvent[]) => Promise<T>,
    mapLedgerRejections = true,
  ): Promise<T> {
    const events: PendingTradeEvent[] = [];
    let result: T;
    try {
      result = await this.database.transaction((manager) =>
        work(manager, events),
      );
    } catch (error) {
      if (mapLedgerRejections && error instanceof LedgerRejectionError)
        throw new ConflictException(
          LEDGER_MESSAGES[error.reason] ?? 'Trade settlement rejected',
        );
      throw error;
    }
    for (const event of events)
      this.events.publish(event.type, event.data, {
        playerIds: event.playerIds,
      });
    return result;
  }
  trades(manager: EntityManager) {
    return manager.getRepository<PlayerTrade>('PlayerTrade');
  }
  private offersRepo(manager: EntityManager) {
    return manager.getRepository<PlayerTradeOffer>('PlayerTradeOffer');
  }
  private itemsRepo(manager: EntityManager) {
    return manager.getRepository<PlayerTradeItem>('PlayerTradeItem');
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
  async lockTrade(manager: EntityManager, id: string): Promise<PlayerTrade> {
    if (!isUUID(id)) throw tradeNotFound();
    const trade = await this.trades(manager).findOne({
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!trade) throw tradeNotFound();
    return trade;
  }
  private sideOf(trade: PlayerTrade, link: PlayerCharacter): TradeSide {
    if (link.gameServerId === trade.gameServerId) {
      if (link.characterExternalId === trade.initiatorCharacterId)
        return TradeSide.INITIATOR;
      if (link.characterExternalId === trade.targetCharacterId)
        return TradeSide.TARGET;
    }
    throw tradeNotFound();
  }
  async offers(manager: EntityManager, tradeIds: string[]) {
    const offers = (await this.offersRepo(manager).find({
      where: { tradeId: In(tradeIds) },
      relations: { items: true },
      order: { items: { itemExternalId: 'ASC' } },
    })) as Offer[];
    return (tradeId: string, side: TradeSide) =>
      offers.find((o) => o.tradeId === tradeId && o.side === side)!;
  }
  // Current VERIFIED owners of the given characters on one server.
  async owners(
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
  async recipients(manager: EntityManager, trade: PlayerTrade) {
    const owners = await this.owners(manager, trade.gameServerId, [
      trade.initiatorCharacterId,
      trade.targetCharacterId,
    ]);
    return [...owners.values()].map((l) => l.playerId);
  }
  async views(
    manager: EntityManager,
    trades: PlayerTrade[],
    viewer: PlayerActor | null,
  ): Promise<TradeDto[]> {
    if (!trades.length) return [];
    const offerOf = await this.offers(
      manager,
      trades.map((t) => t.id),
    );
    const servers = await manager
      .getRepository<GameServer>('GameServer')
      .findBy({ id: In([...new Set(trades.map((t) => t.gameServerId))]) });
    const own = new Map<string, string>();
    if (viewer) {
      const links = await manager
        .getRepository<PlayerCharacter>('PlayerCharacter')
        .find({
          where: {
            playerId: viewer.playerId,
            status: CharacterLinkStatus.VERIFIED,
            characterExternalId: In(
              trades.flatMap((t) => [
                t.initiatorCharacterId,
                t.targetCharacterId,
              ]),
            ),
          },
        });
      for (const link of links)
        own.set(`${link.gameServerId}:${link.characterExternalId}`, link.id);
    }
    return trades.map((trade) => {
      const server = servers.find((s) => s.id === trade.gameServerId)!;
      const party = (side: TradeSide) => {
        const characterId = this.escrow.partyOf(trade, side);
        const offer = offerOf(trade.id, side);
        return {
          characterId,
          characterLinkId:
            own.get(`${trade.gameServerId}:${characterId}`) ?? null,
          acceptedAt:
            side === TradeSide.INITIATOR
              ? trade.initiatorAcceptedAt
              : trade.targetAcceptedAt,
          offer: {
            version: offer.version,
            gold: offer.goldAmount,
            items: offer.items.map((i) => ({
              itemId: i.itemExternalId,
              quantity: i.quantity,
            })),
          },
        };
      };
      return {
        tradeId: trade.id,
        gameServer: {
          id: server.id,
          code: server.code,
          name: server.name,
          enabled: server.enabled,
        },
        status: trade.status,
        initiator: party(TradeSide.INITIATOR),
        target: party(TradeSide.TARGET),
        lockedAt: trade.lockedAt,
        completedAt: trade.completedAt,
        cancelledAt: trade.cancelledAt,
        failedAt: trade.failedAt,
        createdAt: trade.createdAt,
        updatedAt: trade.updatedAt,
      };
    });
  }
  private async view(
    manager: EntityManager,
    tradeId: string,
    actor: PlayerActor,
  ): Promise<TradeDto> {
    const trade = await this.trades(manager).findOneByOrFail({ id: tradeId });
    return (await this.views(manager, [trade], actor))[0];
  }
  record(
    manager: EntityManager,
    actor: Actor,
    action: AuditAction,
    trade: PlayerTrade,
    extra: Record<string, unknown>,
    statusCode?: number,
  ) {
    return this.audit.record(
      {
        actor,
        action,
        resourceType: AuditResource.PLAYER_TRADE,
        resourceId: trade.id,
        metadata: {
          tradeId: trade.id,
          gameServerId: trade.gameServerId,
          ...extra,
        },
        outcome: AuditOutcome.SUCCESS,
        statusCode,
      },
      manager,
    );
  }
  data(trade: PlayerTrade, extra: RealtimeData = {}): RealtimeData {
    return {
      tradeId: trade.id,
      gameServerId: trade.gameServerId,
      status: trade.status,
      ...extra,
    };
  }
  // Claims the Idempotency-Key for this player in the mutation transaction.
  // Returns the trade id of an earlier identical request (replay), or null.
  private async claim(
    manager: EntityManager,
    actor: PlayerActor,
    key: string,
    operation: Op,
    content: unknown,
    tradeId: string,
  ): Promise<string | null> {
    const scope = idempotencyScope(actor);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([operation, content]))
      .digest('hex');
    const inserted: unknown[] = await manager.query(
      `INSERT INTO player_trade_requests(idempotency_scope, idempotency_key, player_id, operation, request_fingerprint, trade_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_scope, idempotency_key) DO NOTHING RETURNING id`,
      [scope, key, actor.playerId, operation, fingerprint, tradeId],
    );
    if (inserted.length) return null;
    const existing = await manager
      .getRepository<PlayerTradeRequest>('PlayerTradeRequest')
      .findOneByOrFail({ idempotencyScope: scope, idempotencyKey: key });
    if (
      existing.operation !== operation ||
      existing.requestFingerprint !== fingerprint
    )
      throw new ConflictException(
        'Idempotency-Key already used with different content',
      );
    return existing.tradeId;
  }
  // A replayed request answers with the trade as it is now, to a participant.
  private async replayed(
    manager: EntityManager,
    actor: PlayerActor,
    tradeId: string,
    characterLinkId: string,
  ) {
    const trade = await this.trades(manager).findOneByOrFail({ id: tradeId });
    this.sideOf(trade, await this.ownLink(manager, actor, characterLinkId));
    return (await this.views(manager, [trade], actor))[0];
  }
  private offer(input: TradeOfferInput): TradeOfferInput {
    const ids = input.items.map((i) => i.itemId);
    if (new Set(ids).size !== ids.length)
      throw new BadRequestException('Duplicate item in offer');
    return {
      gold: input.gold,
      items: [...input.items]
        .map((i) => ({ itemId: i.itemId, quantity: i.quantity }))
        .sort((a, b) => a.itemId.localeCompare(b.itemId)),
    };
  }
  private async writeItems(
    manager: EntityManager,
    offerId: string,
    offer: TradeOfferInput,
  ) {
    if (offer.items.length)
      await this.itemsRepo(manager).insert(
        offer.items.map((i) => ({
          offerId,
          itemExternalId: i.itemId,
          quantity: i.quantity,
        })),
      );
  }

  async create(
    actor: PlayerActor,
    key: string | undefined,
    input: {
      actorCharacterLinkId: string;
      targetCharacterId: string;
      offer: TradeOfferInput;
    },
  ): Promise<TradeDto> {
    const idempotency = idempotencyKey(key);
    const offer = this.offer(input.offer);
    const tradeId = randomUUID();
    return this.mutate(async (manager, events) => {
      const replay = await this.claim(
        manager,
        actor,
        idempotency,
        Op.CREATE,
        [input.actorCharacterLinkId, input.targetCharacterId, offer],
        tradeId,
      );
      if (replay)
        return this.replayed(
          manager,
          actor,
          replay,
          input.actorCharacterLinkId,
        );
      const link = await this.ownLink(
        manager,
        actor,
        input.actorCharacterLinkId,
        true,
      );
      const server = await manager
        .getRepository<GameServer>('GameServer')
        .findOneByOrFail({ id: link.gameServerId });
      if (!server.enabled) throw new ConflictException('Game server disabled');
      if (link.characterExternalId === input.targetCharacterId)
        throw new BadRequestException('A character cannot trade with itself');
      // Resolved on the actor's server by public game id; unknown, PENDING,
      // REVOKED, other-server and unavailable owners are indistinguishable.
      const target = (
        await this.owners(manager, link.gameServerId, [input.targetCharacterId])
      ).get(input.targetCharacterId);
      // An owner refusing new trades from other players looks the same.
      if (
        !target ||
        target.player.status !== PlayerStatus.ACTIVE ||
        (target.playerId !== actor.playerId &&
          !(await this.settings.allows(
            manager,
            target.playerId,
            PlayerInteraction.TRADE_REQUEST,
          )))
      )
        throw new NotFoundException('Character not available');
      const trade = this.trades(manager).create({
        id: tradeId,
        gameServerId: link.gameServerId,
        initiatorCharacterId: link.characterExternalId,
        targetCharacterId: target.characterExternalId,
        status: TradeStatus.NEGOTIATING,
      });
      await this.trades(manager).insert(trade);
      const empty: TradeOfferInput = { gold: 0, items: [] };
      for (const [side, content] of [
        [TradeSide.INITIATOR, offer],
        [TradeSide.TARGET, empty],
      ] as const) {
        const id = randomUUID();
        await this.offersRepo(manager).insert({
          id,
          tradeId,
          side,
          goldAmount: content.gold,
          version: 1,
        });
        await this.writeItems(manager, id, content);
      }
      const saved = await this.trades(manager).findOneByOrFail({ id: tradeId });
      await this.record(
        manager,
        actor,
        AuditAction.PLAYER_TRADE_CREATED,
        saved,
        {
          actorCharacterId: link.characterExternalId,
          targetCharacterId: target.characterExternalId,
          status: saved.status,
          offerVersion: 1,
          gold: offer.gold,
          itemCount: offer.items.length,
        },
        201,
      );
      events.push({
        type: 'TRADE_CREATED',
        data: this.data(saved, {
          initiatorCharacterId: saved.initiatorCharacterId,
          targetCharacterId: saved.targetCharacterId,
        }),
        playerIds: await this.recipients(manager, saved),
      });
      return (await this.views(manager, [saved], actor))[0];
    });
  }
  // Replaces the caller's own offer; any change resets both acceptances.
  async updateOffer(
    actor: PlayerActor,
    key: string | undefined,
    tradeId: string,
    input: { characterLinkId: string } & TradeOfferInput,
  ): Promise<TradeDto> {
    const idempotency = idempotencyKey(key);
    const offer = this.offer(input);
    return this.mutate(async (manager, events) => {
      const replay = await this.claim(
        manager,
        actor,
        idempotency,
        Op.OFFER,
        [tradeId, input.characterLinkId, offer],
        isUUID(tradeId) ? tradeId : randomUUID(),
      );
      if (replay)
        return this.replayed(manager, actor, replay, input.characterLinkId);
      const trade = await this.lockTrade(manager, tradeId);
      const link = await this.ownLink(manager, actor, input.characterLinkId);
      const side = this.sideOf(trade, link);
      if (trade.status !== TradeStatus.NEGOTIATING)
        throw new ConflictException('Trade offers are locked');
      const current = (await this.offers(manager, [trade.id]))(trade.id, side);
      await this.itemsRepo(manager).delete({ offerId: current.id });
      await this.writeItems(manager, current.id, offer);
      const version = current.version + 1;
      await this.offersRepo(manager).update(current.id, {
        goldAmount: offer.gold,
        version,
      });
      await this.trades(manager).update(trade.id, {
        initiatorAcceptedAt: null,
        targetAcceptedAt: null,
      });
      const saved = await this.trades(manager).findOneByOrFail({
        id: trade.id,
      });
      await this.record(
        manager,
        actor,
        AuditAction.PLAYER_TRADE_OFFER_UPDATED,
        saved,
        {
          actorCharacterId: link.characterExternalId,
          side,
          status: saved.status,
          offerVersion: version,
          gold: offer.gold,
          itemCount: offer.items.length,
        },
        200,
      );
      events.push({
        type: 'TRADE_OFFER_UPDATED',
        data: this.data(saved, { side, offerVersion: version }),
        playerIds: await this.recipients(manager, saved),
      });
      return (await this.views(manager, [saved], actor))[0];
    });
  }
  // Accepts the counterparty's offer at counterpartyOfferVersion. The second
  // acceptance
  // reserves GOLD in escrow and either completes a currency-only trade or
  // waits for the Agent when GAME_ITEM lines exist.
  async accept(
    actor: PlayerActor,
    key: string | undefined,
    tradeId: string,
    input: { characterLinkId: string; counterpartyOfferVersion: number },
  ): Promise<TradeDto> {
    const idempotency = idempotencyKey(key);
    return this.mutate(async (manager, events) => {
      const replay = await this.claim(
        manager,
        actor,
        idempotency,
        Op.ACCEPT,
        {
          tradeId,
          characterLinkId: input.characterLinkId,
          counterpartyOfferVersion: input.counterpartyOfferVersion,
        },
        isUUID(tradeId) ? tradeId : randomUUID(),
      );
      if (replay)
        return this.replayed(manager, actor, replay, input.characterLinkId);
      const trade = await this.lockTrade(manager, tradeId);
      const link = await this.ownLink(manager, actor, input.characterLinkId);
      const side = this.sideOf(trade, link);
      if (trade.status !== TradeStatus.NEGOTIATING)
        throw new ConflictException('Trade is not negotiating');
      const offerOf = await this.offers(manager, [trade.id]);
      const offers = [
        offerOf(trade.id, TradeSide.INITIATOR),
        offerOf(trade.id, TradeSide.TARGET),
      ];
      if (
        offerOf(trade.id, otherSide(side)).version !==
        input.counterpartyOfferVersion
      )
        throw new ConflictException(
          'Offer changed; review it and accept again',
        );
      const accepted =
        side === TradeSide.INITIATOR
          ? trade.initiatorAcceptedAt
          : trade.targetAcceptedAt;
      // Already accepted (acceptances reset on every offer change): no-op.
      if (accepted) return (await this.views(manager, [trade], actor))[0];
      const now = new Date();
      const patch: Partial<PlayerTrade> =
        side === TradeSide.INITIATOR
          ? { initiatorAcceptedAt: now }
          : { targetAcceptedAt: now };
      const both =
        (side === TradeSide.INITIATOR
          ? trade.targetAcceptedAt
          : trade.initiatorAcceptedAt) !== null;
      const gold = offers.reduce((sum, o) => sum + o.goldAmount, 0);
      const itemCount = offers.reduce((sum, o) => sum + o.items.length, 0);
      const followUps: PendingTradeEvent['type'][] = [];
      if (both) {
        if (!gold && !itemCount)
          throw new ConflictException('Trade has no assets');
        // Both parties must still have an ACTIVE current owner.
        const owners = await this.owners(manager, trade.gameServerId, [
          trade.initiatorCharacterId,
          trade.targetCharacterId,
        ]);
        for (const id of [trade.initiatorCharacterId, trade.targetCharacterId])
          if (owners.get(id)?.player.status !== PlayerStatus.ACTIVE)
            throw new ConflictException('Trade party unavailable');
        patch.lockedAt = now;
        await this.escrow.reserve(manager, trade, offers, actor);
        if (itemCount) {
          patch.status = TradeStatus.AWAITING_GAME_CONFIRMATION;
          followUps.push('TRADE_AWAITING_GAME_CONFIRMATION');
        } else {
          await this.escrow.settle(manager, trade, actor);
          patch.status = TradeStatus.COMPLETED;
          patch.completedAt = now;
          followUps.push('TRADE_COMPLETED');
        }
      }
      await this.trades(manager).update(trade.id, patch);
      const saved = await this.trades(manager).findOneByOrFail({
        id: trade.id,
      });
      await this.record(
        manager,
        actor,
        AuditAction.PLAYER_TRADE_ACCEPTED,
        saved,
        {
          actorCharacterId: link.characterExternalId,
          side,
          status: saved.status,
          counterpartyOfferVersion: input.counterpartyOfferVersion,
          initiatorGold: offers[0].goldAmount,
          targetGold: offers[1].goldAmount,
          itemCount,
        },
        200,
      );
      const playerIds = await this.recipients(manager, saved);
      events.push(
        {
          type: 'TRADE_ACCEPTED',
          data: this.data(saved, {
            side,
            counterpartyOfferVersion: input.counterpartyOfferVersion,
          }),
          playerIds,
        },
        ...followUps.map((type) => ({
          type,
          data: this.data(saved),
          playerIds,
        })),
      );
      return (await this.views(manager, [saved], actor))[0];
    });
  }
  // NEGOTIATING only. CANCELLED again is a no-op; awaiting the Agent or
  // finished trades return 409.
  async cancel(
    actor: PlayerActor,
    key: string | undefined,
    tradeId: string,
    characterLinkId: string,
  ): Promise<TradeDto> {
    const idempotency = idempotencyKey(key);
    return this.mutate(async (manager, events) => {
      const replay = await this.claim(
        manager,
        actor,
        idempotency,
        Op.CANCEL,
        [tradeId, characterLinkId],
        isUUID(tradeId) ? tradeId : randomUUID(),
      );
      if (replay) return this.replayed(manager, actor, replay, characterLinkId);
      const trade = await this.lockTrade(manager, tradeId);
      const link = await this.ownLink(manager, actor, characterLinkId);
      const side = this.sideOf(trade, link);
      if (trade.status === TradeStatus.CANCELLED)
        return (await this.views(manager, [trade], actor))[0];
      if (trade.status === TradeStatus.AWAITING_GAME_CONFIRMATION)
        throw new ConflictException(
          'Trade is awaiting game confirmation and cannot be cancelled',
        );
      if (trade.status !== TradeStatus.NEGOTIATING)
        throw new ConflictException('Trade already finished');
      await this.trades(manager).update(trade.id, {
        status: TradeStatus.CANCELLED,
        cancelledAt: new Date(),
      });
      const saved = await this.trades(manager).findOneByOrFail({
        id: trade.id,
      });
      await this.record(
        manager,
        actor,
        AuditAction.PLAYER_TRADE_CANCELLED,
        saved,
        {
          actorCharacterId: link.characterExternalId,
          side,
          status: saved.status,
        },
        200,
      );
      events.push({
        type: 'TRADE_CANCELLED',
        data: this.data(saved, { side }),
        playerIds: await this.recipients(manager, saved),
      });
      return (await this.views(manager, [saved], actor))[0];
    });
  }
  async get(
    actor: PlayerActor,
    tradeId: string,
    characterLinkId: string,
  ): Promise<TradeDto> {
    if (!isUUID(tradeId)) throw tradeNotFound();
    const manager = this.database.manager;
    const link = await this.ownLink(manager, actor, characterLinkId);
    const trade = await this.trades(manager).findOneBy({ id: tradeId });
    if (!trade) throw tradeNotFound();
    this.sideOf(trade, link);
    return this.view(manager, trade.id, actor);
  }
  async list(
    actor: PlayerActor,
    characterLinkId: string,
    query: TradeListQueryDto,
  ) {
    const manager = this.database.manager;
    const link = await this.ownLink(manager, actor, characterLinkId);
    const [trades, total] = await this.trades(manager)
      .createQueryBuilder('trade')
      .where('trade.gameServerId = :server', { server: link.gameServerId })
      .andWhere(
        '(trade.initiatorCharacterId = :character OR trade.targetCharacterId = :character)',
        { character: link.characterExternalId },
      )
      .orderBy('trade.createdAt', 'DESC')
      .addOrderBy('trade.id', 'DESC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();
    return pageResult(await this.views(manager, trades, actor), total, query);
  }
}
