import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { identifier, uuid } from './command-contract.js';
import { GameServer } from './entities/game-server.entity.js';

@Injectable()
export class GameServerService {
  constructor(private readonly database: DataSource) {}
  async register(input: {
    code: string;
    name: string;
    enabled?: boolean;
  }): Promise<GameServer> {
    const { code, name, enabled = true } = input;
    identifier(code, 'server code', 64);
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      name.length > 100 ||
      typeof enabled !== 'boolean'
    )
      throw new BadRequestException('Invalid server');
    const id = randomUUID();
    const repository = this.database.getRepository<GameServer>('GameServer');
    const inserted = await repository
      .createQueryBuilder()
      .insert()
      .values({ id, code, name, enabled })
      .onConflict('ON CONSTRAINT game_servers_code_key DO NOTHING')
      .returning('id')
      .execute();
    if (!inserted.raw.length)
      throw new ConflictException('Server code already exists');
    return repository.findOneByOrFail({ id });
  }
  async get(
    id: string,
    manager: EntityManager = this.database.manager,
    lock = false,
  ): Promise<GameServer> {
    uuid(id);
    const server = await manager
      .getRepository<GameServer>('GameServer')
      .findOne({
        where: { id },
        ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
      });
    if (!server) throw new NotFoundException('Game server not found');
    return server;
  }
}
