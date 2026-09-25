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
import { PlayerCharacter } from '../../player-characters/entities/player-character.entity.js';
import { PlayerGroup } from './player-group.entity.js';
import type { GroupRole } from '../player-group.contracts.js';

// History is kept: leaving sets left_at. Partial unique indexes guarantee one
// active membership per character link and one active leader per group.
@Entity('player_group_members')
@Index('player_group_members_active_key', ['playerCharacterId'], {
  unique: true,
  where: `left_at IS NULL`,
})
@Index('player_group_members_leader_key', ['groupId'], {
  unique: true,
  where: `role = 'LEADER' AND left_at IS NULL`,
})
@Index('player_group_members_group_idx', ['groupId'])
@Check('player_group_members_role_check', `role IN ('LEADER', 'MEMBER')`)
@Check(
  'player_group_members_left_check',
  `left_at IS NULL OR left_at >= joined_at`,
)
export class PlayerGroupMember {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'group_id', type: 'uuid' })
  groupId: string;
  @ManyToOne(() => PlayerGroup)
  @JoinColumn({
    name: 'group_id',
    foreignKeyConstraintName: 'player_group_members_group_fkey',
  })
  group: Relation<PlayerGroup>;
  @Column({ name: 'player_character_id', type: 'uuid' })
  playerCharacterId: string;
  @ManyToOne(() => PlayerCharacter)
  @JoinColumn({
    name: 'player_character_id',
    foreignKeyConstraintName: 'player_group_members_character_fkey',
  })
  playerCharacter: Relation<PlayerCharacter>;
  @Column({ type: 'varchar', length: 16 })
  role: GroupRole;
  @Column({ name: 'joined_at', type: 'timestamptz' })
  joinedAt: Date;
  @Column({ name: 'left_at', type: 'timestamptz', nullable: true })
  leftAt: Date | null;
}
