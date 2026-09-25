import { Injectable, Logger } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { QueryFailedError } from 'typeorm';
import { AuditAction } from '../audit/audit.types.js';
import { systemActor, SystemSource } from '../actors/actor.contracts.js';
import { externalId } from '../game-bridge/command-validation.js';
import { LedgerRejectionError } from '../economy/economy-ledger.service.js';
import type { PlayerTradeSettlementEvent } from './entities/player-trade-settlement-event.entity.js';
import { PlayerTradeService } from './player-trade.service.js';
import { TradeEscrowService } from './trade-escrow.service.js';
import {
  SettlementOutcome,
  TradeSide,
  TradeStatus,
} from './player-trade.contracts.js';
import type { SettlementResult } from './player-trade.contracts.js';

const reject = (
  reason: Extract<SettlementResult, { outcome: 'REJECTED' }>['reason'],
): SettlementResult => ({ outcome: 'REJECTED', reason });
const finalStatus = (outcome: SettlementOutcome) =>
  outcome === SettlementOutcome.SETTLED
    ? TradeStatus.COMPLETED
    : TradeStatus.FAILED;

// Trusted internal contract for the Agent transport (Etapa 11); there is no
// HTTP route. Idempotent per settlementEventId.
//
// SETTLED does NOT mean the items were irreversibly delivered. The Agent may
// send it only after validating the GAME_ITEM lines and holding them in
// durable, reversible custody from which it can retry delivery or release
// them. This commit is the authority that finalizes the trade: on success
// GOLD is settled and the trade COMPLETED (the Agent then delivers); if the
// ledger refuses (e.g. BALANCE_LIMIT) the trade stays AWAITING and the Agent
// must keep custody, retry later or report FAILED. FAILED releases GOLD.
@Injectable()
export class TradeSettlementService {
  private readonly logger = new Logger(TradeSettlementService.name);
  constructor(
    private readonly trades: PlayerTradeService,
    private readonly escrow: TradeEscrowService,
  ) {}
  async confirmFromAgent(
    input: {
      tradeId: string;
      settlementEventId: string;
      outcome: SettlementOutcome;
    },
    retried = false,
  ): Promise<SettlementResult> {
    let eventId: string;
    try {
      eventId = externalId(input.settlementEventId);
    } catch {
      return reject('INVALID_INPUT');
    }
    if (
      !isUUID(input.tradeId) ||
      !Object.values(SettlementOutcome).includes(input.outcome)
    )
      return reject('INVALID_INPUT');
    const agent = systemActor(SystemSource.AGENT);
    try {
      return await this.trades.mutate(async (manager, events) => {
        // Same lock order as the Player API: trade row first.
        const trade = await this.trades.trades(manager).findOne({
          where: { id: input.tradeId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!trade) return reject('TRADE_NOT_FOUND');
        const settlements = manager.getRepository<PlayerTradeSettlementEvent>(
          'PlayerTradeSettlementEvent',
        );
        const existing = await settlements.findOneBy({
          gameServerId: trade.gameServerId,
          settlementEventId: eventId,
        });
        if (existing)
          return existing.tradeId === trade.id &&
            existing.outcome === input.outcome
            ? {
                outcome: 'ALREADY_APPLIED',
                status: finalStatus(input.outcome),
              }
            : reject('EVENT_CONFLICT');
        if (trade.status !== TradeStatus.AWAITING_GAME_CONFIRMATION)
          return reject('TRADE_NOT_AWAITING');
        const now = new Date();
        const status = finalStatus(input.outcome);
        if (input.outcome === SettlementOutcome.SETTLED)
          await this.escrow.settle(manager, trade, agent);
        else await this.escrow.release(manager, trade, agent);
        await this.trades.trades(manager).update(trade.id, {
          status,
          ...(status === TradeStatus.COMPLETED
            ? { completedAt: now }
            : { failedAt: now }),
        });
        await settlements.insert({
          gameServerId: trade.gameServerId,
          settlementEventId: eventId,
          tradeId: trade.id,
          outcome: input.outcome,
        });
        const saved = await this.trades
          .trades(manager)
          .findOneByOrFail({ id: trade.id });
        const offerOf = await this.trades.offers(manager, [trade.id]);
        const offers = [TradeSide.INITIATOR, TradeSide.TARGET].map((side) =>
          offerOf(trade.id, side),
        );
        await this.trades.record(
          manager,
          agent,
          status === TradeStatus.COMPLETED
            ? AuditAction.PLAYER_TRADE_SETTLED
            : AuditAction.PLAYER_TRADE_FAILED,
          saved,
          {
            status,
            settlementEventId: eventId,
            initiatorGold: offers[0].goldAmount,
            targetGold: offers[1].goldAmount,
            itemCount: offers.reduce((sum, o) => sum + o.items.length, 0),
          },
        );
        events.push({
          type:
            status === TradeStatus.COMPLETED
              ? 'TRADE_COMPLETED'
              : 'TRADE_FAILED',
          data: this.trades.data(saved),
          playerIds: await this.trades.recipients(manager, saved),
        });
        return { outcome: 'APPLIED', status };
      }, false);
    } catch (error) {
      // The whole transaction rolled back: the trade stays
      // AWAITING_GAME_CONFIRMATION, escrows stay RESERVED, the event is not
      // recorded (so it can be retried) and nothing is audited or published.
      // The Agent keeps the items in custody and may retry or release them.
      if (error instanceof LedgerRejectionError) {
        this.logger.warn(
          `Trade settlement rejected by the ledger [tradeId=${input.tradeId} reason=${error.reason}]`,
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
