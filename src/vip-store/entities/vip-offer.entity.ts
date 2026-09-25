import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import type {
  VipCurrency,
  VipEntitlementScope,
  VipReward,
} from '../vip-offer.contracts.js';
@Entity('vip_offers')
@Unique('vip_offers_code_key', ['code'])
@Index('vip_offers_catalog_idx', ['active', 'sortOrder', 'code'])
@Check('vip_offers_code_check', `code ~ '^[a-z0-9][a-z0-9_-]{2,63}$'`)
@Check('vip_offers_name_check', `length(btrim(name)) > 0`)
@Check('vip_offers_price_check', `price_minor >= 0`)
@Check('vip_offers_currency_check', `currency = 'BRL'`)
@Check('vip_offers_sort_order_check', `sort_order BETWEEN 0 AND 1000000`)
@Check(
  'vip_offers_rewards_check',
  `CASE WHEN jsonb_typeof(rewards) = 'array' THEN jsonb_array_length(rewards) BETWEEN 1 AND 20 AND octet_length(rewards::text) <= 32768 ELSE false END`,
)
@Check(
  'vip_offers_entitlement_scope_check',
  `entitlement_scope IN ('PLAYER', 'CHARACTER')`,
)
export class VipOffer {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'vip_offers_pkey',
  })
  id: string;
  @Column({ type: 'varchar', length: 64 }) code: string;
  @Column({ type: 'varchar', length: 100 }) name: string;
  @Column({ type: 'varchar', length: 2000 }) description: string;
  @Column({ name: 'price_minor', type: 'integer' }) priceMinor: number;
  @Column({ type: 'varchar', length: 3 }) currency: VipCurrency;
  @Column({ type: 'boolean', default: false }) active: boolean;
  @Column({ name: 'sort_order', type: 'integer', default: 0 })
  sortOrder: number;
  @Column({ type: 'jsonb' }) rewards: VipReward[];
  @Column({
    name: 'entitlement_scope',
    type: 'varchar',
    length: 16,
    default: 'CHARACTER',
  })
  entitlementScope: VipEntitlementScope;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
