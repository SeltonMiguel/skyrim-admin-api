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
import { CommandStatus } from '../command-state.js';
import type { CommandType } from '../command-contract.js';

@Entity('game_commands')
@Check(
  'game_commands_dispatch_lease_check',
  '(dispatch_lease_id IS NULL) = (dispatch_lease_expires_at IS NULL)',
)
@Unique('game_commands_idempotency_key', ['gameServerId', 'idempotencyKey'])
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
