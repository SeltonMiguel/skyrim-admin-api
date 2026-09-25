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
import { GameServer } from '../../game-bridge/entities/game-server.entity.js';
import { StaffUser } from '../../staff/entities/staff-user.entity.js';
import type { AgentCredentialStatus } from '../agent-credential.contracts.js';

// Host Agent credential of exactly one GameServer. Only the SHA-256 of the
// secret is stored; a trigger keeps identity and hash immutable, allows only
// ACTIVE -> REVOKED once and forbids DELETE (history).
@Entity('game_agent_credentials')
@Index('game_agent_credentials_server_idx', ['gameServerId', 'status'])
@Check('game_agent_credentials_hash_check', `secret_hash ~ '^[0-9a-f]{64}$'`)
@Check(
  'game_agent_credentials_status_check',
  `(status = 'ACTIVE' AND revoked_at IS NULL) OR (status = 'REVOKED' AND revoked_at IS NOT NULL)`,
)
export class GameAgentCredential {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'game_server_id', type: 'uuid' })
  gameServerId: string;
  @ManyToOne(() => GameServer)
  @JoinColumn({
    name: 'game_server_id',
    foreignKeyConstraintName: 'game_agent_credentials_server_fkey',
  })
  gameServer: Relation<GameServer>;
  @Column({ name: 'secret_hash', type: 'char', length: 64 })
  secretHash: string;
  @Column({ type: 'varchar', length: 16, default: 'ACTIVE' })
  status: AgentCredentialStatus;
  @Column({ name: 'created_by_staff_id', type: 'uuid', nullable: true })
  createdByStaffId: string | null;
  @ManyToOne(() => StaffUser)
  @JoinColumn({
    name: 'created_by_staff_id',
    foreignKeyConstraintName: 'game_agent_credentials_created_by_fkey',
  })
  createdBy: Relation<StaffUser> | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
  @Column({ name: 'last_used_at', type: 'timestamptz', nullable: true })
  lastUsedAt: Date | null;
  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;
}
