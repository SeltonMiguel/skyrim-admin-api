import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import type { Relation } from 'typeorm';
import type { SettlementOutcome } from '../player-trade.contracts.js';
import { PlayerTrade } from './player-trade.entity.js';

// Trusted Agent confirmation of a GAME_ITEM trade: one per trade, event ids
// unique per server, so replays are detected and conflicts rejected.
@Entity('player_trade_settlement_events')
@Unique('player_trade_settlement_events_event_key', [
  'gameServerId',
  'settlementEventId',
])
@Unique('player_trade_settlement_events_trade_key', ['tradeId'])
@Check(
  'player_trade_settlement_events_outcome_check',
  `outcome IN ('SETTLED', 'FAILED') AND length(btrim(settlement_event_id)) > 0`,
)
export class PlayerTradeSettlementEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'game_server_id', type: 'uuid' })
  gameServerId: string;
  @Column({ name: 'settlement_event_id', type: 'varchar', length: 128 })
  settlementEventId: string;
  @Column({ name: 'trade_id', type: 'uuid' })
  tradeId: string;
  @ManyToOne(() => PlayerTrade)
  @JoinColumn({
    name: 'trade_id',
    foreignKeyConstraintName: 'player_trade_settlement_events_trade_fkey',
  })
  trade: Relation<PlayerTrade>;
  @Column({ type: 'varchar', length: 16 })
  outcome: SettlementOutcome;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
