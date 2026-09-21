import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { GameCommand } from '../game-bridge/entities/game-command.entity.js';
import { CommandQueryDto } from './dto/query.dto.js';
import { GameServerQueryService } from './game-server-query.service.js';
import { dateRange, filterDates, pageResult } from './query-pagination.js';
import { commandDetail, commandSummary } from './query.presenters.js';
import type { CommandWithResult } from './query.presenters.js';

const SUMMARY_COLUMNS = [
  'command.id',
  'command.gameServerId',
  'command.type',
  'command.status',
  'command.correlationId',
  'command.requestId',
  'command.requestedByStaffId',
  'command.dispatchAttempts',
  'command.lastDispatchAt',
  'command.acknowledgedAt',
  'command.completedAt',
  'command.createdAt',
];
@Injectable()
export class GameCommandQueryService {
  constructor(
    private readonly database: DataSource,
    private readonly servers: GameServerQueryService,
  ) {}
  async list(serverId: string, query: CommandQueryDto) {
    const range = dateRange(query);
    await this.servers.requireServer(serverId);
    const builder = this.database
      .getRepository<GameCommand>('GameCommand')
      .createQueryBuilder('command')
      .select(SUMMARY_COLUMNS)
      .where('command.gameServerId = :serverId', { serverId });
    for (const field of [
      'status',
      'type',
      'requestedByStaffId',
      'requestId',
      'correlationId',
    ] as const)
      if (query[field] !== undefined)
        builder.andWhere(`command.${field} = :${field}`, {
          [field]: query[field],
        });
    filterDates(builder, 'command.createdAt', range);
    const [items, total] = await builder
      .orderBy('command.createdAt', 'DESC')
      .addOrderBy('command.id', 'DESC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();
    return pageResult(items.map(commandSummary), total, query);
  }
  async get(id: string) {
    const command = await this.database
      .getRepository<CommandWithResult>('GameCommand')
      .createQueryBuilder('command')
      .select([
        ...SUMMARY_COLUMNS,
        'command.payload',
        'command.ackDeadlineAt',
        'command.executionDeadlineAt',
      ])
      .leftJoinAndMapOne(
        'command.result',
        'GameCommandResult',
        'result',
        'result.gameCommandId = command.id',
      )
      .where('command.id = :id', { id })
      .getOne();
    if (!command) throw new NotFoundException('Game command not found');
    return commandDetail(command);
  }
}
