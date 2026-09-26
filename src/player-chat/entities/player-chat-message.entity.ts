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
import { GameServer } from '../../game-bridge/entities/game-server.entity.js';
import { PlayerCharacter } from '../../player-characters/entities/player-character.entity.js';
import { PlayerGroup } from '../../player-groups/entities/player-group.entity.js';
import { PlayerGuild } from '../../player-guilds/entities/player-guild.entity.js';
import { StaffUser } from '../../staff/entities/staff-user.entity.js';
import type { ChatChannel } from '../player-chat.contracts.js';
import { PlayerChatDirectThread } from './player-chat-direct-thread.entity.js';

// Plain-text message kept until expires_at (retention); never edited. The
// channel decides which reference is set (CHECK) and an insert trigger pins
// the sender link and the reference to the message's server. 12.4: a
// moderator may hide it once (moderated_*, all-or-none); the content stays
// as evidence and the history trigger allows no other update.
@Entity('player_chat_messages')
@Index('player_chat_messages_global_idx', ['gameServerId', 'createdAt', 'id'], {
  where: `channel_type = 'GLOBAL'`,
})
@Index('player_chat_messages_group_idx', ['groupId', 'createdAt', 'id'], {
  where: `group_id IS NOT NULL`,
})
@Index('player_chat_messages_guild_idx', ['guildId', 'createdAt', 'id'], {
  where: `guild_id IS NOT NULL`,
})
@Index(
  'player_chat_messages_direct_idx',
  ['directThreadId', 'createdAt', 'id'],
  { where: `direct_thread_id IS NOT NULL` },
)
@Index('player_chat_messages_expiry_idx', ['expiresAt'])
@Check(
  'player_chat_messages_channel_check',
  `(channel_type = 'GLOBAL' AND group_id IS NULL AND guild_id IS NULL AND direct_thread_id IS NULL) OR (channel_type = 'GROUP' AND group_id IS NOT NULL AND guild_id IS NULL AND direct_thread_id IS NULL) OR (channel_type = 'GUILD' AND guild_id IS NOT NULL AND group_id IS NULL AND direct_thread_id IS NULL) OR (channel_type = 'DIRECT' AND direct_thread_id IS NOT NULL AND sender_player_character_id IS NOT NULL AND group_id IS NULL AND guild_id IS NULL)`,
)
@Check(
  'player_chat_messages_content_check',
  `char_length(content) BETWEEN 1 AND 500 AND content = btrim(content) AND content !~ '[[:cntrl:]]' AND length(btrim(sender_character_id)) > 0`,
)
@Check('player_chat_messages_expiry_check', `expires_at > created_at`)
@Check(
  'player_chat_messages_moderation_check',
  `(moderated_at IS NULL AND moderated_by_staff_id IS NULL AND moderation_reason IS NULL) OR (moderated_at IS NOT NULL AND moderated_by_staff_id IS NOT NULL AND moderation_reason IS NOT NULL)`,
)
export class PlayerChatMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'game_server_id', type: 'uuid' })
  gameServerId: string;
  @ManyToOne(() => GameServer)
  @JoinColumn({
    name: 'game_server_id',
    foreignKeyConstraintName: 'player_chat_messages_server_fkey',
  })
  gameServer: Relation<GameServer>;
  @Column({ name: 'channel_type', type: 'varchar', length: 16 })
  channelType: ChatChannel;
  @Column({ name: 'sender_character_id', type: 'varchar', length: 128 })
  senderCharacterId: string;
  // Internal: the ownership link that sent it; never exposed.
  @Column({
    name: 'sender_player_character_id',
    type: 'uuid',
    nullable: true,
  })
  senderPlayerCharacterId: string | null;
  @ManyToOne(() => PlayerCharacter)
  @JoinColumn({
    name: 'sender_player_character_id',
    foreignKeyConstraintName: 'player_chat_messages_sender_fkey',
  })
  senderPlayerCharacter: Relation<PlayerCharacter>;
  @Column({ name: 'group_id', type: 'uuid', nullable: true })
  groupId: string | null;
  @ManyToOne(() => PlayerGroup)
  @JoinColumn({
    name: 'group_id',
    foreignKeyConstraintName: 'player_chat_messages_group_fkey',
  })
  group: Relation<PlayerGroup>;
  @Column({ name: 'guild_id', type: 'uuid', nullable: true })
  guildId: string | null;
  @ManyToOne(() => PlayerGuild)
  @JoinColumn({
    name: 'guild_id',
    foreignKeyConstraintName: 'player_chat_messages_guild_fkey',
  })
  guild: Relation<PlayerGuild>;
  @Column({ name: 'direct_thread_id', type: 'uuid', nullable: true })
  directThreadId: string | null;
  @ManyToOne(() => PlayerChatDirectThread)
  @JoinColumn({
    name: 'direct_thread_id',
    foreignKeyConstraintName: 'player_chat_messages_thread_fkey',
  })
  directThread: Relation<PlayerChatDirectThread>;
  @Column({ type: 'text' })
  content: string;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;
  @Column({ name: 'moderated_at', type: 'timestamptz', nullable: true })
  moderatedAt: Date | null;
  @Column({ name: 'moderated_by_staff_id', type: 'uuid', nullable: true })
  moderatedByStaffId: string | null;
  @ManyToOne(() => StaffUser)
  @JoinColumn({
    name: 'moderated_by_staff_id',
    foreignKeyConstraintName: 'player_chat_messages_moderator_fkey',
  })
  moderatedByStaff: Relation<StaffUser>;
  @Column({
    name: 'moderation_reason',
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  moderationReason: string | null;
}
