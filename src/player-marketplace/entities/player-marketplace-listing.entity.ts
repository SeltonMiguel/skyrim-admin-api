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
import { bigintColumn } from '../../economy/economy.contracts.js';
import { GameServer } from '../../game-bridge/entities/game-server.entity.js';
import type { ListingStatus } from '../player-marketplace.contracts.js';

// One GAME_ITEM line of a seller character identity (never an ownership
// link) for a GOLD price. No item name/description is stored: the id is
// opaque and only the Agent can hold or move the item. Forward-only
// transitions and immutable terms are enforced by a trigger.
@Entity('player_marketplace_listings')
@Index('player_marketplace_listings_browse_idx', ['status', 'createdAt', 'id'])
@Index('player_marketplace_listings_seller_idx', [
  'gameServerId',
  'sellerCharacterId',
  'createdAt',
])
@Index(
  'player_marketplace_listings_custody_key',
  ['gameServerId', 'custodyEventId'],
  { unique: true, where: 'custody_event_id IS NOT NULL' },
)
@Check(
  'player_marketplace_listings_terms_check',
  `length(btrim(seller_character_id)) > 0 AND length(btrim(item_external_id)) > 0 AND quantity BETWEEN 1 AND 10000 AND price_gold BETWEEN 1 AND 1000000000000`,
)
@Check(
  'player_marketplace_listings_status_check',
  `status IN ('PENDING_CUSTODY', 'ACTIVE', 'RESERVED', 'SOLD', 'CANCELLED', 'FAILED')`,
)
@Check(
  'player_marketplace_listings_buyer_check',
  `reserved_by_character_id IS DISTINCT FROM seller_character_id AND (reserved_by_character_id IS NULL) = (reserved_at IS NULL)`,
)
@Check(
  'player_marketplace_listings_lifecycle_check',
  `(status = 'PENDING_CUSTODY' AND custody_event_id IS NULL AND reserved_at IS NULL AND sold_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL) OR (status = 'ACTIVE' AND custody_event_id IS NOT NULL AND reserved_at IS NULL AND sold_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL) OR (status = 'RESERVED' AND custody_event_id IS NOT NULL AND reserved_at IS NOT NULL AND sold_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL) OR (status = 'SOLD' AND custody_event_id IS NOT NULL AND reserved_at IS NOT NULL AND sold_at IS NOT NULL AND cancelled_at IS NULL AND failed_at IS NULL) OR (status = 'CANCELLED' AND reserved_at IS NULL AND cancelled_at IS NOT NULL AND sold_at IS NULL AND failed_at IS NULL) OR (status = 'FAILED' AND custody_event_id IS NOT NULL AND failed_at IS NOT NULL AND sold_at IS NULL AND cancelled_at IS NULL)`,
)
export class PlayerMarketplaceListing {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'game_server_id', type: 'uuid' })
  gameServerId: string;
  @ManyToOne(() => GameServer)
  @JoinColumn({
    name: 'game_server_id',
    foreignKeyConstraintName: 'player_marketplace_listings_server_fkey',
  })
  gameServer: Relation<GameServer>;
  @Column({ name: 'seller_character_id', type: 'varchar', length: 128 })
  sellerCharacterId: string;
  @Column({ name: 'item_external_id', type: 'varchar', length: 128 })
  itemExternalId: string;
  @Column({ type: 'integer' })
  quantity: number;
  @Column({ name: 'price_gold', type: 'bigint', transformer: bigintColumn })
  priceGold: number;
  @Column({ type: 'varchar', length: 32, default: 'PENDING_CUSTODY' })
  status: ListingStatus;
  // Agent event that resolved custody (CUSTODIED or FAILED); internal.
  @Column({
    name: 'custody_event_id',
    type: 'varchar',
    length: 128,
    nullable: true,
  })
  custodyEventId: string | null;
  @Column({
    name: 'reserved_by_character_id',
    type: 'varchar',
    length: 128,
    nullable: true,
  })
  reservedByCharacterId: string | null;
  @Column({ name: 'reserved_at', type: 'timestamptz', nullable: true })
  reservedAt: Date | null;
  @Column({ name: 'sold_at', type: 'timestamptz', nullable: true })
  soldAt: Date | null;
  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt: Date | null;
  @Column({ name: 'failed_at', type: 'timestamptz', nullable: true })
  failedAt: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
