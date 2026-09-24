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
import { Player } from '../../player-accounts/entities/player.entity.js';
import type { TradeRequestOperation } from '../player-trade.contracts.js';
import { PlayerTrade } from './player-trade.entity.js';

// Trade idempotency (scope PLAYER:<playerId>), claimed in the same
// transaction as the mutation; independent from game command idempotency.
// The trade FK is deferred so a create can claim its key first.
@Entity('player_trade_requests')
@Unique('player_trade_requests_idempotency_key', [
  'idempotencyScope',
  'idempotencyKey',
])
@Check(
  'player_trade_requests_scope_check',
  `idempotency_scope = ('PLAYER:' || player_id::text) AND length(idempotency_key) > 0`,
)
@Check(
  'player_trade_requests_operation_check',
  `operation IN ('CREATE', 'OFFER', 'ACCEPT', 'CANCEL')`,
)
export class PlayerTradeRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'idempotency_scope', type: 'varchar', length: 64 })
  idempotencyScope: string;
  @Column({ name: 'idempotency_key', type: 'varchar', length: 128 })
  idempotencyKey: string;
  @Column({ name: 'player_id', type: 'uuid' })
  playerId: string;
  @ManyToOne(() => Player)
  @JoinColumn({
    name: 'player_id',
    foreignKeyConstraintName: 'player_trade_requests_player_fkey',
  })
  player: Relation<Player>;
  @Column({ type: 'varchar', length: 16 })
  operation: TradeRequestOperation;
  @Column({ name: 'request_fingerprint', type: 'char', length: 64 })
  requestFingerprint: string;
  @Column({ name: 'trade_id', type: 'uuid' })
  tradeId: string;
  @ManyToOne(() => PlayerTrade, { deferrable: 'INITIALLY DEFERRED' })
  @JoinColumn({
    name: 'trade_id',
    foreignKeyConstraintName: 'player_trade_requests_trade_fkey',
  })
  trade: Relation<PlayerTrade>;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
