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
import type { MarketSettlementOutcome } from '../player-marketplace.contracts.js';
import { PlayerMarketplacePurchase } from './player-marketplace-purchase.entity.js';

// Trusted Agent settlement of a purchase: one per purchase, event ids
// unique per server. Only recorded when the settlement commits.
@Entity('player_marketplace_settlement_events')
@Unique('player_marketplace_settlement_events_event_key', [
  'gameServerId',
  'settlementEventId',
])
@Unique('player_marketplace_settlement_events_purchase_key', ['purchaseId'])
@Check(
  'player_marketplace_settlement_events_outcome_check',
  `outcome IN ('SETTLED', 'FAILED') AND length(btrim(settlement_event_id)) > 0`,
)
export class PlayerMarketplaceSettlementEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'game_server_id', type: 'uuid' })
  gameServerId: string;
  @Column({ name: 'settlement_event_id', type: 'varchar', length: 128 })
  settlementEventId: string;
  @Column({ name: 'purchase_id', type: 'uuid' })
  purchaseId: string;
  @ManyToOne(() => PlayerMarketplacePurchase)
  @JoinColumn({
    name: 'purchase_id',
    foreignKeyConstraintName:
      'player_marketplace_settlement_events_purchase_fkey',
  })
  purchase: Relation<PlayerMarketplacePurchase>;
  @Column({ type: 'varchar', length: 16 })
  outcome: MarketSettlementOutcome;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
