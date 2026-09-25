import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';
import { Player } from '../../player-accounts/entities/player.entity.js';

// At most one row per player, created by the first effective change; a
// player without a row uses the defaults. Never tied to a character, an
// ownership link or a game server.
@Entity('player_settings')
@Check(
  'player_settings_locale_check',
  `char_length(locale) BETWEEN 1 AND 35 AND locale ~ '^[A-Za-z0-9-]+$'`,
)
@Check(
  'player_settings_time_zone_check',
  `char_length(time_zone) BETWEEN 1 AND 64 AND time_zone ~ '^[A-Za-z][A-Za-z0-9_+/-]*$'`,
)
export class PlayerSettings {
  @PrimaryColumn({ name: 'player_id', type: 'uuid' })
  playerId: string;
  @ManyToOne(() => Player)
  @JoinColumn({
    name: 'player_id',
    foreignKeyConstraintName: 'player_settings_player_fkey',
  })
  player: Relation<Player>;
  @Column({ type: 'varchar', length: 35 })
  locale: string;
  @Column({ name: 'time_zone', type: 'varchar', length: 64 })
  timeZone: string;
  @Column({ name: 'allow_direct_messages', type: 'boolean', default: true })
  allowDirectMessages: boolean;
  @Column({ name: 'allow_trade_requests', type: 'boolean', default: true })
  allowTradeRequests: boolean;
  @Column({ name: 'allow_group_invites', type: 'boolean', default: true })
  allowGroupInvites: boolean;
  @Column({ name: 'allow_guild_invites', type: 'boolean', default: true })
  allowGuildInvites: boolean;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
