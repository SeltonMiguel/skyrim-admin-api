import { Injectable, Logger } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { QueryFailedError } from 'typeorm';
import { AuditAction } from '../audit/audit.types.js';
import { systemActor, SystemSource } from '../actors/actor.contracts.js';
import { externalId } from '../game-bridge/command-validation.js';
import { LedgerRejectionError } from '../economy/economy-ledger.service.js';
import type { PlayerMarketplaceSettlementEvent } from './entities/player-marketplace-settlement-event.entity.js';
import { MarketEscrowService } from './market-escrow.service.js';
import { PlayerMarketplaceService } from './player-marketplace.service.js';
import {
  ListingStatus,
  MarketSettlementOutcome,
  PurchaseStatus,
} from './player-marketplace.contracts.js';
import type { MarketSettlementResult } from './player-marketplace.contracts.js';

const reject = (
  reason: Extract<MarketSettlementResult, { outcome: 'REJECTED' }>['reason'],
): MarketSettlementResult => ({ outcome: 'REJECTED', reason });
const finalStatus = (outcome: MarketSettlementOutcome) =>
  outcome === MarketSettlementOutcome.SETTLED
    ? PurchaseStatus.COMPLETED
    : PurchaseStatus.FAILED;

// Trusted internal contract for the Agent transport (Etapa 11); there is no
// HTTP route. Idempotent per settlementEventId.
//
// SETTLED may only be sent while the item is in the Agent's durable,
// reversible custody; it does NOT mean the item already reached the buyer's
// inventory. This commit is the authority: on success MARKET_ESCROW pays
// the seller, the purchase is COMPLETED and the listing SOLD, and the Agent
// then owes a durable, retryable delivery. If the ledger refuses (e.g.
// BALANCE_LIMIT) everything rolls back and stays RESERVED/AWAITING; the
// Agent keeps custody and may retry or report FAILED. FAILED refunds the
// buyer and fails the listing; the Agent returns the item to the seller.
@Injectable()
export class MarketplaceSettlementService {
  private readonly logger = new Logger(MarketplaceSettlementService.name);
  constructor(
    private readonly market: PlayerMarketplaceService,
    private readonly escrow: MarketEscrowService,
  ) {}
  async confirmFromAgent(
    input: {
      purchaseId: string;
      settlementEventId: string;
      outcome: MarketSettlementOutcome;
    },
    retried = false,
  ): Promise<MarketSettlementResult> {
    let eventId: string;
    try {
      eventId = externalId(input.settlementEventId);
    } catch {
      return reject('INVALID_INPUT');
    }
    if (
      !isUUID(input.purchaseId) ||
      !Object.values(MarketSettlementOutcome).includes(input.outcome)
    )
      return reject('INVALID_INPUT');
    const agent = systemActor(SystemSource.AGENT);
    try {
      return await this.market.mutate(async (manager, events) => {
        const found = await this.market
          .purchases(manager)
          .findOneBy({ id: input.purchaseId });
        if (!found) return reject('PURCHASE_NOT_FOUND');
        // Same lock order as the Player API: listing row, then purchase.
        const listing = await this.market.lockListing(manager, found.listingId);
        const purchase = await this.market.purchases(manager).findOneOrFail({
          where: { id: found.id },
          lock: { mode: 'pessimistic_write' },
        });
        const settlements =
          manager.getRepository<PlayerMarketplaceSettlementEvent>(
            'PlayerMarketplaceSettlementEvent',
          );
        const existing = await settlements.findOneBy({
          gameServerId: listing.gameServerId,
          settlementEventId: eventId,
        });
        if (existing)
          return existing.purchaseId === purchase.id &&
            existing.outcome === input.outcome
            ? { outcome: 'ALREADY_APPLIED', status: finalStatus(input.outcome) }
            : reject('EVENT_CONFLICT');
        if (purchase.status !== PurchaseStatus.AWAITING_GAME_CONFIRMATION)
          return reject('PURCHASE_NOT_AWAITING');
        const now = new Date();
        const settled = input.outcome === MarketSettlementOutcome.SETTLED;
        const status = finalStatus(input.outcome);
        if (settled) await this.escrow.settle(manager, purchase.id, agent);
        else await this.escrow.release(manager, purchase.id, agent);
        await this.market
          .purchases(manager)
          .update(
            purchase.id,
            settled ? { status, completedAt: now } : { status, failedAt: now },
          );
        await this.market
          .listings(manager)
          .update(
            listing.id,
            settled
              ? { status: ListingStatus.SOLD, soldAt: now }
              : { status: ListingStatus.FAILED, failedAt: now },
          );
        await settlements.insert({
          gameServerId: listing.gameServerId,
          settlementEventId: eventId,
          purchaseId: purchase.id,
          outcome: input.outcome,
        });
        const saved = await this.market
          .listings(manager)
          .findOneByOrFail({ id: listing.id });
        const parties = {
          purchaseId: purchase.id,
          buyerCharacterId: purchase.buyerCharacterId,
          purchaseStatus: status,
        };
        await this.market.record(
          manager,
          agent,
          settled
            ? AuditAction.PLAYER_MARKETPLACE_PURCHASE_SETTLED
            : AuditAction.PLAYER_MARKETPLACE_PURCHASE_FAILED,
          saved,
          { ...parties, settlementEventId: eventId },
        );
        const both = await this.market.playersOf(manager, saved.gameServerId, [
          saved.sellerCharacterId,
          purchase.buyerCharacterId,
        ]);
        const data = this.market.data(saved, parties);
        if (settled)
          events.push({
            type: 'MARKETPLACE_LISTING_SOLD',
            data,
            playerIds: both,
          });
        else
          events.push(
            { type: 'MARKETPLACE_PURCHASE_FAILED', data, playerIds: both },
            {
              type: 'MARKETPLACE_LISTING_FAILED',
              data: this.market.data(saved),
              playerIds: await this.market.playersOf(
                manager,
                saved.gameServerId,
                [saved.sellerCharacterId],
              ),
            },
          );
        return { outcome: 'APPLIED', status };
      }, false);
    } catch (error) {
      // The whole transaction rolled back: the purchase stays
      // AWAITING_GAME_CONFIRMATION, the listing and escrow stay RESERVED, the
      // event is not recorded (so it can be retried) and nothing is audited
      // or published. The Agent keeps the item in custody.
      if (error instanceof LedgerRejectionError) {
        this.logger.warn(
          `Marketplace settlement rejected by the ledger [purchaseId=${input.purchaseId} reason=${error.reason}]`,
        );
        return {
          outcome: 'REJECTED',
          reason: 'LEDGER_REJECTED',
          ledgerReason: error.reason,
        };
      }
      // A concurrent confirmation won the unique event key: read it back.
      if (
        !retried &&
        error instanceof QueryFailedError &&
        (error.driverError as { code?: string }).code === '23505'
      )
        return this.confirmFromAgent(input, true);
      throw error;
    }
  }
}
