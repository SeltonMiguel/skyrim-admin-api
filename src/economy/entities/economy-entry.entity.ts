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
import { bigintColumn } from '../economy.contracts.js';
import type { Currency } from '../economy.contracts.js';
import { EconomyAccount } from './economy-account.entity.js';
import { EconomyTransaction } from './economy-transaction.entity.js';

// One signed leg of a transaction. Composite FKs pin the entry to the same
// server and currency as both its transaction and its account.
@Entity('economy_entries')
@Unique('economy_entries_leg_key', ['transactionId', 'accountId'])
@Index('economy_entries_account_idx', ['accountId', 'createdAt'])
@Check(
  'economy_entries_amount_check',
  `amount <> 0 AND amount BETWEEN -1000000000000 AND 1000000000000`,
)
export class EconomyEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'transaction_id', type: 'uuid' })
  transactionId: string;
  @Column({ name: 'account_id', type: 'uuid' })
  accountId: string;
  @Column({ name: 'game_server_id', type: 'uuid' })
  gameServerId: string;
  @Column({ type: 'varchar', length: 16 })
  currency: Currency;
  @ManyToOne(() => EconomyTransaction)
  @JoinColumn([
    {
      name: 'transaction_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'economy_entries_transaction_fkey',
    },
    { name: 'game_server_id', referencedColumnName: 'gameServerId' },
    { name: 'currency', referencedColumnName: 'currency' },
  ])
  transaction: Relation<EconomyTransaction>;
  @ManyToOne(() => EconomyAccount)
  @JoinColumn([
    {
      name: 'account_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'economy_entries_account_fkey',
    },
    { name: 'game_server_id', referencedColumnName: 'gameServerId' },
    { name: 'currency', referencedColumnName: 'currency' },
  ])
  account: Relation<EconomyAccount>;
  @Column({ type: 'bigint', transformer: bigintColumn })
  amount: number;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
