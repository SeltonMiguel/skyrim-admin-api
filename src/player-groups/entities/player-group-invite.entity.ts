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
import { PlayerCharacter } from '../../player-characters/entities/player-character.entity.js';
import { PlayerGroup } from './player-group.entity.js';
import type { GroupInviteStatus } from '../player-group.contracts.js';

// responded_at records when a non-PENDING outcome was reached (answer,
// cancellation or detected expiry). One PENDING invite per group + target.
@Entity('player_group_invites')
@Index(
  'player_group_invites_pending_key',
  ['groupId', 'targetPlayerCharacterId'],
  {
    unique: true,
    where: `status = 'PENDING'`,
  },
)
@Index('player_group_invites_target_idx', ['targetPlayerCharacterId', 'status'])
@Check(
  'player_group_invites_status_check',
  `status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED')`,
)
@Check(
  'player_group_invites_responded_check',
  `(status = 'PENDING') = (responded_at IS NULL)`,
)
@Check('player_group_invites_expiry_check', `expires_at > created_at`)
export class PlayerGroupInvite {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'group_id', type: 'uuid' })
  groupId: string;
  @ManyToOne(() => PlayerGroup)
  @JoinColumn({
    name: 'group_id',
    foreignKeyConstraintName: 'player_group_invites_group_fkey',
  })
  group: Relation<PlayerGroup>;
  @Column({ name: 'target_player_character_id', type: 'uuid' })
  targetPlayerCharacterId: string;
  @ManyToOne(() => PlayerCharacter)
  @JoinColumn({
    name: 'target_player_character_id',
    foreignKeyConstraintName: 'player_group_invites_target_fkey',
  })
  target: Relation<PlayerCharacter>;
  @Column({ name: 'invited_by_player_character_id', type: 'uuid' })
  invitedByPlayerCharacterId: string;
  @ManyToOne(() => PlayerCharacter)
  @JoinColumn({
    name: 'invited_by_player_character_id',
    foreignKeyConstraintName: 'player_group_invites_inviter_fkey',
  })
  invitedBy: Relation<PlayerCharacter>;
  @Column({ type: 'varchar', length: 16, default: 'PENDING' })
  status: GroupInviteStatus;
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;
  @Column({ name: 'responded_at', type: 'timestamptz', nullable: true })
  respondedAt: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
