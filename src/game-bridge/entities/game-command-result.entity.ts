import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import type { Relation } from 'typeorm';
import { GameCommand } from './game-command.entity.js';
import type { TerminalStatus } from '../command-state.js';

@Entity('game_command_results')
@Unique('game_command_results_command_key', ['gameCommandId'])
@Check(
  'game_command_results_outcome_check',
  `outcome IN ('SUCCEEDED', 'FAILED', 'TIMEOUT')`,
)
@Check(
  'game_command_results_size_check',
  `result IS NULL OR (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 65536)`,
)
export class GameCommandResult {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'game_command_id', type: 'uuid' })
  gameCommandId: string;
  @ManyToOne(() => GameCommand)
  @JoinColumn({
    name: 'game_command_id',
    foreignKeyConstraintName: 'game_command_results_command_fkey',
  })
  gameCommand: Relation<GameCommand>;
  @Column({ name: 'outcome', type: 'varchar', length: 16 })
  outcome: TerminalStatus;
  @Column({ name: 'result', type: 'jsonb', nullable: true })
  result: object | null;
  @Column({ name: 'error_code', type: 'varchar', nullable: true, length: 64 })
  errorCode: string | null;
  @Column({
    name: 'error_message',
    type: 'varchar',
    nullable: true,
    length: 256,
  })
  errorMessage: string | null;
  @Column({ name: 'received_at', type: 'timestamptz' })
  receivedAt: Date;
}
