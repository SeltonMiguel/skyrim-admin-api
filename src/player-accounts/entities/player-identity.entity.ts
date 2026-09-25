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
import { Player } from './player.entity.js';
import type { IdentityProvider } from '../player-account.contracts.js';

// One external account belongs to exactly one player; the UNIQUE constraint is
// the final authority. OAuth tokens are never stored.
@Entity('player_identities')
@Unique('player_identities_provider_subject_key', [
  'provider',
  'providerSubject',
])
@Index('player_identities_player_idx', ['playerId'])
@Check('player_identities_provider_check', `provider IN ('DISCORD', 'STEAM')`)
@Check('player_identities_subject_check', `length(btrim(provider_subject)) > 0`)
export class PlayerIdentity {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'player_id', type: 'uuid' })
  playerId: string;
  @ManyToOne(() => Player)
  @JoinColumn({
    name: 'player_id',
    foreignKeyConstraintName: 'player_identities_player_fkey',
  })
  player: Relation<Player>;
  @Column({ type: 'varchar', length: 32 })
  provider: IdentityProvider;
  @Column({ name: 'provider_subject', type: 'varchar', length: 128 })
  providerSubject: string;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
