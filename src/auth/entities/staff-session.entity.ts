import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';
import { StaffUser } from '../../staff/entities/staff-user.entity.js';

@Entity('staff_sessions')
@Index('staff_sessions_user_idx', ['staffUserId'])
export class StaffSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'staff_user_id', type: 'uuid' })
  staffUserId: string;

  @ManyToOne(() => StaffUser)
  @JoinColumn({
    name: 'staff_user_id',
    foreignKeyConstraintName: 'staff_sessions_staff_user_id_fkey',
  })
  staffUser: Relation<StaffUser>;

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

  @Column({ name: 'ip_address', type: 'varchar', length: 64, nullable: true })
  ipAddress: string | null;

  @Column({ name: 'user_agent', type: 'varchar', length: 512, nullable: true })
  userAgent: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
