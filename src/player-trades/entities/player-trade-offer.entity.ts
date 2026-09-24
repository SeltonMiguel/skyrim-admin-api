import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';
import { bigintColumn } from '../../economy/economy.contracts.js';
import type { TradeSide } from '../player-trade.contracts.js';
import { PlayerTrade } from './player-trade.entity.js';
import { PlayerTradeItem } from './player-trade-item.entity.js';

// One offer per side. version grows on every change; a trigger freezes the
// offer (and its items) once the trade leaves NEGOTIATING.
@Entity('player_trade_offers')
@Unique('player_trade_offers_side_key', ['tradeId', 'side'])
@Check('player_trade_offers_side_check', `side IN ('INITIATOR', 'TARGET')`)
@Check(
  'player_trade_offers_gold_check',
  `gold_amount BETWEEN 0 AND 1000000000000`,
)
@Check('player_trade_offers_version_check', `version >= 1`)
export class PlayerTradeOffer {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'trade_id', type: 'uuid' })
  tradeId: string;
  @ManyToOne(() => PlayerTrade)
  @JoinColumn({
    name: 'trade_id',
    foreignKeyConstraintName: 'player_trade_offers_trade_fkey',
  })
  trade: Relation<PlayerTrade>;
  @Column({ type: 'varchar', length: 16 })
  side: TradeSide;
  @Column({
    name: 'gold_amount',
    type: 'bigint',
    default: 0,
    transformer: bigintColumn,
  })
  goldAmount: number;
  @Column({ type: 'integer', default: 1 })
  version: number;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
  @OneToMany(() => PlayerTradeItem, (item) => item.offer)
  items: Relation<PlayerTradeItem[]>;
}
