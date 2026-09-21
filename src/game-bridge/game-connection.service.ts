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
  async connect(input: {
    gameServerId: string;
    externalConnectionId: string;
    bridgeVersion?: string;
    protocolVersion?: typeof PROTOCOL_VERSION;
  }): Promise<GameConnection> {
    const {
      gameServerId,
      externalConnectionId,
      bridgeVersion = null,
      protocolVersion = PROTOCOL_VERSION,
    } = input;
    identifier(externalConnectionId, 'external connection ID');
    if (bridgeVersion !== null) identifier(bridgeVersion, 'bridge version', 64);
    if (protocolVersion !== PROTOCOL_VERSION)
      throw new BadRequestException('Unsupported protocol version');
    return this.database.transaction(async (manager) => {
      const server = await this.servers.get(gameServerId, manager, true);
      if (!server.enabled) throw new ConflictException('Game server disabled');
      const repository =
        manager.getRepository<GameConnection>('GameConnection');
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
          createdAt: now,
        }),
      );
    });
  }
  async heartbeat(serverId: string, connectionId: string): Promise<boolean> {
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
      await manager
        .getRepository<GameConnection>('GameConnection')
        .save(connection);
      return true;
    });
  }
  async disconnect(serverId: string, connectionId: string): Promise<boolean> {
    uuid(connectionId);
    return this.database.transaction(async (manager) => {
      await this.servers.get(serverId, manager, true);
      const connection = await this.active(serverId, manager);
      if (!connection || connection.id !== connectionId) return false;
      await this.close(manager, connection, 'REQUESTED', this.clock.now());
      return true;
    });
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
    reason: GameConnection['disconnectReason'],
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
