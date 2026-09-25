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
import { GameConnection } from '../../game-bridge/entities/game-connection.entity.js';
import { GameServer } from '../../game-bridge/entities/game-server.entity.js';
import { StaffUser } from '../../staff/entities/staff-user.entity.js';
import { ServerControlStatus } from '../server-control.contracts.js';
import type {
  ServerControlErrorCode,
  ServerControlType,
} from '../server-control.contracts.js';

// Separate from game_commands: lifecycle requests never enter the gameplay bus.
@Entity('server_control_operations')
@Unique('server_control_operations_idempotency_key', [
  'gameServerId',
  'idempotencyKey',
])
@Unique('server_control_operations_correlation_key', ['correlationId'])
@Index('server_control_operations_dispatch_idx', ['status', 'createdAt'])
@Index('server_control_operations_server_idx', ['gameServerId', 'createdAt'])
@Index('server_control_operations_request_idx', ['requestId'])
// At most one non-terminal operation per server (Etapa 11.3).
@Index('server_control_operations_active_key', ['gameServerId'], {
  unique: true,
  where: `status IN ('PENDING', 'DISPATCHED')`,
})
@Index('server_control_operations_deadline_idx', ['status', 'resultDeadlineAt'])
@Check(
  'server_control_operations_type_check',
  `type IN ('SERVER_START', 'SERVER_PAUSE', 'SERVER_RESTART')`,
)
@Check(
  'server_control_operations_status_check',
  `status IN ('PENDING', 'DISPATCHED', 'SUCCEEDED', 'FAILED', 'UNCERTAIN')`,
)
@Check(
  'server_control_operations_pending_check',
  `status <> 'PENDING' OR (dispatched_at IS NULL AND completed_at IS NULL)`,
)
@Check(
  'server_control_operations_dispatched_check',
  `status NOT IN ('DISPATCHED', 'SUCCEEDED') OR dispatched_at IS NOT NULL`,
)
@Check(
  'server_control_operations_completed_check',
  `(status IN ('SUCCEEDED', 'FAILED', 'UNCERTAIN')) = (completed_at IS NOT NULL)`,
)
@Check(
  'server_control_operations_error_check',
  `(status IN ('FAILED', 'UNCERTAIN')) = (error_code IS NOT NULL)`,
)
// The claim fixes the target session and both deadlines, together.
@Check(
  'server_control_operations_claim_check',
  `(dispatch_claimed_at IS NULL) = (not_after IS NULL) AND (dispatch_claimed_at IS NULL) = (result_deadline_at IS NULL) AND (dispatch_claimed_at IS NOT NULL OR dispatch_connection_id IS NULL)`,
)
// Uncertainty only exists past the delivery boundary.
@Check(
  'server_control_operations_uncertain_check',
  `status <> 'UNCERTAIN' OR dispatch_claimed_at IS NOT NULL`,
)
export class ServerControlOperation {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'game_server_id', type: 'uuid' })
  gameServerId: string;
  @ManyToOne(() => GameServer)
  @JoinColumn({
    name: 'game_server_id',
    foreignKeyConstraintName: 'server_control_operations_server_fkey',
  })
  gameServer: Relation<GameServer>;
  @Column({ name: 'type', type: 'varchar', length: 32 })
  type: ServerControlType;
  @Column({ name: 'status', type: 'varchar', length: 16, default: 'PENDING' })
  status: ServerControlStatus;
  @Column({ name: 'idempotency_key', type: 'varchar', length: 128 })
  idempotencyKey: string;
  @Column({ name: 'correlation_id', type: 'uuid' })
  correlationId: string;
  @Column({ name: 'request_id', type: 'varchar', nullable: true, length: 128 })
  requestId: string | null;
  @Column({ name: 'requested_by_staff_id', type: 'uuid' })
  requestedByStaffId: string;
  @ManyToOne(() => StaffUser)
  @JoinColumn({
    name: 'requested_by_staff_id',
    foreignKeyConstraintName: 'server_control_operations_staff_fkey',
  })
  requestedByStaff: Relation<StaffUser>;
  // Internal at-most-once claim; never exposed over HTTP.
  @Column({ name: 'dispatch_claimed_at', type: 'timestamptz', nullable: true })
  dispatchClaimedAt: Date | null;
  // Session chosen at the claim; the only one the operation is sent to.
  // Provenance only for the result, which any later session may report.
  @Column({ name: 'dispatch_connection_id', type: 'uuid', nullable: true })
  dispatchConnectionId: string | null;
  @ManyToOne(() => GameConnection)
  @JoinColumn({
    name: 'dispatch_connection_id',
    foreignKeyConstraintName: 'server_control_operations_connection_fkey',
  })
  dispatchConnection: Relation<GameConnection>;
  // Sent to the Agent: it must refuse to execute after this instant.
  @Column({ name: 'not_after', type: 'timestamptz', nullable: true })
  notAfter: Date | null;
  // Persistent: past it, a possibly delivered operation becomes UNCERTAIN.
  @Column({ name: 'result_deadline_at', type: 'timestamptz', nullable: true })
  resultDeadlineAt: Date | null;
  @Column({ name: 'dispatched_at', type: 'timestamptz', nullable: true })
  dispatchedAt: Date | null;
  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;
  @Column({ name: 'error_code', type: 'varchar', nullable: true, length: 64 })
  errorCode: ServerControlErrorCode | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
