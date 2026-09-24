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
import { GameServer } from '../../game-bridge/entities/game-server.entity.js';
import { Player } from '../../player-accounts/entities/player.entity.js';
import { StaffUser } from '../../staff/entities/staff-user.entity.js';
import type { ActorType, SystemSource } from '../../actors/actor.contracts.js';
import type { Currency, EconomyTransactionType } from '../economy.contracts.js';

// Append-only (trigger). Attribution follows the Generic Actor (10.2) and
// idempotency is scoped per actor; request_fingerprint detects a key reused
// with different content. Balanced at commit by a deferred trigger.
@Entity('economy_transactions')
@Unique('economy_transactions_ledger_key', ['id', 'gameServerId', 'currency'])
@Unique('economy_transactions_idempotency_key', [
  'gameServerId',
  'idempotencyScope',
  'idempotencyKey',
])
@Check('economy_transactions_currency_check', `currency IN ('GOLD')`)
@Check(
  'economy_transactions_type_check',
  `type IN ('SYSTEM_CREDIT', 'SYSTEM_DEBIT', 'TRANSFER') AND (type = 'TRANSFER' OR actor_type = 'SYSTEM')`,
)
@Check(
  'economy_transactions_actor_check',
  `(actor_type = 'STAFF' AND actor_staff_id IS NOT NULL AND actor_player_id IS NULL AND actor_system_source IS NULL AND idempotency_scope = 'STAFF') OR (actor_type = 'PLAYER' AND actor_player_id IS NOT NULL AND actor_staff_id IS NULL AND actor_system_source IS NULL AND idempotency_scope = ('PLAYER:' || actor_player_id::text)) OR (actor_type = 'SYSTEM' AND actor_system_source IN ('AGENT', 'PROFESSION', 'VIP_DELIVERY') AND actor_staff_id IS NULL AND actor_player_id IS NULL AND idempotency_scope = ('SYSTEM:' || actor_system_source))`,
)
@Check('economy_transactions_key_check', `length(idempotency_key) > 0`)
@Check(
  'economy_transactions_reference_check',
  `(reference_type IS NULL) = (reference_id IS NULL)`,
)
export class EconomyTransaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'game_server_id', type: 'uuid' })
  gameServerId: string;
  @ManyToOne(() => GameServer)
  @JoinColumn({
    name: 'game_server_id',
    foreignKeyConstraintName: 'economy_transactions_server_fkey',
  })
  gameServer: Relation<GameServer>;
  @Column({ type: 'varchar', length: 16 })
  currency: Currency;
  @Column({ type: 'varchar', length: 32 })
  type: EconomyTransactionType;
  @Column({ name: 'actor_type', type: 'varchar', length: 16 })
  actorType: ActorType;
  @Column({ name: 'actor_player_id', type: 'uuid', nullable: true })
  actorPlayerId: string | null;
  @ManyToOne(() => Player)
  @JoinColumn({
    name: 'actor_player_id',
    foreignKeyConstraintName: 'economy_transactions_player_fkey',
  })
  actorPlayer: Relation<Player>;
  @Column({ name: 'actor_staff_id', type: 'uuid', nullable: true })
  actorStaffId: string | null;
  @ManyToOne(() => StaffUser)
  @JoinColumn({
    name: 'actor_staff_id',
    foreignKeyConstraintName: 'economy_transactions_staff_fkey',
  })
  actorStaff: Relation<StaffUser>;
  @Column({
    name: 'actor_system_source',
    type: 'varchar',
    length: 32,
    nullable: true,
  })
  actorSystemSource: SystemSource | null;
  @Column({ name: 'idempotency_scope', type: 'varchar', length: 64 })
  idempotencyScope: string;
  @Column({ name: 'idempotency_key', type: 'varchar', length: 128 })
  idempotencyKey: string;
  @Column({ name: 'request_fingerprint', type: 'char', length: 64 })
  requestFingerprint: string;
  @Column({
    name: 'reference_type',
    type: 'varchar',
    length: 32,
    nullable: true,
  })
  referenceType: string | null;
  @Column({
    name: 'reference_id',
    type: 'varchar',
    length: 128,
    nullable: true,
  })
  referenceId: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
