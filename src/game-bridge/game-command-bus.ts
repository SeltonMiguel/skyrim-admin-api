import { ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { RequestContext } from '../common/request-context/request-context.service.js';
import { BridgeClock } from './bridge-clock.js';
import {
  commandPayload,
  identifier,
  sameCommand,
  uuid,
} from './command-contract.js';
import type { SubmitCommand } from './command-contract.js';
import { CommandStatus } from './command-state.js';
import { GameServerService } from './game-server.service.js';
import { GameCommand } from './entities/game-command.entity.js';

@Injectable()
export class GameCommandBus {
  constructor(
    private readonly database: DataSource,
    private readonly servers: GameServerService,
    private readonly context: RequestContext,
    private readonly clock: BridgeClock,
  ) {}
  async submit(input: SubmitCommand): Promise<GameCommand> {
    // Snapshot before transaction acquisition; never retain caller-owned payload.
    const snapshot = {
      ...input,
      payload: commandPayload(input.type, input.payload),
    } as SubmitCommand;
    return this.database.transaction(
      async (manager) =>
        (await this.submitInTransaction(snapshot, manager)).command,
    );
  }
  // Caller owns the short transaction. Never dispatch or perform external I/O here.
  async submitInTransaction(
    input: SubmitCommand,
    manager: EntityManager,
  ): Promise<{ command: GameCommand; created: boolean }> {
    const {
      gameServerId,
      type,
      idempotencyKey,
      requestedByStaffId = null,
    } = input;
    const payload = commandPayload(type, input.payload);
    identifier(idempotencyKey, 'idempotency key');
    if (requestedByStaffId !== null) uuid(requestedByStaffId);
    const requestId = this.context.requestId ?? null;
    const server = await this.servers.get(gameServerId, manager, true);
    const repository = manager.getRepository<GameCommand>('GameCommand');
    // Unique constraint is the final authority; conflict does not abort the transaction.
    // Replays remain readable after server disable, but new work is rejected.
    if (!server.enabled) {
      const existing = await repository.findOneBy({
        gameServerId,
        idempotencyKey,
      });
      if (existing && sameCommand(existing, type, payload))
        return { command: existing, created: false };
      throw new ConflictException(
        'Game server disabled or idempotency conflict',
      );
    }
    const id = randomUUID();
    await repository
      .createQueryBuilder()
      .insert()
      .values({
        id,
        gameServerId,
        type,
        payload,
        idempotencyKey,
        correlationId: randomUUID(),
        requestId,
        requestedByStaffId,
        status: CommandStatus.PENDING,
        dispatchAttempts: 0,
        createdAt: this.clock.now(),
      })
      .onConflict('ON CONSTRAINT game_commands_idempotency_key DO NOTHING')
      .execute();
    const command = await repository.findOneByOrFail({
      gameServerId,
      idempotencyKey,
    });
    if (!sameCommand(command, type, payload))
      throw new ConflictException('Idempotency key conflicts with command');
    return { command, created: command.id === id };
  }
}
