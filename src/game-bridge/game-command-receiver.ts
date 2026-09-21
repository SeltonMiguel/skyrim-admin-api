import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import type { ApplicationConfig } from '../config/environment.js';
import { canonicalJson } from './canonical-json.js';
import { BridgeClock } from './bridge-clock.js';
import { pingData, validateMessage } from './command-contract.js';
import type { BridgeMessage, ResultMessage } from './command-contract.js';
import { CommandStatus, isTerminal, transition } from './command-state.js';
import { GameCommand } from './entities/game-command.entity.js';
import { GameCommandResult } from './entities/game-command-result.entity.js';
import { GameCommandStore } from './game-command-store.js';
import { GameConnectionService } from './game-connection.service.js';

@Injectable()
export class GameCommandReceiver {
  private readonly maxAttempts: number;
  constructor(
    private readonly database: DataSource,
    private readonly store: GameCommandStore,
    private readonly connections: GameConnectionService,
    private readonly clock: BridgeClock,
    config: ConfigService<{ application: ApplicationConfig }, true>,
  ) {
    this.maxAttempts = config.get('application', {
      infer: true,
    }).gameBridge.maxDispatchAttempts;
  }
  async acknowledge(input: BridgeMessage): Promise<GameCommand> {
    const message = { ...input };
    validateMessage(message);
    return this.store.locked(message.commandId, async (manager, command) => {
      await this.match(manager, command, message);
      this.store.markPossiblyDelivered(command);
      if (isTerminal(command.status) || (await this.expire(manager, command)))
        return command;
      if (command.status === CommandStatus.ACKNOWLEDGED) return command;
      transition(command, CommandStatus.ACKNOWLEDGED);
      command.acknowledgedAt = this.clock.now();
      await manager.getRepository<GameCommand>('GameCommand').save(command);
      return command;
    });
  }
  async result(input: ResultMessage): Promise<GameCommand> {
    const message = { ...input };
    validateMessage(message);
    const result =
      message.outcome === CommandStatus.SUCCEEDED
        ? pingData(message.result)
        : null;
    const errorCode =
      message.outcome === CommandStatus.FAILED ? message.errorCode : null;
    if (
      (message.outcome !== CommandStatus.SUCCEEDED &&
        message.outcome !== CommandStatus.FAILED) ||
      (errorCode !== null &&
        errorCode !== 'PING_REJECTED' &&
        errorCode !== 'BRIDGE_ERROR')
    )
      throw new BadRequestException('Invalid bridge result');
    return this.store.locked(message.commandId, async (manager, command) => {
      await this.match(manager, command, message);
      this.store.markPossiblyDelivered(command);
      if (result && result.nonce !== pingData(command.payload).nonce)
        throw new ConflictException('Result nonce mismatch');
      if (isTerminal(command.status)) {
        const existing = await manager
          .getRepository<GameCommandResult>('GameCommandResult')
          .findOneByOrFail({ gameCommandId: command.id });
        if (
          existing.outcome !== message.outcome ||
          existing.errorCode !== errorCode ||
          canonicalJson(existing.result) !== canonicalJson(result)
        )
          throw new ConflictException(
            'Command already completed with another result',
          );
        return command;
      }
      if (await this.expire(manager, command)) return command;
      if (command.status === CommandStatus.DISPATCHED) {
        transition(command, CommandStatus.ACKNOWLEDGED);
        command.acknowledgedAt = this.clock.now();
      }
      await this.store.finish(
        manager,
        command,
        message.outcome,
        result,
        errorCode,
      );
      return command;
    });
  }
  async expireCommands(): Promise<number> {
    const candidates = await this.database
      .getRepository<GameCommand>('GameCommand')
      .createQueryBuilder('command')
      .where('command.status IN (:...statuses)', {
        statuses: [
          CommandStatus.PENDING,
          CommandStatus.DISPATCHED,
          CommandStatus.ACKNOWLEDGED,
        ],
      })
      .andWhere(
        '(command.executionDeadlineAt <= :now OR (command.status = :dispatched AND command.ackDeadlineAt <= :now AND command.dispatchAttempts >= :max))',
        {
          now: this.clock.now(),
          dispatched: CommandStatus.DISPATCHED,
          max: this.maxAttempts,
        },
      )
      .orderBy('command.createdAt', 'ASC')
      .addOrderBy('command.id', 'ASC')
      .take(100)
      .getMany();
    let count = 0;
    for (const candidate of candidates)
      count += await this.store.locked(
        candidate.id,
        async (manager, command) =>
          (await this.expire(manager, command)) ? 1 : 0,
      );
    return count;
  }
  private async expire(
    manager: EntityManager,
    command: GameCommand,
  ): Promise<boolean> {
    if (await this.store.expireExecution(manager, command)) return true;
    if (
      command.status === CommandStatus.DISPATCHED &&
      command.dispatchAttempts >= this.maxAttempts &&
      command.ackDeadlineAt &&
      command.ackDeadlineAt <= this.clock.now()
    ) {
      await this.store.finish(
        manager,
        command,
        CommandStatus.TIMEOUT,
        null,
        'ACK_TIMEOUT',
      );
      return true;
    }
    return false;
  }
  private async match(
    manager: EntityManager,
    command: GameCommand,
    message: BridgeMessage,
  ): Promise<void> {
    if (
      command.gameServerId !== message.serverId ||
      command.correlationId !== message.correlationId ||
      command.dispatchedConnectionId !== message.connectionId
    )
      throw new ConflictException('Bridge message does not match command');
    const connection = await this.connections.active(message.serverId, manager);
    if (
      !connection ||
      connection.id !== message.connectionId ||
      !this.connections.healthy(connection)
    )
      throw new ConflictException('Bridge connection no longer active');
  }
}
