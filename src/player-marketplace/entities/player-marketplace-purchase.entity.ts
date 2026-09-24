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
import type { PurchaseStatus } from '../player-marketplace.contracts.js';
import { PlayerMarketplaceListing } from './player-marketplace-listing.entity.js';

// The one effective purchase of a listing, by a buyer character identity.
@Entity('player_marketplace_purchases')
@Unique('player_marketplace_purchases_listing_key', ['listingId'])
@Index('player_marketplace_purchases_buyer_idx', [
  'buyerCharacterId',
  'createdAt',
])
@Check(
  'player_marketplace_purchases_buyer_check',
  `length(btrim(buyer_character_id)) > 0`,
)
@Check(
  'player_marketplace_purchases_status_check',
  `status IN ('AWAITING_GAME_CONFIRMATION', 'COMPLETED', 'FAILED')`,
)
@Check(
  'player_marketplace_purchases_lifecycle_check',
  `(status = 'AWAITING_GAME_CONFIRMATION' AND completed_at IS NULL AND failed_at IS NULL) OR (status = 'COMPLETED' AND completed_at IS NOT NULL AND failed_at IS NULL) OR (status = 'FAILED' AND failed_at IS NOT NULL AND completed_at IS NULL)`,
)
export class PlayerMarketplacePurchase {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'listing_id', type: 'uuid' })
  listingId: string;
  @ManyToOne(() => PlayerMarketplaceListing)
  @JoinColumn({
    name: 'listing_id',
    foreignKeyConstraintName: 'player_marketplace_purchases_listing_fkey',
  })
  listing: Relation<PlayerMarketplaceListing>;
  @Column({ name: 'buyer_character_id', type: 'varchar', length: 128 })
  buyerCharacterId: string;
  @Column({
    type: 'varchar',
    length: 32,
    default: 'AWAITING_GAME_CONFIRMATION',
  })
  status: PurchaseStatus;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;
  @Column({ name: 'failed_at', type: 'timestamptz', nullable: true })
  failedAt: Date | null;
}
