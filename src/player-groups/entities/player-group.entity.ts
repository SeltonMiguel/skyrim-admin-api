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
import type { GroupStatus } from '../player-group.contracts.js';

// Temporary party on one game server. Members are ownership links, so a new
// owner of a character never inherits a group.
@Entity('player_groups')
@Index('player_groups_server_idx', ['gameServerId', 'status'])
@Check('player_groups_status_check', `status IN ('ACTIVE', 'DISBANDED')`)
@Check(
  'player_groups_disbanded_check',
  `(status = 'DISBANDED') = (disbanded_at IS NOT NULL)`,
)
export class PlayerGroup {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'game_server_id', type: 'uuid' })
  gameServerId: string;
  @ManyToOne(() => GameServer)
  @JoinColumn({
    name: 'game_server_id',
    foreignKeyConstraintName: 'player_groups_server_fkey',
  })
  gameServer: Relation<GameServer>;
  @Column({ type: 'varchar', length: 16, default: 'ACTIVE' })
  status: GroupStatus;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
  @Column({ name: 'disbanded_at', type: 'timestamptz', nullable: true })
  disbandedAt: Date | null;
}
