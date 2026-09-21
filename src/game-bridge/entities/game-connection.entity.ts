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
import { GameServer } from './game-server.entity.js';

@Entity('game_connections')
@Unique('game_connections_external_key', [
  'gameServerId',
  'externalConnectionId',
])
@Index('game_connections_active_key', ['gameServerId'], {
  unique: true,
  where: `status = 'CONNECTED'`,
})
@Index('game_connections_heartbeat_idx', ['status', 'lastHeartbeatAt'])
@Check(
  'game_connections_status_check',
  `status IN ('CONNECTED', 'DISCONNECTED')`,
)
@Check(
  'game_connections_closed_check',
  `(status = 'CONNECTED' AND disconnected_at IS NULL AND disconnect_reason IS NULL) OR (status = 'DISCONNECTED' AND disconnected_at IS NOT NULL AND disconnect_reason IS NOT NULL)`,
)
export class GameConnection {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'game_server_id', type: 'uuid' })
  gameServerId: string;
  @ManyToOne(() => GameServer)
  @JoinColumn({
    name: 'game_server_id',
    foreignKeyConstraintName: 'game_connections_server_fkey',
  })
  gameServer: Relation<GameServer>;
  @Column({ name: 'external_connection_id', type: 'varchar', length: 128 })
  externalConnectionId: string;
  @Column({ name: 'status', type: 'varchar', length: 16 })
  status: 'CONNECTED' | 'DISCONNECTED';
  @Column({
    name: 'bridge_version',
    type: 'varchar',
    nullable: true,
    length: 64,
  })
  bridgeVersion: string | null;
  @Column({
    name: 'protocol_version',
    type: 'varchar',
    nullable: true,
    length: 16,
  })
  protocolVersion: string | null;
  @Column({ name: 'connected_at', type: 'timestamptz' })
  connectedAt: Date;
  @Column({ name: 'last_heartbeat_at', type: 'timestamptz' })
  lastHeartbeatAt: Date;
  @Column({ name: 'disconnected_at', type: 'timestamptz', nullable: true })
  disconnectedAt: Date | null;
  @Column({
    name: 'disconnect_reason',
    type: 'varchar',
    nullable: true,
    length: 32,
  })
  disconnectReason: 'SUPERSEDED' | 'STALE' | 'REQUESTED' | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
