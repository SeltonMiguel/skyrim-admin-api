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
import { GameServer } from '../../game-bridge/entities/game-server.entity.js';
import type {
  ReleaseReason,
  ReleaseStatus,
} from '../player-marketplace.contracts.js';
import { PlayerMarketplaceListing } from './player-marketplace-listing.entity.js';

// Return of a custodied listing item to its seller (Etapa 11.4). Its id is
// the Agent work identity (workId). Seller, item and quantity are read from
// the listing (immutable terms), never from the Agent.
@Entity('player_marketplace_item_releases')
@Unique('player_marketplace_item_releases_listing_key', ['listingId'])
@Unique('player_marketplace_item_releases_event_key', [
  'gameServerId',
  'releaseEventId',
])
@Index('player_marketplace_item_releases_work_idx', [
  'gameServerId',
  'status',
  'createdAt',
  'id',
])
@Check(
  'player_marketplace_item_releases_status_check',
  `(status = 'PENDING' AND completed_at IS NULL AND release_event_id IS NULL AND error_code IS NULL) OR (status = 'COMPLETED' AND completed_at IS NOT NULL AND release_event_id IS NOT NULL AND error_code IS NULL) OR (status = 'FAILED' AND completed_at IS NOT NULL AND release_event_id IS NOT NULL AND error_code IS NOT NULL)`,
)
@Check(
  'player_marketplace_item_releases_reason_check',
  `reason IN ('CANCELLED', 'PURCHASE_FAILED') AND length(btrim(seller_character_id)) > 0`,
)
export class PlayerMarketplaceItemRelease {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'listing_id', type: 'uuid' })
  listingId: string;
  @ManyToOne(() => PlayerMarketplaceListing)
  @JoinColumn({
    name: 'listing_id',
    foreignKeyConstraintName: 'player_marketplace_item_releases_listing_fkey',
  })
  listing: Relation<PlayerMarketplaceListing>;
  @Column({ name: 'game_server_id', type: 'uuid' })
  gameServerId: string;
  @ManyToOne(() => GameServer)
  @JoinColumn({
    name: 'game_server_id',
    foreignKeyConstraintName: 'player_marketplace_item_releases_server_fkey',
  })
  gameServer: Relation<GameServer>;
  @Column({ name: 'seller_character_id', type: 'varchar', length: 128 })
  sellerCharacterId: string;
  @Column({ type: 'varchar', length: 16 })
  reason: ReleaseReason;
  @Column({ type: 'varchar', length: 16, default: 'PENDING' })
  status: ReleaseStatus;
  @Column({ name: 'release_event_id', type: 'uuid', nullable: true })
  releaseEventId: string | null;
  @Column({ name: 'error_code', type: 'varchar', length: 64, nullable: true })
  errorCode: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;
}
