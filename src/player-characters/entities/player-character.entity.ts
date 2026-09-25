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
import { Player } from '../../player-accounts/entities/player.entity.js';
import { GameServer } from '../../game-bridge/entities/game-server.entity.js';
import type { CharacterLinkStatus } from '../player-character.contracts.js';

// One row per (player, server, character); relinks reuse it. A character can
// be VERIFIED for at most one player per server (partial unique index).
@Entity('player_characters')
@Unique('player_characters_link_key', [
  'playerId',
  'gameServerId',
  'characterExternalId',
])
@Index(
  'player_characters_verified_key',
  ['gameServerId', 'characterExternalId'],
  { unique: true, where: `status = 'VERIFIED'` },
)
@Index('player_characters_player_idx', ['playerId', 'status'])
@Check(
  'player_characters_status_check',
  `status IN ('PENDING', 'VERIFIED', 'REVOKED')`,
)
@Check(
  'player_characters_character_check',
  `length(btrim(character_external_id)) > 0`,
)
@Check(
  'player_characters_lifecycle_check',
  `(status = 'PENDING' AND verified_at IS NULL AND revoked_at IS NULL) OR (status = 'VERIFIED' AND verified_at IS NOT NULL AND revoked_at IS NULL) OR (status = 'REVOKED' AND revoked_at IS NOT NULL)`,
)
export class PlayerCharacter {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'player_id', type: 'uuid' })
  playerId: string;
  @ManyToOne(() => Player)
  @JoinColumn({
    name: 'player_id',
    foreignKeyConstraintName: 'player_characters_player_fkey',
  })
  player: Relation<Player>;
  @Column({ name: 'game_server_id', type: 'uuid' })
  gameServerId: string;
  @ManyToOne(() => GameServer)
  @JoinColumn({
    name: 'game_server_id',
    foreignKeyConstraintName: 'player_characters_server_fkey',
  })
  gameServer: Relation<GameServer>;
  @Column({ name: 'character_external_id', type: 'varchar', length: 128 })
  characterExternalId: string;
  @Column({ type: 'varchar', length: 16, default: 'PENDING' })
  status: CharacterLinkStatus;
  @Column({ name: 'verified_at', type: 'timestamptz', nullable: true })
  verifiedAt: Date | null;
  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
