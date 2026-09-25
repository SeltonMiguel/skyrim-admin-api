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
} from 'typeorm';
import type { Relation } from 'typeorm';
import { GameServer } from '../../game-bridge/entities/game-server.entity.js';
import { CharacterProfession } from './character-profession.entity.js';

// Idempotency ledger for Agent XP grants. The Agent's event id is unique per
// game server; a replay never adds experience twice.
@Entity('profession_experience_events')
@Unique('profession_experience_events_event_key', [
  'gameServerId',
  'externalEventId',
])
@Index('profession_experience_events_profession_idx', ['characterProfessionId'])
@Check(
  'profession_experience_events_amount_check',
  `amount BETWEEN 1 AND 1000000`,
)
@Check(
  'profession_experience_events_event_check',
  `length(btrim(external_event_id)) > 0`,
)
export class ProfessionExperienceEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'character_profession_id', type: 'uuid' })
  characterProfessionId: string;
  @ManyToOne(() => CharacterProfession)
  @JoinColumn({
    name: 'character_profession_id',
    foreignKeyConstraintName: 'profession_experience_events_profession_fkey',
  })
  characterProfession: Relation<CharacterProfession>;
  @Column({ name: 'game_server_id', type: 'uuid' })
  gameServerId: string;
  @ManyToOne(() => GameServer)
  @JoinColumn({
    name: 'game_server_id',
    foreignKeyConstraintName: 'profession_experience_events_server_fkey',
  })
  gameServer: Relation<GameServer>;
  @Column({ name: 'external_event_id', type: 'varchar', length: 128 })
  externalEventId: string;
  @Column({ type: 'integer' })
  amount: number;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
