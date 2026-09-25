import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import type { ApplicationConfig } from '../config/environment.js';
import { canonicalJson } from './canonical-json.js';
import { commandJson } from './command-json.js';
import { BridgeClock } from './bridge-clock.js';
import {
  commandResult,
  REMOTE_FAILURE_CODES,
  UNCERTAIN_OUTCOME,
  validateMessage,
  MAX_COMMAND_RESULT_BYTES,
} from './command-contract.js';
import type {
  BridgeMessage,
  RemoteFailureCode,
  ResultMessage,
} from './command-contract.js';
import { CommandStatus, isTerminal, transition } from './command-state.js';
import type { TerminalStatus } from './command-state.js';
import { BridgeRejection } from './bridge-rejection.js';
import { GameCommand } from './entities/game-command.entity.js';
import { GameCommandResult } from './entities/game-command-result.entity.js';
import { GameCommandStore } from './game-command-store.js';
import type { CommandErrorCode } from './game-command-store.js';
import { GameConnectionService } from './game-connection.service.js';

export interface ReceivedResult {
  command: GameCommand;
  // True when an identical result had already been recorded (no write).
  duplicate: boolean;
}

// ACK belongs to a delivery attempt: it must come from the session the
// attempt was reserved for and name that attempt. RESULT belongs to the
// command: any active, healthy session of the command's server may report
// it (e.g. after a reconnect); the connection that carried the attempt is
// provenance, not a validity condition.
@Injectable()
export class GameCommandReceiver {
  private readonly maxAttempts: number;
  private readonly pendingTimeoutMs: number;
  constructor(
    private readonly database: DataSource,
    private readonly store: GameCommandStore,
    private readonly connections: GameConnectionService,
    private readonly clock: BridgeClock,
    config: ConfigService<{ application: ApplicationConfig }, true>,
  ) {
    const policy = config.get('application', { infer: true }).gameBridge;
    this.maxAttempts = policy.maxDispatchAttempts;
    this.pendingTimeoutMs = policy.pendingTimeoutMs;
  }
  async acknowledge(input: BridgeMessage): Promise<GameCommand> {
    const message = { ...input };
    validateMessage(message);
    if (
      message.attempt !== undefined &&
      (!Number.isSafeInteger(message.attempt) || message.attempt < 1)
    )
      throw new BadRequestException('Invalid attempt');
    return this.store.locked(message.commandId, async (manager, command) => {
      await this.match(manager, command, message, 'ACK');
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
    return (await this.receive(input)).command;
  }
  // Same as result(), also telling whether it was an identical replay.
  async receive(input: ResultMessage): Promise<ReceivedResult> {
    const message = { ...input } as ResultMessage;
    validateMessage(message);
    const outcome = message.outcome;
    const rawResult =
      outcome === CommandStatus.SUCCEEDED
        ? commandJson(
            (message as { result: unknown }).result,
            MAX_COMMAND_RESULT_BYTES,
          )
        : null;
    const failure =
      outcome === CommandStatus.FAILED
        ? (message as { errorCode: unknown }).errorCode
        : null;
    if (
      (outcome !== CommandStatus.SUCCEEDED &&
        outcome !== CommandStatus.FAILED &&
        outcome !== UNCERTAIN_OUTCOME) ||
      (outcome === CommandStatus.FAILED &&
        !REMOTE_FAILURE_CODES.includes(failure as RemoteFailureCode))
    )
      throw new BadRequestException('Invalid bridge result');
    // UNCERTAIN is recorded as the terminal TIMEOUT: the backend cannot
    // say whether the side effect happened, so it is never FAILED.
    const status: TerminalStatus =
      outcome === CommandStatus.SUCCEEDED
        ? CommandStatus.SUCCEEDED
        : outcome === CommandStatus.FAILED
          ? CommandStatus.FAILED
          : CommandStatus.TIMEOUT;
    const errorCode: CommandErrorCode | null =
      outcome === UNCERTAIN_OUTCOME
        ? 'EXECUTION_UNCERTAIN'
        : (failure as RemoteFailureCode | null);
    return this.store.locked(message.commandId, async (manager, command) => {
      await this.match(manager, command, message, 'RESULT');
      const result =
        outcome === CommandStatus.SUCCEEDED
          ? commandResult(command.type, rawResult, command.payload)
          : null;
      if (command.type !== 'BRIDGE_PING' && errorCode === 'PING_REJECTED')
        throw new BadRequestException('Invalid character failure code');
      // A result is only meaningful after a possible delivery.
      if (command.status === CommandStatus.PENDING && !command.dispatchLeaseId)
        throw new BridgeRejection('NOT_DISPATCHED');
      this.store.markPossiblyDelivered(command);
      if (isTerminal(command.status)) {
        const existing = await manager
          .getRepository<GameCommandResult>('GameCommandResult')
          .findOneByOrFail({ gameCommandId: command.id });
        if (
          existing.outcome !== status ||
          existing.errorCode !== errorCode ||
          canonicalJson(existing.result, MAX_COMMAND_RESULT_BYTES) !==
            canonicalJson(result, MAX_COMMAND_RESULT_BYTES)
        )
          throw new BridgeRejection('RESULT_CONFLICT');
        return { command, duplicate: true };
      }
      // Late results are accepted until the deadline; then TIMEOUT wins.
      if (await this.expire(manager, command))
        return { command, duplicate: false };
      if (command.status === CommandStatus.DISPATCHED) {
        transition(command, CommandStatus.ACKNOWLEDGED);
        command.acknowledgedAt = this.clock.now();
      }
      await this.store.finish(manager, command, status, result, errorCode);
      return { command, duplicate: false };
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
  // PENDING commands never reserved (no Agent, runtime or capability
  // before GAME_COMMAND_PENDING_TIMEOUT_MS) end FAILED/DISPATCH_EXPIRED:
  // PENDING without a lease proves no delivery was possible.
  async expirePending(): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - this.pendingTimeoutMs);
    const candidates = await this.database
      .getRepository<GameCommand>('GameCommand')
      .createQueryBuilder('command')
      .where('command.status = :pending', { pending: CommandStatus.PENDING })
      .andWhere('command.dispatchLeaseId IS NULL')
      .andWhere('command.createdAt <= :cutoff', { cutoff })
      .orderBy('command.createdAt', 'ASC')
      .addOrderBy('command.id', 'ASC')
      .take(100)
      .getMany();
    let count = 0;
    for (const candidate of candidates)
      count += await this.store.locked(
        candidate.id,
        async (manager, command) => {
          if (
            command.status !== CommandStatus.PENDING ||
            command.dispatchLeaseId ||
            command.createdAt.getTime() > cutoff.getTime()
          )
            return 0;
          await this.store.finish(
            manager,
            command,
            CommandStatus.FAILED,
            null,
            'DISPATCH_EXPIRED',
          );
          return 1;
        },
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
    kind: 'ACK' | 'RESULT',
  ): Promise<void> {
    if (command.gameServerId !== message.serverId)
      throw new BridgeRejection('SERVER_MISMATCH');
    if (command.correlationId !== message.correlationId)
      throw new BridgeRejection('CORRELATION_MISMATCH');
    if (
      kind === 'ACK' &&
      (command.dispatchedConnectionId !== message.connectionId ||
        (message.attempt !== undefined &&
          message.attempt !== command.dispatchAttempts))
    )
      throw new BridgeRejection('STALE_ATTEMPT');
    // The reporting session must be the server's current, healthy one.
    const connection = await this.connections.active(message.serverId, manager);
    if (
      !connection ||
      connection.id !== message.connectionId ||
      !this.connections.healthy(connection)
    )
      throw new BridgeRejection('INACTIVE_SESSION');
  }
}
