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
import { PlayerCharacter } from './player-character.entity.js';

// Only the SHA-256 digest of the normalized challenge is stored. At most one
// challenge per link is neither consumed nor revoked (partial unique index).
@Entity('player_character_link_challenges')
@Unique('player_character_link_challenges_hash_key', ['challengeHash'])
@Index('player_character_link_challenges_active_key', ['playerCharacterId'], {
  unique: true,
  where: `consumed_at IS NULL AND revoked_at IS NULL`,
})
@Index('player_character_link_challenges_link_idx', ['playerCharacterId'])
@Check(
  'player_character_link_challenges_hash_check',
  `challenge_hash ~ '^[0-9a-f]{64}$'`,
)
@Check(
  'player_character_link_challenges_final_check',
  `consumed_at IS NULL OR revoked_at IS NULL`,
)
@Check(
  'player_character_link_challenges_expiry_check',
  `expires_at > created_at`,
)
export class PlayerCharacterLinkChallenge {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'player_character_id', type: 'uuid' })
  playerCharacterId: string;
  @ManyToOne(() => PlayerCharacter)
  @JoinColumn({
    name: 'player_character_id',
    foreignKeyConstraintName: 'player_character_link_challenges_link_fkey',
  })
  playerCharacter: Relation<PlayerCharacter>;
  @Column({
    name: 'challenge_hash',
    type: 'varchar',
    length: 64,
    select: false,
  })
  challengeHash: string;
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;
  @Column({ name: 'consumed_at', type: 'timestamptz', nullable: true })
  consumedAt: Date | null;
  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
