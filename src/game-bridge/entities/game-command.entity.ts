import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import type { Relation } from 'typeorm';
import { GameServer } from './game-server.entity.js';
import { GameConnection } from './game-connection.entity.js';
import { StaffUser } from '../../staff/entities/staff-user.entity.js';
import { Player } from '../../player-accounts/entities/player.entity.js';
import type { ActorType, SystemSource } from '../../actors/actor.contracts.js';
import { CommandStatus } from '../command-state.js';
import type { CommandType } from '../command-contract.js';

@Entity('game_commands')
@Check(
  'game_commands_dispatch_lease_check',
  '(dispatch_lease_id IS NULL) = (dispatch_lease_expires_at IS NULL)',
)
// Idempotency is namespaced by actor scope: STAFF (shared by all staff and
// unattributed internal submits), PLAYER:<playerId> or SYSTEM:<source>.
@Unique('game_commands_idempotency_key', [
  'gameServerId',
  'idempotencyScope',
  'idempotencyKey',
])
@Index('game_commands_player_idx', ['requestedByPlayerId'])
@Check(
  'game_commands_actor_check',
  `(actor_type = 'STAFF' AND requested_by_player_id IS NULL AND requested_by_system_source IS NULL AND idempotency_scope = 'STAFF') OR (actor_type = 'PLAYER' AND requested_by_player_id IS NOT NULL AND requested_by_staff_id IS NULL AND requested_by_system_source IS NULL AND idempotency_scope = ('PLAYER:' || requested_by_player_id::text)) OR (actor_type = 'SYSTEM' AND requested_by_system_source IS NOT NULL AND requested_by_system_source IN ('AGENT', 'PROFESSION', 'VIP_DELIVERY') AND requested_by_staff_id IS NULL AND requested_by_player_id IS NULL AND idempotency_scope = ('SYSTEM:' || requested_by_system_source))`,
)
@Unique('game_commands_correlation_key', ['correlationId'])
@Index('game_commands_dispatch_idx', ['status', 'ackDeadlineAt', 'createdAt'])
@Index('game_commands_execution_idx', ['status', 'executionDeadlineAt'])
@Index('game_commands_server_idx', ['gameServerId', 'status'])
@Index('game_commands_request_idx', ['requestId'])
@Index('game_commands_connection_idx', ['dispatchedConnectionId'])
@Check(
  'game_commands_status_check',
  `status IN ('PENDING', 'DISPATCHED', 'ACKNOWLEDGED', 'SUCCEEDED', 'FAILED', 'TIMEOUT')`,
)
@Check('game_commands_attempts_check', 'dispatch_attempts >= 0')
@Check(
  'game_commands_payload_check',
  `jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 4096`,
)
@Check(
  'game_commands_completed_check',
  `(status IN ('SUCCEEDED', 'FAILED', 'TIMEOUT')) = (completed_at IS NOT NULL)`,
)
export class GameCommand {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'game_server_id', type: 'uuid' })
  gameServerId: string;
  @ManyToOne(() => GameServer)
  @JoinColumn({
    name: 'game_server_id',
    foreignKeyConstraintName: 'game_commands_server_fkey',
  })
  gameServer: Relation<GameServer>;
  @Column({ name: 'type', type: 'varchar', length: 64 })
  type: CommandType;
  @Column({ name: 'status', type: 'varchar', length: 16, default: 'PENDING' })
  status: CommandStatus;
  @Column({ name: 'payload', type: 'jsonb' })
  payload: object;
  @Column({ name: 'idempotency_key', type: 'varchar', length: 128 })
  idempotencyKey: string;
  // Internal only; never exposed by any presenter.
  @Column({
    name: 'idempotency_scope',
    type: 'varchar',
    length: 64,
    default: 'STAFF',
  })
  idempotencyScope: string;
  @Column({ name: 'actor_type', type: 'varchar', length: 16, default: 'STAFF' })
  actorType: ActorType;
  @Column({ name: 'correlation_id', type: 'uuid' })
  correlationId: string;
  @Column({ name: 'request_id', type: 'varchar', nullable: true, length: 128 })
  requestId: string | null;
  @Column({ name: 'requested_by_staff_id', type: 'uuid', nullable: true })
  requestedByStaffId: string | null;
  @ManyToOne(() => StaffUser)
  @JoinColumn({
    name: 'requested_by_staff_id',
    foreignKeyConstraintName: 'game_commands_staff_fkey',
  })
  requestedByStaff: Relation<StaffUser>;
  @Column({ name: 'requested_by_player_id', type: 'uuid', nullable: true })
  requestedByPlayerId: string | null;
  @ManyToOne(() => Player)
  @JoinColumn({
    name: 'requested_by_player_id',
    foreignKeyConstraintName: 'game_commands_player_fkey',
  })
  requestedByPlayer: Relation<Player>;
  @Column({
    name: 'requested_by_system_source',
    type: 'varchar',
    length: 32,
    nullable: true,
  })
  requestedBySystemSource: SystemSource | null;
  @Column({ name: 'dispatched_connection_id', type: 'uuid', nullable: true })
  dispatchedConnectionId: string | null;
  @ManyToOne(() => GameConnection)
  @JoinColumn({
    name: 'dispatched_connection_id',
    foreignKeyConstraintName: 'game_commands_connection_fkey',
  })
  dispatchedConnection: Relation<GameConnection>;
  @Column({ name: 'dispatch_lease_id', type: 'uuid', nullable: true })
  dispatchLeaseId: string | null;
  @Column({
    name: 'dispatch_lease_expires_at',
    type: 'timestamptz',
    nullable: true,
  })
  dispatchLeaseExpiresAt: Date | null;

  @Column({ name: 'dispatch_attempts', type: 'integer', default: 0 })
  dispatchAttempts: number;
  @Column({ name: 'last_dispatch_at', type: 'timestamptz', nullable: true })
  lastDispatchAt: Date | null;
  @Column({ name: 'acknowledged_at', type: 'timestamptz', nullable: true })
  acknowledgedAt: Date | null;
  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;
  @Column({ name: 'ack_deadline_at', type: 'timestamptz', nullable: true })
  ackDeadlineAt: Date | null;
  @Column({
    name: 'execution_deadline_at',
    type: 'timestamptz',
    nullable: true,
  })
  executionDeadlineAt: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
