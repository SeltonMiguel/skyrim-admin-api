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
import { GameAgentCredential } from '../../game-agent/entities/game-agent-credential.entity.js';
import type { GameProcessState } from '../../game-agent/agent-protocol.contracts.js';

export const DISCONNECT_REASONS = [
  'SUPERSEDED',
  'STALE',
  'REQUESTED',
  'CLOSED',
  'CREDENTIAL_REVOKED',
  'SHUTDOWN',
  'BACKEND_RESTART',
] as const;
export type DisconnectReason = (typeof DISCONNECT_REASONS)[number];

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
@Index('game_connections_credential_idx', ['credentialId'])
@Index('game_connections_owner_idx', ['ownerInstanceId'], {
  where: `status = 'CONNECTED'`,
})
@Check(
  'game_connections_reason_check',
  `disconnect_reason IS NULL OR disconnect_reason IN ('SUPERSEDED', 'STALE', 'REQUESTED', 'CLOSED', 'CREDENTIAL_REVOKED', 'SHUTDOWN', 'BACKEND_RESTART')`,
)
@Check(
  'game_connections_agent_check',
  `(credential_id IS NULL AND game_process_state IS NULL AND skse_ready IS NULL) OR (credential_id IS NOT NULL AND game_process_state IN ('UNKNOWN', 'STOPPED', 'STARTING', 'RUNNING', 'PAUSED', 'STOPPING', 'RESTARTING') AND skse_ready IS NOT NULL)`,
)
@Check(
  'game_connections_capabilities_check',
  `CASE WHEN jsonb_typeof(capabilities) = 'array' THEN jsonb_array_length(capabilities) <= 64 ELSE false END`,
)
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
  disconnectReason: DisconnectReason | null;
  // Host Agent session (11.1): the credential that authenticated it and the
  // latest runtime snapshot. Null only for sessions opened through the
  // internal service without the Agent transport. bridge_version holds the
  // Host Agent version.
  @Column({ name: 'credential_id', type: 'uuid', nullable: true })
  credentialId: string | null;
  @ManyToOne(() => GameAgentCredential)
  @JoinColumn({
    name: 'credential_id',
    foreignKeyConstraintName: 'game_connections_credential_fkey',
  })
  credential: Relation<GameAgentCredential> | null;
  @Column({ type: 'jsonb', default: () => "'[]'" })
  capabilities: string[];
  @Column({
    name: 'game_process_state',
    type: 'varchar',
    length: 16,
    nullable: true,
  })
  gameProcessState: GameProcessState | null;
  @Column({ name: 'skse_ready', type: 'boolean', nullable: true })
  skseReady: boolean | null;
  // 12.5: the process execution holding this socket (InstanceIdentity).
  // Its lease is the heartbeat freshness; only the owner renews it, and
  // only the owner may dispatch to or accept frames from this session.
  @Column({ name: 'owner_instance_id', type: 'uuid', nullable: true })
  ownerInstanceId: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
