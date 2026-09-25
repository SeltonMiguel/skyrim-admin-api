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
  UpdateDateColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';
import { GameCommand } from '../../game-bridge/entities/game-command.entity.js';
import { GameServer } from '../../game-bridge/entities/game-server.entity.js';
import type { VipReward } from '../../vip-store/vip-offer.contracts.js';
import type {
  DeliveryErrorCode,
  DeliveryStatus,
} from '../vip-delivery.contracts.js';
import { PlayerVipEntitlement } from './player-vip-entitlement.entity.js';

// Gameplay delivery of one typed reward of a CHARACTER entitlement (Etapa
// 11.4), through exactly one GameCommand of the Game Bridge (11.2) created
// as SYSTEM:VIP_DELIVERY with an idempotency key derived from this id.
@Entity('vip_reward_deliveries')
@Unique('vip_reward_deliveries_reward_key', ['entitlementId', 'rewardIndex'])
@Unique('vip_reward_deliveries_command_key', ['gameCommandId'])
@Index('vip_reward_deliveries_status_idx', ['status', 'createdAt', 'id'])
@Check(
  'vip_reward_deliveries_status_check',
  `(status = 'PENDING' AND game_command_id IS NULL AND completed_at IS NULL AND error_code IS NULL) OR (status = 'COMMAND_CREATED' AND game_command_id IS NOT NULL AND completed_at IS NULL AND error_code IS NULL) OR (status = 'SUCCEEDED' AND game_command_id IS NOT NULL AND completed_at IS NOT NULL AND error_code IS NULL) OR (status IN ('FAILED', 'UNCERTAIN') AND completed_at IS NOT NULL AND error_code IS NOT NULL AND (status = 'FAILED' OR game_command_id IS NOT NULL)) OR (status = 'CANCELLED' AND game_command_id IS NULL AND completed_at IS NOT NULL AND error_code IS NOT NULL)`,
)
@Check(
  'vip_reward_deliveries_reward_check',
  `reward_index BETWEEN 0 AND 19 AND jsonb_typeof(reward) = 'object' AND octet_length(reward::text) <= 4096 AND length(btrim(character_external_id)) > 0`,
)
export class VipRewardDelivery {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'entitlement_id', type: 'uuid' })
  entitlementId: string;
  @ManyToOne(() => PlayerVipEntitlement)
  @JoinColumn({
    name: 'entitlement_id',
    foreignKeyConstraintName: 'vip_reward_deliveries_entitlement_fkey',
  })
  entitlement: Relation<PlayerVipEntitlement>;
  @Column({ name: 'reward_index', type: 'smallint' })
  rewardIndex: number;
  // Snapshot of the typed reward at grant time.
  @Column({ type: 'jsonb' })
  reward: VipReward;
  @Column({ name: 'game_server_id', type: 'uuid' })
  gameServerId: string;
  @ManyToOne(() => GameServer)
  @JoinColumn({
    name: 'game_server_id',
    foreignKeyConstraintName: 'vip_reward_deliveries_server_fkey',
  })
  gameServer: Relation<GameServer>;
  @Column({ name: 'character_external_id', type: 'varchar', length: 128 })
  characterExternalId: string;
  @Column({ type: 'varchar', length: 16, default: 'PENDING' })
  status: DeliveryStatus;
  @Column({ name: 'game_command_id', type: 'uuid', nullable: true })
  gameCommandId: string | null;
  @ManyToOne(() => GameCommand)
  @JoinColumn({
    name: 'game_command_id',
    foreignKeyConstraintName: 'vip_reward_deliveries_command_fkey',
  })
  gameCommand: Relation<GameCommand>;
  @Column({ name: 'error_code', type: 'varchar', length: 64, nullable: true })
  errorCode: DeliveryErrorCode | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;
}
