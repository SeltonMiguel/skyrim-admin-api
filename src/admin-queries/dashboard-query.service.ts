import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { ApplicationConfig } from '../config/environment.js';
import { BridgeClock } from '../game-bridge/bridge-clock.js';
import type { GameServer } from '../game-bridge/entities/game-server.entity.js';
import type { GameCommand } from '../game-bridge/entities/game-command.entity.js';
import { CommandStatus } from '../game-bridge/command-state.js';
import { SERVER_HEALTH_SQL, ServerHealth } from './server-health.js';
import type { DashboardDto } from './dto/response.dto.js';

@Injectable()
export class DashboardQueryService {
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
  async get(): Promise<DashboardDto> {
    const now = this.clock.now();
    const [healthCounts, commandCounts] = await Promise.all([
      this.database
        .getRepository<GameServer>('GameServer')
        .createQueryBuilder('server')
        .leftJoin(
          'GameConnection',
          'connection',
          'connection.gameServerId = server.id AND connection.status = :connected',
          { connected: 'CONNECTED' },
        )
        .select(SERVER_HEALTH_SQL, 'health')
        .addSelect('COUNT(*)', 'count')
        .setParameter(
          'cutoff',
          new Date(now.getTime() - this.heartbeatTimeoutMs),
        )
        .groupBy(SERVER_HEALTH_SQL)
        .getRawMany<{ health: ServerHealth; count: string }>(),
      this.database
        .getRepository<GameCommand>('GameCommand')
        .createQueryBuilder('command')
        .select('command.status', 'status')
        .addSelect('COUNT(*)', 'count')
        .where('command.createdAt >= :from AND command.createdAt <= :to', {
          from: new Date(now.getTime() - 24 * 60 * 60 * 1000),
          to: now,
        })
        .groupBy('command.status')
        .getRawMany<{ status: CommandStatus; count: string }>(),
    ]);
    const health = { ONLINE: 0, STALE: 0, OFFLINE: 0, DISABLED: 0 };
    for (const row of healthCounts) health[row.health] = Number(row.count);
    const byStatus = {
      PENDING: 0,
      DISPATCHED: 0,
      ACKNOWLEDGED: 0,
      SUCCEEDED: 0,
      FAILED: 0,
      TIMEOUT: 0,
    };
    for (const row of commandCounts) byStatus[row.status] = Number(row.count);
    const enabled = health.ONLINE + health.STALE + health.OFFLINE;
    return {
      generatedAt: now,
      servers: {
        total: enabled + health.DISABLED,
        enabled,
        disabled: health.DISABLED,
        online: health.ONLINE,
        stale: health.STALE,
        offline: health.OFFLINE,
      },
      commands: {
        windowHours: 24,
        total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
        byStatus,
        attentionRequired: byStatus.FAILED + byStatus.TIMEOUT,
      },
    };
  }
}
