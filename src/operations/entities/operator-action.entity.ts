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
import { StaffUser } from '../../staff/entities/staff-user.entity.js';
import type {
  OperatorActionKind,
  OperatorDomain,
} from '../operations.contracts.js';

// One accepted operator intervention (12.4), committed with its effect and
// its Audit. (staff, Idempotency-Key) identifies it: a replay with the same
// request returns `result`, a different request with the same key is a
// conflict. The reason is operator text, bounded; never Agent payload.
@Entity('operator_actions')
@Unique('operator_actions_idempotency_key', ['staffId', 'idempotencyKey'])
@Index('operator_actions_resource_idx', ['domain', 'resourceId', 'createdAt'])
@Check(
  'operator_actions_domain_check',
  `domain IN ('SERVER_CONTROL', 'PLAYER_TRADE', 'MARKETPLACE_CUSTODY', 'MARKETPLACE_SETTLEMENT', 'MARKETPLACE_RELEASE', 'VIP_DELIVERY', 'PLAYER_ACCOUNT', 'PLAYER_ECONOMY', 'PLAYER_CHAT')`,
)
@Check(
  'operator_actions_action_check',
  `action IN ('RETRY_SAFE', 'REQUEUE_SAME_WORK', 'ACKNOWLEDGE', 'RESOLVE_SUCCEEDED', 'RESOLVE_FAILED', 'CANCEL', 'SET_STATUS', 'ADJUST', 'HIDE')`,
)
@Check(
  'operator_actions_content_check',
  `length(btrim(reason)) > 0 AND length(idempotency_key) > 0 AND request_fingerprint ~ '^[0-9a-f]{64}$' AND jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 4096`,
)
export class OperatorAction {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'staff_id', type: 'uuid' })
  staffId: string;
  @ManyToOne(() => StaffUser)
  @JoinColumn({
    name: 'staff_id',
    foreignKeyConstraintName: 'operator_actions_staff_fkey',
  })
  staff: Relation<StaffUser>;
  @Column({ name: 'idempotency_key', type: 'varchar', length: 128 })
  idempotencyKey: string;
  @Column({ name: 'request_fingerprint', type: 'char', length: 64 })
  requestFingerprint: string;
  @Column({ type: 'varchar', length: 32 })
  domain: OperatorDomain;
  @Column({ type: 'varchar', length: 32 })
  action: OperatorActionKind;
  @Column({ name: 'resource_id', type: 'varchar', length: 128 })
  resourceId: string;
  @Column({ type: 'varchar', length: 500 })
  reason: string;
  @Column({ type: 'varchar', length: 32 })
  outcome: string;
  @Column({ type: 'jsonb' })
  result: Record<string, unknown>;
  @Column({ name: 'request_id', type: 'varchar', length: 128, nullable: true })
  requestId: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
