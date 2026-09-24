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
import { bigintColumn } from '../../economy/economy.contracts.js';
import type { Currency } from '../../economy/economy.contracts.js';
import { EconomyTransaction } from '../../economy/entities/economy-transaction.entity.js';
import type { MarketEscrowStatus } from '../player-marketplace.contracts.js';
import { PlayerMarketplacePurchase } from './player-marketplace-purchase.entity.js';

// Who owns each part of MARKET_ESCROW: exactly one row per purchase,
// pointing at the ledger transactions that reserved and resolved it.
@Entity('player_marketplace_currency_escrows')
@Unique('player_marketplace_currency_escrows_purchase_key', ['purchaseId'])
@Index('player_marketplace_currency_escrows_status_idx', [
  'gameServerId',
  'currency',
  'status',
])
@Check(
  'player_marketplace_currency_escrows_currency_check',
  `currency IN ('GOLD')`,
)
@Check(
  'player_marketplace_currency_escrows_parties_check',
  `buyer_character_id <> seller_character_id AND amount BETWEEN 1 AND 1000000000000`,
)
@Check(
  'player_marketplace_currency_escrows_status_check',
  `status IN ('RESERVED', 'RELEASED', 'SETTLED')`,
)
@Check(
  'player_marketplace_currency_escrows_resolution_check',
  `(status = 'RESERVED') = (resolution_transaction_id IS NULL)`,
)
export class PlayerMarketplaceCurrencyEscrow {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'purchase_id', type: 'uuid' })
  purchaseId: string;
  @ManyToOne(() => PlayerMarketplacePurchase)
  @JoinColumn({
    name: 'purchase_id',
    foreignKeyConstraintName:
      'player_marketplace_currency_escrows_purchase_fkey',
  })
  purchase: Relation<PlayerMarketplacePurchase>;
  @Column({ name: 'game_server_id', type: 'uuid' })
  gameServerId: string;
  @Column({ type: 'varchar', length: 16 })
  currency: Currency;
  @Column({ name: 'buyer_character_id', type: 'varchar', length: 128 })
  buyerCharacterId: string;
  @Column({ name: 'seller_character_id', type: 'varchar', length: 128 })
  sellerCharacterId: string;
  @Column({ type: 'bigint', transformer: bigintColumn })
  amount: number;
  @Column({ type: 'varchar', length: 16, default: 'RESERVED' })
  status: MarketEscrowStatus;
  @Column({ name: 'reservation_transaction_id', type: 'uuid' })
  reservationTransactionId: string;
  @ManyToOne(() => EconomyTransaction)
  @JoinColumn({
    name: 'reservation_transaction_id',
    foreignKeyConstraintName:
      'player_marketplace_currency_escrows_reservation_fkey',
  })
  reservationTransaction: Relation<EconomyTransaction>;
  @Column({
    name: 'resolution_transaction_id',
    type: 'uuid',
    nullable: true,
  })
  resolutionTransactionId: string | null;
  @ManyToOne(() => EconomyTransaction)
  @JoinColumn({
    name: 'resolution_transaction_id',
    foreignKeyConstraintName:
      'player_marketplace_currency_escrows_resolution_fkey',
  })
  resolutionTransaction: Relation<EconomyTransaction>;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
