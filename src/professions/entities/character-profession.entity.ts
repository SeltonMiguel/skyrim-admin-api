import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';
import { GameServer } from '../../game-bridge/entities/game-server.entity.js';
import type { Profession } from '../profession.contracts.js';

// bigint is returned by pg as a string; values are bounded far below 2^53.
export const bigintNumber = {
  to: (value: number) => value,
  from: (value: string | null) => (value === null ? value : Number(value)),
};

// The current (only) profession of a CHARACTER, identified like the game does:
// server + character id. It is independent of ownership links, so progress
// survives a future owner change. No change history: switching does not exist.
@Entity('character_professions')
@Unique('character_professions_character_key', [
  'gameServerId',
  'characterExternalId',
])
@Check(
  'character_professions_character_check',
  `length(btrim(character_external_id)) > 0`,
)
@Check(
  'character_professions_profession_check',
  `profession IN ('TAILOR', 'HUNTER', 'MINER', 'BLACKSMITH', 'ALCHEMIST', 'CHARCOAL_BURNER', 'COOK')`,
)
@Check(
  'character_professions_experience_check',
  `experience >= 0 AND experience <= 1000000000000`,
)
@Check('character_professions_level_check', `level BETWEEN 1 AND 100`)
// Level must match XP: 100 * (level - 1)^2 <= xp < 100 * level^2 (capped at 100).
@Check(
  'character_professions_progression_check',
  `experience >= 100 * (level - 1)::bigint * (level - 1) AND (level = 100 OR experience < 100 * level::bigint * level)`,
)
export class CharacterProfession {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'game_server_id', type: 'uuid' })
  gameServerId: string;
  @ManyToOne(() => GameServer)
  @JoinColumn({
    name: 'game_server_id',
    foreignKeyConstraintName: 'character_professions_server_fkey',
  })
  gameServer: Relation<GameServer>;
  @Column({ name: 'character_external_id', type: 'varchar', length: 128 })
  characterExternalId: string;
  @Column({ type: 'varchar', length: 32 })
  profession: Profession;
  @Column({
    type: 'bigint',
    default: 0,
    transformer: bigintNumber,
  })
  experience: number;
  @Column({ type: 'integer', default: 1 })
  level: number;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
