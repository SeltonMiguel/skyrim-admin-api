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
import { Role } from '../../rbac/entities/role.entity.js';
import { RoleName } from '../../rbac/roles.js';

export enum StaffStatus {
  ACTIVE = 'ACTIVE',
  DISABLED = 'DISABLED',
}

@Entity('staff_users')
@Index('staff_users_role_status_idx', ['roleName', 'status'])
@Check('staff_username_normalized', `username ~ '^[a-z0-9_.-]{3,64}$'`)
@Check('staff_users_status_check', `status IN ('ACTIVE', 'DISABLED')`)
export class StaffUser {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 64, unique: true })
  username: string;

  @Column({ name: 'display_name', type: 'varchar', length: 100 })
  displayName: string;

  @Column({ name: 'password_hash', type: 'text', select: false })
  passwordHash: string;

  @Column({ name: 'role_name', type: 'varchar', length: 32 })
  roleName: RoleName;

  @ManyToOne(() => Role)
  @JoinColumn({
    name: 'role_name',
    foreignKeyConstraintName: 'staff_users_role_name_fkey',
  })
  role: Relation<Role>;

  @Column({ type: 'varchar', length: 16, default: StaffStatus.ACTIVE })
  status: StaffStatus;

  @Column({ name: 'last_login_at', type: 'timestamptz', nullable: true })
  lastLoginAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
