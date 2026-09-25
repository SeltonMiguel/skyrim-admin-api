import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import type { ApplicationConfig } from '../config/environment.js';
import { BridgeClock } from './bridge-clock.js';
import { identifier, PROTOCOL_VERSION, uuid } from './command-contract.js';
import { GameServerService } from './game-server.service.js';
import { GameConnection } from './entities/game-connection.entity.js';
import type { DisconnectReason } from './entities/game-connection.entity.js';
import type { GameProcessState } from '../game-agent/agent-protocol.contracts.js';

export interface RuntimeSnapshot {
  gameProcessState: GameProcessState;
  skseReady: boolean;
  capabilities?: readonly string[];
}
export interface ConnectInput {
  gameServerId: string;
  externalConnectionId: string;
  bridgeVersion?: string;
  protocolVersion?: typeof PROTOCOL_VERSION;
  // Host Agent session data; absent for internal (transport-less) callers.
  agent?: {
    credentialId: string;
    capabilities: readonly string[];
    gameProcessState: GameProcessState;
    skseReady: boolean;
  } | null;
}

@Injectable()
export class GameConnectionService {
  private readonly timeout: number;
  constructor(
    private readonly database: DataSource,
    private readonly servers: GameServerService,
    private readonly clock: BridgeClock,
    config: ConfigService<{ application: ApplicationConfig }, true>,
  ) {
    this.timeout = config.get('application', {
      infer: true,
    }).gameBridge.heartbeatTimeoutMs;
  }
  healthy(
    connection: GameConnection | null,
    now = this.clock.now(),
  ): connection is GameConnection {
    return (
      !!connection &&
      connection.status === 'CONNECTED' &&
      connection.lastHeartbeatAt.getTime() + this.timeout > now.getTime()
    );
  }
  active(serverId: string, manager: EntityManager = this.database.manager) {
    return manager
      .getRepository<GameConnection>('GameConnection')
      .findOneBy({ gameServerId: serverId, status: 'CONNECTED' });
  }
  async isConnectionHealthy(serverId: string): Promise<boolean> {
    const server = await this.servers.get(serverId);
    return server.enabled && this.healthy(await this.active(serverId));
  }
  async connect(input: ConnectInput): Promise<GameConnection> {
    return this.database.transaction((manager) =>
      this.connectInTransaction(manager, input),
    );
  }
  // Caller owns the short transaction (the Host Agent HELLO also verifies its
  // credential under the same server lock). The previous CONNECTED session of
  // the server is closed as SUPERSEDED; the partial unique index keeps one.
  async connectInTransaction(
    manager: EntityManager,
    input: ConnectInput,
  ): Promise<GameConnection> {
    const {
      gameServerId,
      externalConnectionId,
      bridgeVersion = null,
      protocolVersion = PROTOCOL_VERSION,
      agent = null,
    } = input;
    identifier(externalConnectionId, 'external connection ID');
    if (bridgeVersion !== null) identifier(bridgeVersion, 'bridge version', 64);
    if (protocolVersion !== PROTOCOL_VERSION)
      throw new BadRequestException('Unsupported protocol version');
    if (agent) uuid(agent.credentialId);
    const server = await this.servers.get(gameServerId, manager, true);
    if (!server.enabled) throw new ConflictException('Game server disabled');
    const repository = manager.getRepository<GameConnection>('GameConnection');
    const previous = await repository.findOneBy({
      gameServerId,
      externalConnectionId,
    });
    if (previous) {
      if (this.healthy(previous)) return previous;
      throw new ConflictException('Connection ID cannot be reused');
    }
    const now = this.clock.now();
    await repository.update(
      { gameServerId, status: 'CONNECTED' },
      {
        status: 'DISCONNECTED',
        disconnectedAt: now,
        disconnectReason: 'SUPERSEDED',
      },
    );
    return repository.save(
      repository.create({
        id: randomUUID(),
        gameServerId,
        externalConnectionId,
        bridgeVersion,
        protocolVersion,
        status: 'CONNECTED',
        connectedAt: now,
        lastHeartbeatAt: now,
        disconnectedAt: null,
        disconnectReason: null,
        credentialId: agent?.credentialId ?? null,
        capabilities: agent ? [...agent.capabilities] : [],
        gameProcessState: agent?.gameProcessState ?? null,
        skseReady: agent?.skseReady ?? null,
        createdAt: now,
      }),
    );
  }
  // A Host Agent heartbeat also refreshes the runtime snapshot; omitted
  // capabilities keep the announced ones.
  async heartbeat(
    serverId: string,
    connectionId: string,
    runtime?: RuntimeSnapshot,
  ): Promise<boolean> {
    uuid(connectionId);
    return this.database.transaction(async (manager) => {
      const server = await this.servers.get(serverId, manager, true);
      const connection = await this.active(serverId, manager);
      if (!server.enabled || !connection || connection.id !== connectionId)
        return false;
      const now = this.clock.now();
      if (!this.healthy(connection, now)) {
        await this.close(manager, connection, 'STALE', now);
        return false;
      }
      connection.lastHeartbeatAt = now;
      if (runtime && connection.credentialId) {
        connection.gameProcessState = runtime.gameProcessState;
        connection.skseReady = runtime.skseReady;
        if (runtime.capabilities)
          connection.capabilities = [...runtime.capabilities];
      }
      await manager
        .getRepository<GameConnection>('GameConnection')
        .save(connection);
      return true;
    });
  }
  // Runtime snapshot reported outside a heartbeat (Server Control result).
  // One autocommit UPDATE on the connection row: no server lock and no
  // liveness refresh. Only an active Host Agent session is updated.
  async updateRuntime(
    serverId: string,
    connectionId: string,
    runtime: Omit<RuntimeSnapshot, 'capabilities'>,
  ): Promise<boolean> {
    uuid(connectionId);
    const result = await this.database
      .getRepository<GameConnection>('GameConnection')
      .createQueryBuilder()
      .update()
      .set({
        gameProcessState: runtime.gameProcessState,
        skseReady: runtime.skseReady,
      })
      .where('id = :connectionId AND game_server_id = :serverId', {
        connectionId,
        serverId,
      })
      .andWhere("status = 'CONNECTED' AND credential_id IS NOT NULL")
      .execute();
    return result.affected === 1;
  }
  async disconnect(serverId: string, connectionId: string): Promise<boolean> {
    return this.end(serverId, connectionId, 'REQUESTED');
  }
  // Closes the session only while it is still the server's active one;
  // returns false for an already closed, superseded or unknown session.
  async end(
    serverId: string,
    connectionId: string,
    reason: DisconnectReason,
  ): Promise<boolean> {
    uuid(connectionId);
    return this.database.transaction(async (manager) => {
      await this.servers.get(serverId, manager, true);
      const connection = await this.active(serverId, manager);
      if (!connection || connection.id !== connectionId) return false;
      await this.close(manager, connection, reason, this.clock.now());
      return true;
    });
  }
  // Closes every session of a credential (revocation), inside the caller's
  // transaction; the caller then closes the matching sockets after commit.
  async endByCredential(
    manager: EntityManager,
    credentialId: string,
  ): Promise<number> {
    const result = await manager
      .getRepository<GameConnection>('GameConnection')
      .update(
        { credentialId, status: 'CONNECTED' },
        {
          status: 'DISCONNECTED',
          disconnectedAt: this.clock.now(),
          disconnectReason: 'CREDENTIAL_REVOKED',
        },
      );
    return result.affected ?? 0;
  }
  // Startup reconciliation: sockets never survive a restart, so no persisted
  // session can still be live in this (single) instance. History is kept.
  async endAllActive(reason: DisconnectReason): Promise<number> {
    const result = await this.database
      .getRepository<GameConnection>('GameConnection')
      .update(
        { status: 'CONNECTED' },
        {
          status: 'DISCONNECTED',
          disconnectedAt: this.clock.now(),
          disconnectReason: reason,
        },
      );
    return result.affected ?? 0;
  }
  async markStaleConnections(): Promise<number> {
    const candidates = await this.database
      .getRepository<GameConnection>('GameConnection')
      .createQueryBuilder('connection')
      .where('connection.status = :status', { status: 'CONNECTED' })
      .andWhere('connection.lastHeartbeatAt <= :cutoff', {
        cutoff: new Date(this.clock.now().getTime() - this.timeout),
      })
      .orderBy('connection.lastHeartbeatAt', 'ASC')
      .take(100)
      .getMany();
    let count = 0;
    for (const candidate of candidates) {
      count += await this.database.transaction(async (manager) => {
        await this.servers.get(candidate.gameServerId, manager, true);
        const current = await this.active(candidate.gameServerId, manager);
        if (!current || current.id !== candidate.id || this.healthy(current))
          return 0;
        await this.close(manager, current, 'STALE', this.clock.now());
        return 1;
      });
    }
    return count;
  }
  private async close(
    manager: EntityManager,
    connection: GameConnection,
    reason: DisconnectReason,
    now: Date,
  ): Promise<void> {
    connection.status = 'DISCONNECTED';
    connection.disconnectedAt = now;
    connection.disconnectReason = reason;
    await manager
      .getRepository<GameConnection>('GameConnection')
      .save(connection);
  }
}
