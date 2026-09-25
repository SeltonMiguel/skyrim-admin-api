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
import type { EntitlementOperation } from '../vip-entitlement.contracts.js';
import { PlayerVipEntitlement } from './player-vip-entitlement.entity.js';

// Grant/revoke idempotency per actor scope (STAFF or SYSTEM:<source>),
// written in the mutation transaction; append-only.
@Entity('vip_entitlement_requests')
@Unique('vip_entitlement_requests_idempotency_key', [
  'idempotencyScope',
  'idempotencyKey',
])
@Check(
  'vip_entitlement_requests_scope_check',
  `idempotency_scope ~ '^(STAFF|SYSTEM:[A-Z_]{1,32})$' AND length(idempotency_key) > 0`,
)
@Check(
  'vip_entitlement_requests_operation_check',
  `operation IN ('GRANT', 'REVOKE')`,
)
export class VipEntitlementRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'idempotency_scope', type: 'varchar', length: 64 })
  idempotencyScope: string;
  @Column({ name: 'idempotency_key', type: 'varchar', length: 128 })
  idempotencyKey: string;
  @Column({ type: 'varchar', length: 16 })
  operation: EntitlementOperation;
  @Column({ name: 'request_fingerprint', type: 'char', length: 64 })
  requestFingerprint: string;
  @Column({ name: 'entitlement_id', type: 'uuid' })
  entitlementId: string;
  @ManyToOne(() => PlayerVipEntitlement)
  @JoinColumn({
    name: 'entitlement_id',
    foreignKeyConstraintName: 'vip_entitlement_requests_entitlement_fkey',
  })
  entitlement: Relation<PlayerVipEntitlement>;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
