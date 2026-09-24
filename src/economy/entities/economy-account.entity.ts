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
import { GameServer } from '../../game-bridge/entities/game-server.entity.js';
import { bigintColumn } from '../economy.contracts.js';
import type {
  Currency,
  EconomyOwnerType,
  SystemAccountKey,
} from '../economy.contracts.js';

// One account per character identity (server + currency + external id) or
// per system key. balance is a projection of the entries kept by a
// database trigger; it is never written directly.
@Entity('economy_accounts')
@Unique('economy_accounts_ledger_key', ['id', 'gameServerId', 'currency'])
@Index(
  'economy_accounts_character_key',
  ['gameServerId', 'currency', 'characterExternalId'],
  { unique: true, where: `owner_type = 'CHARACTER'` },
)
@Index(
  'economy_accounts_system_key',
  ['gameServerId', 'currency', 'systemKey'],
  { unique: true, where: `owner_type = 'SYSTEM'` },
)
@Check('economy_accounts_currency_check', `currency IN ('GOLD')`)
@Check(
  'economy_accounts_owner_check',
  `(owner_type = 'CHARACTER' AND character_external_id IS NOT NULL AND length(btrim(character_external_id)) > 0 AND system_key IS NULL) OR (owner_type = 'SYSTEM' AND character_external_id IS NULL AND system_key IN ('MINT', 'BURN', 'TRADE_ESCROW', 'MARKET_ESCROW'))`,
)
@Check(
  'economy_accounts_balance_check',
  `(owner_type = 'CHARACTER' AND balance BETWEEN 0 AND 1000000000000) OR (owner_type = 'SYSTEM' AND balance BETWEEN -9000000000000000 AND 9000000000000000)`,
)
export class EconomyAccount {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'game_server_id', type: 'uuid' })
  gameServerId: string;
  @ManyToOne(() => GameServer)
  @JoinColumn({
    name: 'game_server_id',
    foreignKeyConstraintName: 'economy_accounts_server_fkey',
  })
  gameServer: Relation<GameServer>;
  @Column({ type: 'varchar', length: 16 })
  currency: Currency;
  @Column({ name: 'owner_type', type: 'varchar', length: 16 })
  ownerType: EconomyOwnerType;
  @Column({
    name: 'character_external_id',
    type: 'varchar',
    length: 128,
    nullable: true,
  })
  characterExternalId: string | null;
  @Column({ name: 'system_key', type: 'varchar', length: 32, nullable: true })
  systemKey: SystemAccountKey | null;
  @Column({ type: 'bigint', default: 0, transformer: bigintColumn })
  balance: number;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
