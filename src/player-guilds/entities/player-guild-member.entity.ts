import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';
import { PlayerGuild } from './player-guild.entity.js';
import type { GuildRole } from '../player-guild.contracts.js';

// Membership belongs to the character identity (server + external id), not
// to an ownership link: it survives an owner change. History is kept via
// left_at. The composite FK pins the member to the guild's own server.
@Entity('player_guild_members')
@Index(
  'player_guild_members_active_key',
  ['gameServerId', 'characterExternalId'],
  { unique: true, where: `left_at IS NULL` },
)
@Index('player_guild_members_master_key', ['guildId'], {
  unique: true,
  where: `role = 'MASTER' AND left_at IS NULL`,
})
@Index('player_guild_members_guild_idx', ['guildId'])
@Check(
  'player_guild_members_role_check',
  `role IN ('MASTER', 'OFFICER', 'MEMBER')`,
)
@Check(
  'player_guild_members_left_check',
  `left_at IS NULL OR left_at >= joined_at`,
)
@Check(
  'player_guild_members_character_check',
  `length(btrim(character_external_id)) > 0`,
)
export class PlayerGuildMember {
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
      foreignKeyConstraintName: 'player_guild_members_guild_fkey',
    },
    { name: 'game_server_id', referencedColumnName: 'gameServerId' },
  ])
  guild: Relation<PlayerGuild>;
  @Column({ name: 'character_external_id', type: 'varchar', length: 128 })
  characterExternalId: string;
  @Column({ type: 'varchar', length: 16 })
  role: GuildRole;
  @Column({ name: 'joined_at', type: 'timestamptz' })
  joinedAt: Date;
  @Column({ name: 'left_at', type: 'timestamptz', nullable: true })
  leftAt: Date | null;
}
