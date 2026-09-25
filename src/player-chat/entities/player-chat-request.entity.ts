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
import { Player } from '../../player-accounts/entities/player.entity.js';
import { PlayerChatMessage } from './player-chat-message.entity.js';

// Send idempotency (scope PLAYER:<playerId>), claimed in the message
// transaction; independent from game command idempotency. It shares the
// message's expiry and goes away with it (ON DELETE CASCADE) when a future
// purge removes the expired message.
@Entity('player_chat_requests')
@Unique('player_chat_requests_idempotency_key', [
  'idempotencyScope',
  'idempotencyKey',
])
@Check(
  'player_chat_requests_scope_check',
  `idempotency_scope = ('PLAYER:' || player_id::text) AND length(idempotency_key) > 0`,
)
export class PlayerChatRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'idempotency_scope', type: 'varchar', length: 64 })
  idempotencyScope: string;
  @Column({ name: 'idempotency_key', type: 'varchar', length: 128 })
  idempotencyKey: string;
  @Column({ name: 'player_id', type: 'uuid' })
  playerId: string;
  @ManyToOne(() => Player)
  @JoinColumn({
    name: 'player_id',
    foreignKeyConstraintName: 'player_chat_requests_player_fkey',
  })
  player: Relation<Player>;
  @Column({ name: 'request_fingerprint', type: 'char', length: 64 })
  requestFingerprint: string;
  @Column({ name: 'message_id', type: 'uuid' })
  messageId: string;
  @ManyToOne(() => PlayerChatMessage, {
    onDelete: 'CASCADE',
    deferrable: 'INITIALLY DEFERRED',
  })
  @JoinColumn({
    name: 'message_id',
    foreignKeyConstraintName: 'player_chat_requests_message_fkey',
  })
  message: Relation<PlayerChatMessage>;
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
