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
import type { CustodyOutcome } from '../player-marketplace.contracts.js';
import { PlayerMarketplaceListing } from './player-marketplace-listing.entity.js';

// Trusted Agent custody report: one per listing, event ids unique per
// server, so replays are detected and conflicting reuse rejected.
@Entity('player_marketplace_custody_events')
@Unique('player_marketplace_custody_events_event_key', [
  'gameServerId',
  'custodyEventId',
])
@Unique('player_marketplace_custody_events_listing_key', ['listingId'])
@Check(
  'player_marketplace_custody_events_outcome_check',
  `outcome IN ('CUSTODIED', 'FAILED') AND length(btrim(custody_event_id)) > 0`,
)
export class PlayerMarketplaceCustodyEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'game_server_id', type: 'uuid' })
  gameServerId: string;
  @Column({ name: 'custody_event_id', type: 'varchar', length: 128 })
  custodyEventId: string;
  @Column({ name: 'listing_id', type: 'uuid' })
  listingId: string;
  @ManyToOne(() => PlayerMarketplaceListing)
  @JoinColumn({
    name: 'listing_id',
    foreignKeyConstraintName: 'player_marketplace_custody_events_listing_fkey',
  })
  listing: Relation<PlayerMarketplaceListing>;
  @Column({ type: 'varchar', length: 16 })
  outcome: CustodyOutcome;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
