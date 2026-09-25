import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import type { Relation } from 'typeorm';
import { GameServer } from '../../game-bridge/entities/game-server.entity.js';
import { PlayerCharacter } from '../../player-characters/entities/player-character.entity.js';

// A private DIRECT conversation between two ownership links (never bare
// character ids): a new owner of either character does not inherit it. The
// pair is canonical (a < b) so there is one thread per pair; a trigger pins
// both links to the thread's server. Ids are never exposed.
@Entity('player_chat_direct_threads')
@Unique('player_chat_direct_threads_pair_key', [
  'participantAPlayerCharacterId',
  'participantBPlayerCharacterId',
])
@Check(
  'player_chat_direct_threads_pair_check',
  `participant_a_player_character_id < participant_b_player_character_id`,
)
export class PlayerChatDirectThread {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'game_server_id', type: 'uuid' })
  gameServerId: string;
  @ManyToOne(() => GameServer)
  @JoinColumn({
    name: 'game_server_id',
    foreignKeyConstraintName: 'player_chat_direct_threads_server_fkey',
  })
  gameServer: Relation<GameServer>;
  @Column({ name: 'participant_a_player_character_id', type: 'uuid' })
  participantAPlayerCharacterId: string;
  @ManyToOne(() => PlayerCharacter)
  @JoinColumn({
    name: 'participant_a_player_character_id',
    foreignKeyConstraintName: 'player_chat_direct_threads_a_fkey',
  })
  participantA: Relation<PlayerCharacter>;
  @Column({ name: 'participant_b_player_character_id', type: 'uuid' })
  participantBPlayerCharacterId: string;
  @ManyToOne(() => PlayerCharacter)
  @JoinColumn({
    name: 'participant_b_player_character_id',
    foreignKeyConstraintName: 'player_chat_direct_threads_b_fkey',
  })
  participantB: Relation<PlayerCharacter>;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
