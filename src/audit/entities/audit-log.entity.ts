import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { AuditAction, AuditOutcome } from '../audit.types.js';
import type { RoleName } from '../../rbac/roles.js';

@Entity('audit_logs')
@Check('audit_logs_outcome_check', `outcome IN ('SUCCESS', 'FAILURE')`)
@Index('audit_logs_created_id_idx', ['createdAt', 'id'])
@Index('audit_logs_actor_idx', ['actorStaffId'])
@Index('audit_logs_action_idx', ['action'])
@Index('audit_logs_outcome_idx', ['outcome'])
@Index('audit_logs_request_idx', ['requestId'])
@Index('audit_logs_resource_idx', ['resourceType', 'resourceId'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'actor_staff_id', type: 'uuid', nullable: true })
  actorStaffId: string | null;
  @Column({
    name: 'actor_username',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  actorUsername: string | null;
  @Column({
    name: 'actor_display_name',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  actorDisplayName: string | null;
  @Column({ name: 'actor_role', type: 'varchar', length: 32, nullable: true })
  actorRole: RoleName | null;
  @Column({ type: 'varchar', length: 64 })
  action: AuditAction;
  @Column({ type: 'varchar', length: 16 })
  outcome: AuditOutcome;
  @Column({
    name: 'resource_type',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  resourceType: string | null;
  @Column({ name: 'resource_id', type: 'varchar', length: 128, nullable: true })
  resourceId: string | null;
  @Column({ name: 'request_id', type: 'varchar', length: 128, nullable: true })
  requestId: string | null;
  @Column({ type: 'varchar', length: 16, nullable: true })
  method: string | null;
  @Column({ type: 'varchar', length: 2048, nullable: true })
  path: string | null;
  @Column({ name: 'status_code', type: 'integer', nullable: true })
  statusCode: number | null;
  @Column({ name: 'ip_address', type: 'varchar', length: 64, nullable: true })
  ipAddress: string | null;
  @Column({ name: 'user_agent', type: 'varchar', length: 512, nullable: true })
  userAgent: string | null;
  @Column({ type: 'jsonb', nullable: true })
  metadata: object | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
