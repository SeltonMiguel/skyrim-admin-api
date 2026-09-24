import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import type { Actor } from '../actors/actor.contracts.js';
import { EconomyLedgerService } from '../economy/economy-ledger.service.js';
import { EconomyReconciliationService } from '../economy/economy-reconciliation.service.js';
import {
  Currency,
  EconomyOwnerType,
  EconomyTransactionType,
  SystemAccountKey,
} from '../economy/economy.contracts.js';
import { PlayerMarketplaceCurrencyEscrow } from './entities/player-marketplace-currency-escrow.entity.js';
import type { PlayerMarketplaceListing } from './entities/player-marketplace-listing.entity.js';
import type { PlayerMarketplacePurchase } from './entities/player-marketplace-purchase.entity.js';
import {
  MARKET_REFERENCE_TYPE,
  MarketEscrowStatus,
} from './player-marketplace.contracts.js';

const escrowAccount = {
  account: {
    ownerType: EconomyOwnerType.SYSTEM,
    systemKey: SystemAccountKey.MARKET_ESCROW,
  },
} as const;
const character = (characterExternalId: string) =>
  ({ ownerType: EconomyOwnerType.CHARACTER, characterExternalId }) as const;

// GOLD custody for purchases. Every call runs inside the caller's
// transaction (after the listing and purchase locks), so ledger postings,
// the escrow row and the listing/purchase states commit or roll back
// together. Ledger keys are derived from the purchase, one per phase, so a
// phase can never be posted twice.
@Injectable()
export class MarketEscrowService {
  constructor(
    private readonly database: DataSource,
    private readonly ledger: EconomyLedgerService,
    private readonly reconciliation: EconomyReconciliationService,
  ) {}
  private escrows(manager: EntityManager) {
    return manager.getRepository<PlayerMarketplaceCurrencyEscrow>(
      'PlayerMarketplaceCurrencyEscrow',
    );
  }
  // Buyer GOLD -> MARKET_ESCROW plus the one RESERVED row of the purchase;
  // throws LedgerRejectionError (e.g. INSUFFICIENT_FUNDS) to abort the caller.
  async reserve(
    manager: EntityManager,
    listing: PlayerMarketplaceListing,
    purchase: Pick<PlayerMarketplacePurchase, 'id' | 'buyerCharacterId'>,
    actor: Actor,
  ): Promise<void> {
    const { transactionId } = await this.ledger.postWithin(manager, {
      gameServerId: listing.gameServerId,
      currency: Currency.GOLD,
      type: EconomyTransactionType.TRANSFER,
      actor,
      idempotencyKey: `market:${purchase.id}:reserve`,
      reference: { type: MARKET_REFERENCE_TYPE, id: purchase.id },
      legs: [
        {
          account: character(purchase.buyerCharacterId),
          amount: -listing.priceGold,
        },
        { ...escrowAccount, amount: listing.priceGold },
      ],
    });
    await this.escrows(manager).insert({
      purchaseId: purchase.id,
      gameServerId: listing.gameServerId,
      currency: Currency.GOLD,
      buyerCharacterId: purchase.buyerCharacterId,
      sellerCharacterId: listing.sellerCharacterId,
      amount: listing.priceGold,
      status: MarketEscrowStatus.RESERVED,
      reservationTransactionId: transactionId,
      resolutionTransactionId: null,
    });
  }
  // MARKET_ESCROW -> the seller character identity.
  settle(manager: EntityManager, purchaseId: string, actor: Actor) {
    return this.resolve(manager, purchaseId, actor, MarketEscrowStatus.SETTLED);
  }
  // MARKET_ESCROW -> back to the buyer character identity.
  release(manager: EntityManager, purchaseId: string, actor: Actor) {
    return this.resolve(
      manager,
      purchaseId,
      actor,
      MarketEscrowStatus.RELEASED,
    );
  }
  private async resolve(
    manager: EntityManager,
    purchaseId: string,
    actor: Actor,
    status: MarketEscrowStatus.SETTLED | MarketEscrowStatus.RELEASED,
  ): Promise<void> {
    const escrow = await this.escrows(manager).findOne({
      where: { purchaseId, status: MarketEscrowStatus.RESERVED },
      lock: { mode: 'pessimistic_write' },
    });
    // The caller holds the purchase lock and checked it is AWAITING.
    if (!escrow) throw new Error('Marketplace escrow missing');
    const settled = status === MarketEscrowStatus.SETTLED;
    const { transactionId } = await this.ledger.postWithin(manager, {
      gameServerId: escrow.gameServerId,
      currency: escrow.currency,
      type: EconomyTransactionType.TRANSFER,
      actor,
      idempotencyKey: `market:${purchaseId}:${settled ? 'settle' : 'release'}`,
      reference: { type: MARKET_REFERENCE_TYPE, id: purchaseId },
      legs: [
        { ...escrowAccount, amount: -escrow.amount },
        {
          account: character(
            settled ? escrow.sellerCharacterId : escrow.buyerCharacterId,
          ),
          amount: escrow.amount,
        },
      ],
    });
    await this.escrows(manager).update(escrow.id, {
      status,
      resolutionTransactionId: transactionId,
    });
  }
  // Internal check (no HTTP route): MARKET_ESCROW balance equals the RESERVED
  // escrows of each server. There is no transitional state: reservation and
  // resolution commit together with the listing and purchase changes.
  async mismatches(): Promise<
    { gameServerId: string; balance: number; reserved: number }[]
  > {
    const balances = await this.reconciliation.systemBalances(
      SystemAccountKey.MARKET_ESCROW,
    );
    const rows: { server: string; reserved: string }[] = await this.database
      .query(`
        SELECT game_server_id AS server, sum(amount) AS reserved
          FROM player_marketplace_currency_escrows
         WHERE currency = 'GOLD' AND status = 'RESERVED'
         GROUP BY game_server_id`);
    const reserved = new Map(rows.map((r) => [r.server, Number(r.reserved)]));
    return [...balances]
      .map(([gameServerId, balance]) => ({
        gameServerId,
        balance,
        reserved: reserved.get(gameServerId) ?? 0,
      }))
      .filter((r) => r.balance !== r.reserved);
  }
  // Listings whose listing/purchase/escrow triple is incoherent: RESERVED ↔
  // AWAITING ↔ RESERVED, SOLD ↔ COMPLETED ↔ SETTLED, FAILED ↔ FAILED ↔
  // RELEASED, with matching parties and amount.
  async inconsistencies(): Promise<string[]> {
    const rows: { id: string }[] = await this.database.query(`
      SELECT l.id FROM player_marketplace_listings l
        LEFT JOIN player_marketplace_purchases p ON p.listing_id = l.id
        LEFT JOIN player_marketplace_currency_escrows e ON e.purchase_id = p.id
       WHERE (p.id IS NULL AND l.status IN ('RESERVED', 'SOLD'))
          OR (p.id IS NOT NULL AND (e.id IS NULL OR NOT (
                (l.status, p.status, e.status) IN (('RESERVED', 'AWAITING_GAME_CONFIRMATION', 'RESERVED'), ('SOLD', 'COMPLETED', 'SETTLED'), ('FAILED', 'FAILED', 'RELEASED'))
                AND e.amount = l.price_gold
                AND e.game_server_id = l.game_server_id
                AND e.seller_character_id = l.seller_character_id
                AND e.buyer_character_id = p.buyer_character_id
                AND l.reserved_by_character_id IS NOT DISTINCT FROM p.buyer_character_id)))`);
    return rows.map((r) => r.id);
  }
}
