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
import type { GuildStatus } from '../player-guild.contracts.js';

// Persistent, backend-owned guild on one game server (not a Skyrim faction).
// Names are unique per server among ACTIVE guilds by their normalized key;
// DISBANDED guilds stay as history and free the name.
@Entity('player_guilds')
@Unique('player_guilds_id_server_key', ['id', 'gameServerId'])
@Index('player_guilds_name_key', ['gameServerId', 'nameKey'], {
  unique: true,
  where: `status = 'ACTIVE'`,
})
@Check('player_guilds_status_check', `status IN ('ACTIVE', 'DISBANDED')`)
@Check(
  'player_guilds_disbanded_check',
  `(status = 'DISBANDED') = (disbanded_at IS NOT NULL)`,
)
@Check(
  'player_guilds_name_check',
  `char_length(name) BETWEEN 3 AND 48 AND name = btrim(name) AND char_length(name_key) > 0`,
)
export class PlayerGuild {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'game_server_id', type: 'uuid' })
  gameServerId: string;
  @ManyToOne(() => GameServer)
  @JoinColumn({
    name: 'game_server_id',
    foreignKeyConstraintName: 'player_guilds_server_fkey',
  })
  gameServer: Relation<GameServer>;
  @Column({ type: 'varchar', length: 48 })
  name: string;
  @Column({ name: 'name_key', type: 'text' })
  nameKey: string;
  @Column({ type: 'varchar', length: 16, default: 'ACTIVE' })
  status: GuildStatus;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
  @Column({ name: 'disbanded_at', type: 'timestamptz', nullable: true })
  disbandedAt: Date | null;
}
