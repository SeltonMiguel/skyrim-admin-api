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
import { Player } from '../../player-accounts/entities/player.entity.js';
import type { MarketRequestOperation } from '../player-marketplace.contracts.js';
import { PlayerMarketplaceListing } from './player-marketplace-listing.entity.js';

// Marketplace idempotency (scope PLAYER:<playerId>), claimed in the same
// transaction as the mutation. The listing FK is deferred so a create can
// claim its key before inserting the listing.
@Entity('player_marketplace_requests')
@Unique('player_marketplace_requests_idempotency_key', [
  'idempotencyScope',
  'idempotencyKey',
])
@Check(
  'player_marketplace_requests_scope_check',
  `idempotency_scope = ('PLAYER:' || player_id::text) AND length(idempotency_key) > 0`,
)
@Check(
  'player_marketplace_requests_operation_check',
  `operation IN ('CREATE', 'CANCEL', 'PURCHASE')`,
)
export class PlayerMarketplaceRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'idempotency_scope', type: 'varchar', length: 64 })
  idempotencyScope: string;
  @Column({ name: 'idempotency_key', type: 'varchar', length: 128 })
  idempotencyKey: string;
  @Column({ name: 'player_id', type: 'uuid' })
  playerId: string;
  @ManyToOne(() => Player)
  @JoinColumn({
    name: 'player_id',
    foreignKeyConstraintName: 'player_marketplace_requests_player_fkey',
  })
  player: Relation<Player>;
  @Column({ type: 'varchar', length: 16 })
  operation: MarketRequestOperation;
  @Column({ name: 'request_fingerprint', type: 'char', length: 64 })
  requestFingerprint: string;
  @Column({ name: 'listing_id', type: 'uuid' })
  listingId: string;
  @ManyToOne(() => PlayerMarketplaceListing, {
    deferrable: 'INITIALLY DEFERRED',
  })
  @JoinColumn({
    name: 'listing_id',
    foreignKeyConstraintName: 'player_marketplace_requests_listing_fkey',
  })
  listing: Relation<PlayerMarketplaceListing>;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
