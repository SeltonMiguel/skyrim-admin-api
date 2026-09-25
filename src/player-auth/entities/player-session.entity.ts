import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';
import { Player } from '../../player-accounts/entities/player.entity.js';

// Separate from staff_sessions. Stores only a SHA-256 digest of the current
// refresh token; no provider token, IP address or user agent.
@Entity('player_sessions')
@Index('player_sessions_player_idx', ['playerId'])
@Check(
  'player_sessions_refresh_hash_check',
  `refresh_token_hash ~ '^[0-9a-f]{64}$'`,
)
@Check('player_sessions_expiry_check', `expires_at > created_at`)
export class PlayerSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'player_id', type: 'uuid' })
  playerId: string;
  @ManyToOne(() => Player)
  @JoinColumn({
    name: 'player_id',
    foreignKeyConstraintName: 'player_sessions_player_fkey',
  })
  player: Relation<Player>;
  @Column({
    name: 'refresh_token_hash',
    type: 'varchar',
    length: 64,
    select: false,
  })
  refreshTokenHash: string;
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;
  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;
  @Column({ name: 'last_used_at', type: 'timestamptz', nullable: true })
  lastUsedAt: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
