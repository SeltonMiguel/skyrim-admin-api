import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { BridgeClock } from './bridge-clock.js';
import { uuid } from './command-contract.js';
import { CommandStatus, isTerminal, transition } from './command-state.js';
import type { TerminalStatus } from './command-state.js';
import { GameCommand } from './entities/game-command.entity.js';
import { GameCommandResult } from './entities/game-command-result.entity.js';
import { GameServer } from './entities/game-server.entity.js';
import { GameServerService } from './game-server.service.js';

export const COMMAND_ERRORS = {
  PING_REJECTED: 'Bridge rejected ping',
  BRIDGE_ERROR: 'Bridge reported failure',
  GATEWAY_UNAVAILABLE: 'No bridge transport connected',
  DISPATCH_REJECTED: 'Transport permanently rejected dispatch',
  DISPATCH_EXHAUSTED: 'Dispatch attempts exhausted',
  ACK_TIMEOUT: 'Acknowledgement deadline expired',
  EXECUTION_TIMEOUT: 'Execution deadline expired',
  SERVER_DISABLED: 'Game server disabled',
  // 11.2: remote execution outcomes and the never-deliverable PENDING expiry.
  EXECUTION_FAILED: 'Game execution failed',
  EXECUTION_UNCERTAIN: 'Game execution outcome unknown',
  DISPATCH_EXPIRED: 'No eligible Agent before the dispatch deadline',
} as const;
export type CommandErrorCode = keyof typeof COMMAND_ERRORS;

@Injectable()
export class GameCommandStore {
  constructor(
    private readonly database: DataSource,
    private readonly servers: GameServerService,
    private readonly clock: BridgeClock,
  ) {}
  async locked<T>(
    id: string,
    operation: (
      manager: EntityManager,
      command: GameCommand,
      server: GameServer,
    ) => Promise<T>,
  ): Promise<T> {
    uuid(id);
    const initial = await this.database
      .getRepository<GameCommand>('GameCommand')
      .findOneBy({ id });
    if (!initial) throw new NotFoundException('Game command not found');
    return this.database.transaction(async (manager) => {
      // Consistent lock order for connect/heartbeat, dispatch, ACK, RESULT and timeout.
      const server = await this.servers.get(
        initial.gameServerId,
        manager,
        true,
      );
      const command = await manager
        .getRepository<GameCommand>('GameCommand')
        .findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!command) throw new NotFoundException('Game command not found');
      if (
        command.dispatchLeaseExpiresAt &&
        command.dispatchLeaseExpiresAt <= this.clock.now()
      ) {
        // An abandoned claim may have sent: never infer proven non-delivery.
        this.markPossiblyDelivered(command);
        await manager.getRepository<GameCommand>('GameCommand').save(command);
      }
      return operation(manager, command, server);
    });
  }
  markPossiblyDelivered(command: GameCommand): void {
    if (command.status === CommandStatus.PENDING && command.dispatchLeaseId)
      transition(command, CommandStatus.DISPATCHED);
    command.dispatchLeaseId = null;
    command.dispatchLeaseExpiresAt = null;
  }
  async finish(
    manager: EntityManager,
    command: GameCommand,
    outcome: TerminalStatus,
    result: object | null,
    errorCode: CommandErrorCode | null,
  ): Promise<void> {
    transition(command, outcome);
    command.completedAt = this.clock.now();
    command.dispatchLeaseId = null;
    command.dispatchLeaseExpiresAt = null;
    await manager.getRepository<GameCommand>('GameCommand').save(command);
    await manager.getRepository<GameCommandResult>('GameCommandResult').insert({
      id: randomUUID(),
      gameCommandId: command.id,
      outcome,
      result,
      errorCode,
      errorMessage: errorCode ? COMMAND_ERRORS[errorCode] : null,
      receivedAt: command.completedAt,
    });
  }
  async expireExecution(
    manager: EntityManager,
    command: GameCommand,
  ): Promise<boolean> {
    if (
      !isTerminal(command.status) &&
      command.status !== CommandStatus.PENDING &&
      command.executionDeadlineAt &&
      command.executionDeadlineAt.getTime() <= this.clock.now().getTime()
    ) {
      await this.finish(
        manager,
        command,
        CommandStatus.TIMEOUT,
        null,
        command.status === CommandStatus.ACKNOWLEDGED
          ? 'EXECUTION_TIMEOUT'
          : 'ACK_TIMEOUT',
      );
      return true;
    }
    return false;
  }
}
