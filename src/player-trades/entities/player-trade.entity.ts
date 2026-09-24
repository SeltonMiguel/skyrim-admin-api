import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';
import { GameServer } from '../../game-bridge/entities/game-server.entity.js';
import type { TradeStatus } from '../player-trade.contracts.js';

// A trade between two character identities of one server (never ownership
// links). Forward-only transitions and history are enforced by a trigger.
@Entity('player_trades')
@Index('player_trades_initiator_idx', [
  'gameServerId',
  'initiatorCharacterId',
  'createdAt',
])
@Index('player_trades_target_idx', [
  'gameServerId',
  'targetCharacterId',
  'createdAt',
])
@Check(
  'player_trades_parties_check',
  `initiator_character_id <> target_character_id AND length(btrim(initiator_character_id)) > 0 AND length(btrim(target_character_id)) > 0`,
)
@Check(
  'player_trades_status_check',
  `status IN ('NEGOTIATING', 'AWAITING_GAME_CONFIRMATION', 'COMPLETED', 'CANCELLED', 'FAILED')`,
)
@Check(
  'player_trades_lifecycle_check',
  `(status = 'NEGOTIATING' AND locked_at IS NULL AND completed_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL) OR (status = 'AWAITING_GAME_CONFIRMATION' AND initiator_accepted_at IS NOT NULL AND target_accepted_at IS NOT NULL AND locked_at IS NOT NULL AND completed_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL) OR (status = 'COMPLETED' AND initiator_accepted_at IS NOT NULL AND target_accepted_at IS NOT NULL AND locked_at IS NOT NULL AND completed_at IS NOT NULL AND cancelled_at IS NULL AND failed_at IS NULL) OR (status = 'CANCELLED' AND locked_at IS NULL AND cancelled_at IS NOT NULL AND completed_at IS NULL AND failed_at IS NULL) OR (status = 'FAILED' AND locked_at IS NOT NULL AND failed_at IS NOT NULL AND completed_at IS NULL AND cancelled_at IS NULL)`,
)
export class PlayerTrade {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'game_server_id', type: 'uuid' })
  gameServerId: string;
  @ManyToOne(() => GameServer)
  @JoinColumn({
    name: 'game_server_id',
    foreignKeyConstraintName: 'player_trades_server_fkey',
  })
  gameServer: Relation<GameServer>;
  @Column({ name: 'initiator_character_id', type: 'varchar', length: 128 })
  initiatorCharacterId: string;
  @Column({ name: 'target_character_id', type: 'varchar', length: 128 })
  targetCharacterId: string;
  @Column({ type: 'varchar', length: 32, default: 'NEGOTIATING' })
  status: TradeStatus;
  @Column({
    name: 'initiator_accepted_at',
    type: 'timestamptz',
    nullable: true,
  })
  initiatorAcceptedAt: Date | null;
  @Column({ name: 'target_accepted_at', type: 'timestamptz', nullable: true })
  targetAcceptedAt: Date | null;
  @Column({ name: 'locked_at', type: 'timestamptz', nullable: true })
  lockedAt: Date | null;
  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;
  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt: Date | null;
  @Column({ name: 'failed_at', type: 'timestamptz', nullable: true })
  failedAt: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
