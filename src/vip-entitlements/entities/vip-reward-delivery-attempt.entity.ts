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
import { GameCommand } from '../../game-bridge/entities/game-command.entity.js';
import { StaffUser } from '../../staff/entities/staff-user.entity.js';
import type {
  DeliveryErrorCode,
  DeliveryResolution,
  DeliveryStatus,
} from '../vip-delivery.contracts.js';
import { VipRewardDelivery } from './vip-reward-delivery.entity.js';

// A finished VIP delivery attempt archived when an operator started a new
// one (12.4): its command, outcome and resolution are kept as they were;
// the delivery row then carries the new attempt.
@Entity('vip_reward_delivery_attempts')
@Unique('vip_reward_delivery_attempts_attempt_key', ['deliveryId', 'attempt'])
@Unique('vip_reward_delivery_attempts_command_key', ['gameCommandId'])
@Check(
  'vip_reward_delivery_attempts_status_check',
  `status IN ('FAILED', 'UNCERTAIN') AND attempt BETWEEN 1 AND 10 AND length(btrim(retry_reason)) > 0`,
)
@Check(
  'vip_reward_delivery_attempts_resolution_check',
  `(resolution IS NULL AND resolved_by_staff_id IS NULL AND resolved_at IS NULL AND resolution_reason IS NULL) OR (resolution = 'CONFIRMED_NOT_DELIVERED' AND resolved_by_staff_id IS NOT NULL AND resolved_at IS NOT NULL AND resolution_reason IS NOT NULL)`,
)
export class VipRewardDeliveryAttempt {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'delivery_id', type: 'uuid' })
  deliveryId: string;
  @ManyToOne(() => VipRewardDelivery)
  @JoinColumn({
    name: 'delivery_id',
    foreignKeyConstraintName: 'vip_reward_delivery_attempts_delivery_fkey',
  })
  delivery: Relation<VipRewardDelivery>;
  @Column({ type: 'smallint' })
  attempt: number;
  @Column({ name: 'game_command_id', type: 'uuid', nullable: true })
  gameCommandId: string | null;
  @ManyToOne(() => GameCommand)
  @JoinColumn({
    name: 'game_command_id',
    foreignKeyConstraintName: 'vip_reward_delivery_attempts_command_fkey',
  })
  gameCommand: Relation<GameCommand>;
  @Column({ type: 'varchar', length: 16 })
  status: DeliveryStatus;
  @Column({ name: 'error_code', type: 'varchar', length: 64 })
  errorCode: DeliveryErrorCode;
  @Column({ name: 'completed_at', type: 'timestamptz' })
  completedAt: Date;
  @Column({ type: 'varchar', length: 32, nullable: true })
  resolution: DeliveryResolution | null;
  @Column({ name: 'resolved_by_staff_id', type: 'uuid', nullable: true })
  resolvedByStaffId: string | null;
  @ManyToOne(() => StaffUser)
  @JoinColumn({
    name: 'resolved_by_staff_id',
    foreignKeyConstraintName: 'vip_reward_delivery_attempts_resolver_fkey',
  })
  resolvedByStaff: Relation<StaffUser>;
  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;
  @Column({
    name: 'resolution_reason',
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  resolutionReason: string | null;
  @Column({ name: 'retried_by_staff_id', type: 'uuid' })
  retriedByStaffId: string;
  @ManyToOne(() => StaffUser)
  @JoinColumn({
    name: 'retried_by_staff_id',
    foreignKeyConstraintName: 'vip_reward_delivery_attempts_retrier_fkey',
  })
  retriedByStaff: Relation<StaffUser>;
  @Column({ name: 'retry_reason', type: 'varchar', length: 500 })
  retryReason: string;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
