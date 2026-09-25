import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type {
  AgentWorkAfter,
  AgentWorkRow,
} from '../actors/agent-event.contracts.js';
import {
  TradeAssetType,
  TradeSide,
  TradeStatus,
} from './player-trade.contracts.js';

// Read-only projection of the physical work a trade needs from the Host
// Agent (Etapa 11.4): every AWAITING_GAME_CONFIRMATION trade of the server,
// with the GAME_ITEM lines each side gives. Never GOLD, which stays on the
// backend ledger. Ordered by the lock instant (the AWAITING transition).
@Injectable()
export class TradeWorkSource {
  constructor(private readonly database: DataSource) {}
  async pending(
    gameServerId: string,
    after: AgentWorkAfter | null,
    limit: number,
  ): Promise<AgentWorkRow[]> {
    const trades: {
      id: string;
      pos: string;
      created_at: Date;
      initiator_character_id: string;
      target_character_id: string;
    }[] = await this.database.query(
      `SELECT t.id, (extract(epoch FROM t.locked_at) * 1000000)::bigint::text AS pos,
              t.locked_at AS created_at, t.initiator_character_id, t.target_character_id
       FROM player_trades t
       WHERE t.game_server_id = $1 AND t.status = $2
         AND ($3::bigint IS NULL OR ((extract(epoch FROM t.locked_at) * 1000000)::bigint, t.id) > ($3::bigint, $4::uuid))
       ORDER BY t.locked_at, t.id
       LIMIT $5`,
      [
        gameServerId,
        TradeStatus.AWAITING_GAME_CONFIRMATION,
        after?.pos ?? null,
        after?.id ?? null,
        limit,
      ],
    );
    if (!trades.length) return [];
    const items: {
      trade_id: string;
      side: TradeSide;
      item_external_id: string;
      quantity: number;
    }[] = await this.database.query(
      `SELECT o.trade_id, o.side, i.item_external_id, i.quantity
       FROM player_trade_offers o JOIN player_trade_items i ON i.offer_id = o.id
       WHERE o.trade_id = ANY($1::uuid[])
       ORDER BY i.item_external_id`,
      [trades.map((t) => t.id)],
    );
    const lines = (tradeId: string, side: TradeSide) =>
      items
        .filter((i) => i.trade_id === tradeId && i.side === side)
        .map((i) => ({
          type: TradeAssetType.GAME_ITEM,
          itemExternalId: i.item_external_id,
          quantity: i.quantity,
        }));
    return trades.map((t) => ({
      id: t.id,
      pos: t.pos,
      createdAt: t.created_at,
      data: {
        tradeId: t.id,
        initiatorCharacterId: t.initiator_character_id,
        targetCharacterId: t.target_character_id,
        // What each side hands over; the counterpart receives it.
        initiatorItems: lines(t.id, TradeSide.INITIATOR),
        targetItems: lines(t.id, TradeSide.TARGET),
      },
    }));
  }
}
