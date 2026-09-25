import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { pageResult } from '../admin-queries/query-pagination.js';
import { isRuntimeReady } from '../game-agent/agent-protocol.contracts.js';
import { BridgeClock } from '../game-bridge/bridge-clock.js';
import { GameConnectionService } from '../game-bridge/game-connection.service.js';
import type { GameServer } from '../game-bridge/entities/game-server.entity.js';
import type { GameConnection } from '../game-bridge/entities/game-connection.entity.js';
import type {
  PlayerGameServerDto,
  PlayerGameServersQueryDto,
} from './player-game-server.dto.js';

type Server = GameServer & { currentConnection: GameConnection | null };
@Injectable()
export class PlayerGameServerService {
  constructor(
    private readonly database: DataSource,
    private readonly connections: GameConnectionService,
    private readonly clock: BridgeClock,
  ) {}
  async list(query: PlayerGameServersQueryDto) {
    const [servers, total] = await this.database
      .getRepository<Server>('GameServer')
      .createQueryBuilder('server')
      .leftJoinAndMapOne(
        'server.currentConnection',
        'GameConnection',
        'connection',
        "connection.gameServerId = server.id AND connection.status = 'CONNECTED' AND connection.credentialId IS NOT NULL",
      )
      .select([
        'server.id',
        'server.code',
        'server.name',
        'server.enabled',
        'connection.id',
        'connection.status',
        'connection.lastHeartbeatAt',
        'connection.gameProcessState',
        'connection.skseReady',
      ])
      .where('server.enabled = true')
      .orderBy('server.name', 'ASC')
      .addOrderBy('server.id', 'ASC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();
    const now = this.clock.now();
    return pageResult(
      servers.map((server): PlayerGameServerDto => {
        const connection = server.currentConnection;
        const agentConnected = this.connections.healthy(connection, now);
        return {
          id: server.id,
          code: server.code,
          name: server.name,
          enabled: server.enabled,
          agentConnected,
          gameProcessState: agentConnected
            ? connection!.gameProcessState
            : null,
          gameReady:
            agentConnected &&
            isRuntimeReady({
              gameProcessState: connection!.gameProcessState!,
              skseReady: connection!.skseReady!,
            }),
        };
      }),
      total,
      query,
    );
  }
}
