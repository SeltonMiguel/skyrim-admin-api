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
import { PlayerTradeOffer } from './player-trade-offer.entity.js';

// Opaque game item declared in an offer; only the Agent (Etapa 11) can
// verify, hold or move it. No client name/description is stored.
@Entity('player_trade_items')
@Unique('player_trade_items_item_key', ['offerId', 'itemExternalId'])
@Check('player_trade_items_item_check', `length(btrim(item_external_id)) > 0`)
@Check('player_trade_items_quantity_check', `quantity BETWEEN 1 AND 10000`)
export class PlayerTradeItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'offer_id', type: 'uuid' })
  offerId: string;
  @ManyToOne(() => PlayerTradeOffer, (offer) => offer.items)
  @JoinColumn({
    name: 'offer_id',
    foreignKeyConstraintName: 'player_trade_items_offer_fkey',
  })
  offer: Relation<PlayerTradeOffer>;
  @Column({ name: 'item_external_id', type: 'varchar', length: 128 })
  itemExternalId: string;
  @Column({ type: 'integer' })
  quantity: number;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
