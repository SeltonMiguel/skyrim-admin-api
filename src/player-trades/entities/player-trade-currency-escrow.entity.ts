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
import type { EscrowStatus } from '../player-trade.contracts.js';
import { PlayerTrade } from './player-trade.entity.js';

// Who owns each part of TRADE_ESCROW: one row per trade + contributing
// character, pointing at the ledger transactions that reserved and resolved it.
@Entity('player_trade_currency_escrows')
@Unique('player_trade_currency_escrows_party_key', [
  'tradeId',
  'characterExternalId',
])
@Index('player_trade_currency_escrows_status_idx', [
  'gameServerId',
  'currency',
  'status',
])
@Check('player_trade_currency_escrows_currency_check', `currency IN ('GOLD')`)
@Check(
  'player_trade_currency_escrows_amount_check',
  `amount BETWEEN 1 AND 1000000000000`,
)
@Check(
  'player_trade_currency_escrows_status_check',
  `status IN ('RESERVED', 'RELEASED', 'SETTLED')`,
)
@Check(
  'player_trade_currency_escrows_resolution_check',
  `(status = 'RESERVED') = (resolution_transaction_id IS NULL)`,
)
export class PlayerTradeCurrencyEscrow {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'trade_id', type: 'uuid' })
  tradeId: string;
  @ManyToOne(() => PlayerTrade)
  @JoinColumn({
    name: 'trade_id',
    foreignKeyConstraintName: 'player_trade_currency_escrows_trade_fkey',
  })
  trade: Relation<PlayerTrade>;
  @Column({ name: 'game_server_id', type: 'uuid' })
  gameServerId: string;
  @Column({ type: 'varchar', length: 16 })
  currency: Currency;
  @Column({ name: 'character_external_id', type: 'varchar', length: 128 })
  characterExternalId: string;
  @Column({ type: 'bigint', transformer: bigintColumn })
  amount: number;
  @Column({ type: 'varchar', length: 16, default: 'RESERVED' })
  status: EscrowStatus;
  @Column({ name: 'reservation_transaction_id', type: 'uuid' })
  reservationTransactionId: string;
  @ManyToOne(() => EconomyTransaction)
  @JoinColumn({
    name: 'reservation_transaction_id',
    foreignKeyConstraintName: 'player_trade_currency_escrows_reservation_fkey',
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
    foreignKeyConstraintName: 'player_trade_currency_escrows_resolution_fkey',
  })
  resolutionTransaction: Relation<EconomyTransaction>;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
