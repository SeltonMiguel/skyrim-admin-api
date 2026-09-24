import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';
import { PlayerGuild } from './player-guild.entity.js';
import type { GuildInviteStatus } from '../player-guild.contracts.js';

// Invites address character identities on the guild's server. responded_at
// records when a non-PENDING outcome was reached (answer, cancellation or
// detected expiry). One PENDING invite per guild + target character.
@Entity('player_guild_invites')
@Index(
  'player_guild_invites_pending_key',
  ['guildId', 'targetCharacterExternalId'],
  { unique: true, where: `status = 'PENDING'` },
)
@Index('player_guild_invites_target_idx', [
  'gameServerId',
  'targetCharacterExternalId',
  'status',
])
@Check(
  'player_guild_invites_status_check',
  `status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED')`,
)
@Check(
  'player_guild_invites_responded_check',
  `(status = 'PENDING') = (responded_at IS NULL)`,
)
@Check('player_guild_invites_expiry_check', `expires_at > created_at`)
@Check(
  'player_guild_invites_character_check',
  `length(btrim(target_character_external_id)) > 0 AND length(btrim(invited_by_character_external_id)) > 0`,
)
export class PlayerGuildInvite {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'guild_id', type: 'uuid' })
  guildId: string;
  @Column({ name: 'game_server_id', type: 'uuid' })
  gameServerId: string;
  @ManyToOne(() => PlayerGuild)
  @JoinColumn([
    {
      name: 'guild_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'player_guild_invites_guild_fkey',
    },
    { name: 'game_server_id', referencedColumnName: 'gameServerId' },
  ])
  guild: Relation<PlayerGuild>;
  @Column({
    name: 'target_character_external_id',
    type: 'varchar',
    length: 128,
  })
  targetCharacterExternalId: string;
  @Column({
    name: 'invited_by_character_external_id',
    type: 'varchar',
    length: 128,
  })
  invitedByCharacterExternalId: string;
  @Column({ type: 'varchar', length: 16, default: 'PENDING' })
  status: GuildInviteStatus;
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;
  @Column({ name: 'responded_at', type: 'timestamptz', nullable: true })
  respondedAt: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
