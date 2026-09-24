import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import type { Actor } from '../actors/actor.contracts.js';
import { EconomyLedgerService } from '../economy/economy-ledger.service.js';
import type { LedgerLeg } from '../economy/economy-ledger.service.js';
import {
  Currency,
  EconomyOwnerType,
  EconomyTransactionType,
  SystemAccountKey,
} from '../economy/economy.contracts.js';
import { PlayerTradeCurrencyEscrow } from './entities/player-trade-currency-escrow.entity.js';
import type { PlayerTrade } from './entities/player-trade.entity.js';
import type { PlayerTradeOffer } from './entities/player-trade-offer.entity.js';
import {
  EscrowStatus,
  TRADE_REFERENCE_TYPE,
  TradeSide,
} from './player-trade.contracts.js';

const escrowAccount = {
  account: {
    ownerType: EconomyOwnerType.SYSTEM,
    systemKey: SystemAccountKey.TRADE_ESCROW,
  },
} as const;
const character = (characterExternalId: string) =>
  ({ ownerType: EconomyOwnerType.CHARACTER, characterExternalId }) as const;

// GOLD custody for trades. Every call runs inside the caller's trade
// transaction (after the trade row lock), so ledger postings, escrow rows and
// the trade state commit or roll back together. Ledger keys are derived from
// the trade, one per phase, so a phase can never be posted twice.
@Injectable()
export class TradeEscrowService {
  constructor(
    private readonly database: DataSource,
    private readonly ledger: EconomyLedgerService,
  ) {}
  private escrows(manager: EntityManager) {
    return manager.getRepository<PlayerTradeCurrencyEscrow>(
      'PlayerTradeCurrencyEscrow',
    );
  }
  partyOf(trade: PlayerTrade, side: TradeSide) {
    return side === TradeSide.INITIATOR
      ? trade.initiatorCharacterId
      : trade.targetCharacterId;
  }
  // Each side's GOLD -> TRADE_ESCROW in one balanced transaction; throws
  // LedgerRejectionError (e.g. INSUFFICIENT_FUNDS) to abort the caller.
  async reserve(
    manager: EntityManager,
    trade: PlayerTrade,
    offers: PlayerTradeOffer[],
    actor: Actor,
  ): Promise<void> {
    const contributions = offers
      .filter((offer) => offer.goldAmount > 0)
      .map((offer) => ({
        characterExternalId: this.partyOf(trade, offer.side),
        amount: offer.goldAmount,
      }));
    if (!contributions.length) return;
    const total = contributions.reduce((sum, c) => sum + c.amount, 0);
    const { transactionId } = await this.ledger.postWithin(manager, {
      gameServerId: trade.gameServerId,
      currency: Currency.GOLD,
      type: EconomyTransactionType.TRANSFER,
      actor,
      idempotencyKey: `trade:${trade.id}:reserve`,
      reference: { type: TRADE_REFERENCE_TYPE, id: trade.id },
      legs: [
        ...contributions.map((c): LedgerLeg => ({
          account: character(c.characterExternalId),
          amount: -c.amount,
        })),
        { ...escrowAccount, amount: total },
      ],
    });
    await this.escrows(manager).insert(
      contributions.map((c) => ({
        tradeId: trade.id,
        gameServerId: trade.gameServerId,
        currency: Currency.GOLD,
        characterExternalId: c.characterExternalId,
        amount: c.amount,
        status: EscrowStatus.RESERVED,
        reservationTransactionId: transactionId,
        resolutionTransactionId: null,
      })),
    );
  }
  // TRADE_ESCROW -> the counterparty of each contribution.
  settle(manager: EntityManager, trade: PlayerTrade, actor: Actor) {
    return this.resolve(manager, trade, actor, EscrowStatus.SETTLED);
  }
  // TRADE_ESCROW -> back to each contributor.
  release(manager: EntityManager, trade: PlayerTrade, actor: Actor) {
    return this.resolve(manager, trade, actor, EscrowStatus.RELEASED);
  }
  private async resolve(
    manager: EntityManager,
    trade: PlayerTrade,
    actor: Actor,
    status: EscrowStatus.SETTLED | EscrowStatus.RELEASED,
  ): Promise<void> {
    const reserved = await this.escrows(manager).find({
      where: { tradeId: trade.id, status: EscrowStatus.RESERVED },
      lock: { mode: 'pessimistic_write' },
    });
    if (!reserved.length) return;
    const counterparty = (id: string) =>
      id === trade.initiatorCharacterId
        ? trade.targetCharacterId
        : trade.initiatorCharacterId;
    const credited = new Map<string, number>();
    for (const escrow of reserved) {
      const to =
        status === EscrowStatus.SETTLED
          ? counterparty(escrow.characterExternalId)
          : escrow.characterExternalId;
      credited.set(to, (credited.get(to) ?? 0) + escrow.amount);
    }
    const total = reserved.reduce((sum, e) => sum + e.amount, 0);
    const phase = status === EscrowStatus.SETTLED ? 'settle' : 'release';
    const { transactionId } = await this.ledger.postWithin(manager, {
      gameServerId: trade.gameServerId,
      currency: Currency.GOLD,
      type: EconomyTransactionType.TRANSFER,
      actor,
      idempotencyKey: `trade:${trade.id}:${phase}`,
      reference: { type: TRADE_REFERENCE_TYPE, id: trade.id },
      legs: [
        { ...escrowAccount, amount: -total },
        ...[...credited].map(([id, amount]): LedgerLeg => ({
          account: character(id),
          amount,
        })),
      ],
    });
    await this.escrows(manager).update(
      reserved.map((e) => e.id),
      { status, resolutionTransactionId: transactionId },
    );
  }
  // Internal check (no HTTP route): TRADE_ESCROW balance equals the RESERVED
  // escrows per server, and RESERVED escrows exist only on locked,
  // unfinished trades.
  async mismatches(): Promise<
    { gameServerId: string; balance: number; reserved: number }[]
  > {
    const rows: { server: string; balance: string; reserved: string }[] =
      await this.database.query(`
        SELECT s.id AS server,
               coalesce((SELECT balance FROM economy_accounts a WHERE a.game_server_id = s.id AND a.currency = 'GOLD' AND a.system_key = 'TRADE_ESCROW'), 0) AS balance,
               coalesce((SELECT sum(amount) FROM player_trade_currency_escrows e WHERE e.game_server_id = s.id AND e.currency = 'GOLD' AND e.status = 'RESERVED'), 0) AS reserved
          FROM game_servers s`);
    return rows
      .filter((r) => Number(r.balance) !== Number(r.reserved))
      .map((r) => ({
        gameServerId: r.server,
        balance: Number(r.balance),
        reserved: Number(r.reserved),
      }));
  }
  async orphanReservations(): Promise<string[]> {
    const rows: { id: string }[] = await this.database.query(`
      SELECT e.id FROM player_trade_currency_escrows e
        JOIN player_trades t ON t.id = e.trade_id
       WHERE e.status = 'RESERVED' AND t.status <> 'AWAITING_GAME_CONFIRMATION'`);
    return rows.map((r) => r.id);
  }
}
