import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { ApplicationConfig } from '../config/environment.js';
import { BridgeClock } from '../game-bridge/bridge-clock.js';
import type { GameServer } from '../game-bridge/entities/game-server.entity.js';
import type { GameConnection } from '../game-bridge/entities/game-connection.entity.js';
import { ConnectionQueryDto, ServerQueryDto } from './dto/query.dto.js';
import { connectionHistory, publicServer } from './query.presenters.js';
import type { ServerWithConnection } from './query.presenters.js';
import { dateRange, filterDates, pageResult } from './query-pagination.js';
import { SERVER_HEALTH_SQL } from './server-health.js';

@Injectable()
export class GameServerQueryService {
  private readonly heartbeatTimeoutMs: number;
  constructor(
    private readonly database: DataSource,
    private readonly clock: BridgeClock,
    config: ConfigService<{ application: ApplicationConfig }, true>,
  ) {
    this.heartbeatTimeoutMs = config.get('application', {
      infer: true,
    }).gameBridge.heartbeatTimeoutMs;
  }
  private cutoff(): Date {
    return new Date(this.clock.now().getTime() - this.heartbeatTimeoutMs);
  }
  private servers() {
    return this.database
      .getRepository<ServerWithConnection>('GameServer')
      .createQueryBuilder('server')
      .leftJoinAndMapOne(
        'server.currentConnection',
        'GameConnection',
        'connection',
        'connection.gameServerId = server.id AND connection.status = :connected',
        { connected: 'CONNECTED' },
      );
  }
  async list(query: ServerQueryDto) {
    const cutoff = this.cutoff();
    const builder = this.servers();
    if (query.code !== undefined)
      builder.andWhere('server.code = :code', { code: query.code });
    if (query.enabled !== undefined)
      builder.andWhere('server.enabled = :enabled', { enabled: query.enabled });
    if (query.health !== undefined)
      builder.andWhere(`(${SERVER_HEALTH_SQL}) = :health`, {
        cutoff,
        health: query.health,
      });
    const [items, total] = await builder
      .orderBy('server.name', 'ASC')
      .addOrderBy('server.id', 'ASC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();
    return pageResult(
      items.map((server) => publicServer(server, cutoff)),
      total,
      query,
    );
  }
  async get(id: string) {
    const cutoff = this.cutoff();
    const server = await this.servers()
      .where('server.id = :id', { id })
      .getOne();
    if (!server) throw new NotFoundException('Game server not found');
    return publicServer(server, cutoff);
  }
  async requireServer(id: string): Promise<void> {
    if (
      !(await this.database
        .getRepository<GameServer>('GameServer')
        .existsBy({ id }))
    )
      throw new NotFoundException('Game server not found');
  }
  async connections(id: string, query: ConnectionQueryDto) {
    const range = dateRange(query);
    await this.requireServer(id);
    const builder = this.database
      .getRepository<GameConnection>('GameConnection')
      .createQueryBuilder('connection')
      .where('connection.gameServerId = :id', { id });
    if (query.status !== undefined)
      builder.andWhere('connection.status = :status', { status: query.status });
    filterDates(builder, 'connection.connectedAt', range);
    const [items, total] = await builder
      .orderBy('connection.connectedAt', 'DESC')
      .addOrderBy('connection.id', 'DESC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();
    return pageResult(items.map(connectionHistory), total, query);
  }
}
