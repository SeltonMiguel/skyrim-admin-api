import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { PlayerStatus } from '../player-account.contracts.js';

// Canonical player identity. No relation to staff_users by design; external
// identities and credentials live elsewhere (no password, email or tokens here).
@Entity('players')
@Check('players_status_check', `status IN ('ACTIVE', 'SUSPENDED', 'BANNED')`)
@Check('players_display_name_check', `length(btrim(display_name)) > 0`)
export class Player {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ type: 'varchar', length: 16, default: PlayerStatus.ACTIVE })
  status: PlayerStatus;
  @Column({ name: 'display_name', type: 'varchar', length: 64 })
  displayName: string;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
