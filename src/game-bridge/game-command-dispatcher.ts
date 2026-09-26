import { randomUUID } from 'node:crypto';
import { Injectable, Optional } from '@nestjs/common';
import { Metrics, seconds } from '../observability/metrics.js';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import type { ApplicationConfig } from '../config/environment.js';
import { BridgeClock } from './bridge-clock.js';
import { envelope } from './command-contract.js';
import { canDispatch, CommandStatus, transition } from './command-state.js';
import { GameCommand } from './entities/game-command.entity.js';
import { GameConnectionService } from './game-connection.service.js';
import { GameCommandStore } from './game-command-store.js';
import { GameGateway } from './game-gateway.js';
import type { CommandEnvelope, CommandType } from './command-contract.js';
import type { GatewayConnection, TransportAcceptance } from './game-gateway.js';

export const GATEWAY_SEND_TIMEOUT_MS = 1000;
export const DISPATCH_LEASE_MS = 2000;
interface DispatchClaim {
  leaseId: string;
  expiresAt: Date;
  connection: GatewayConnection;
  envelope: CommandEnvelope;
}

@Injectable()
export class GameCommandDispatcher {
  private readonly policy: ApplicationConfig['gameBridge'];
  private readonly maxInFlight: number;
  constructor(
    private readonly database: DataSource,
    private readonly store: GameCommandStore,
    private readonly connections: GameConnectionService,
    private readonly gateway: GameGateway,
    private readonly clock: BridgeClock,
    config: ConfigService<{ application: ApplicationConfig }, true>,
    @Optional() private readonly metrics?: Metrics,
  ) {
    const application = config.get('application', { infer: true });
    this.policy = application.gameBridge;
    this.maxInFlight = application.agent.maxInFlightCommands;
  }
  async dispatch(id: string): Promise<GameCommand> {
    const reserved = await this.reserve(id);
    if (!reserved.claim) return reserved.command;
    // A committed reservation is one dispatch attempt.
    const { type, dispatchAttempts, createdAt, lastDispatchAt } =
      reserved.command;
    this.metrics?.commandDispatches.inc({
      command_type: type,
      attempt: dispatchAttempts > 1 ? 'retry' : 'first',
    });
    const wait = seconds(createdAt, lastDispatchAt);
    if (dispatchAttempts === 1 && wait !== null)
      this.metrics?.commandCreateToDispatch.observe(
        { command_type: type },
        wait,
      );
    // reserve() committed and released its connection/row locks before any I/O.
    const acceptance = await this.send(reserved.claim);
    return this.store.locked(id, async (manager, command) => {
      // A newer worker, ACK/RESULT, timeout or lease recovery fences this response.
      if (command.dispatchLeaseId !== reserved.claim?.leaseId) return command;
      command.dispatchLeaseId = null;
      command.dispatchLeaseExpiresAt = null;
      if (acceptance.accepted || acceptance.reason === 'TRANSIENT') {
        if (command.status === CommandStatus.PENDING)
          transition(command, CommandStatus.DISPATCHED);
      } else if (command.status === CommandStatus.PENDING) {
        // Definite refusal proves this first possible delivery did not happen.
        command.dispatchedConnectionId = null;
        command.executionDeadlineAt = null;
        if (
          acceptance.reason === 'PERMANENT' ||
          command.dispatchAttempts >= this.policy.maxDispatchAttempts
        ) {
          await this.store.finish(
            manager,
            command,
            CommandStatus.FAILED,
            null,
            acceptance.reason === 'PERMANENT'
              ? 'DISPATCH_REJECTED'
              : 'GATEWAY_UNAVAILABLE',
          );
          return command;
        }
      }
      // Once delivery was possible, retry refusal cannot imply execution failure.
      if (!(await this.store.expireExecution(manager, command)))
        await manager.getRepository<GameCommand>('GameCommand').save(command);
      return command;
    });
  }
  private async reserve(
    id: string,
  ): Promise<{ command: GameCommand; claim: DispatchClaim | null }> {
    return this.store.locked(id, async (manager, command, server) => {
      const unchanged = () => ({ command, claim: null });
      if (
        !canDispatch(command.status) ||
        (await this.store.expireExecution(manager, command))
      )
        return unchanged();
      const now = this.clock.now();
      if (
        command.dispatchLeaseId ||
        (command.ackDeadlineAt && command.ackDeadlineAt > now)
      )
        return unchanged();
      if (command.dispatchAttempts >= this.policy.maxDispatchAttempts) {
        await this.store.finish(
          manager,
          command,
          command.status === CommandStatus.PENDING
            ? CommandStatus.FAILED
            : CommandStatus.TIMEOUT,
          null,
          command.status === CommandStatus.PENDING
            ? 'DISPATCH_EXHAUSTED'
            : 'ACK_TIMEOUT',
        );
        return unchanged();
      }
      if (!server.enabled && command.status === CommandStatus.PENDING) {
        await this.store.finish(
          manager,
          command,
          CommandStatus.FAILED,
          null,
          'SERVER_DISABLED',
        );
        return unchanged();
      }
      // 12.5, before any attempt is consumed and under the server row lock
      // that every reserve, ACK, RESULT, HELLO and revoke of this server
      // takes: (1) only the instance owning the live session may cross the
      // delivery boundary (another replica leaves the command untouched);
      // (2) a new flight (PENDING) fits the server's in-flight budget,
      // counted here, so concurrent workers of any replica cannot exceed it.
      const live = await this.connections.active(command.gameServerId, manager);
      if (
        this.connections.healthy(live, now) &&
        !this.connections.owned(live, now)
      )
        return unchanged();
      if (
        command.status === CommandStatus.PENDING &&
        (await this.inFlight(command.gameServerId, manager, command.id)) >=
          this.maxInFlight
      )
        return unchanged();
      command.dispatchAttempts++;
      command.lastDispatchAt = now;
      command.ackDeadlineAt = new Date(
        Math.min(
          now.getTime() + this.policy.ackTimeoutMs,
          command.executionDeadlineAt?.getTime() ?? Infinity,
        ),
      );
      const connection = await this.connections.active(
        command.gameServerId,
        manager,
      );
      if (!server.enabled || !this.connections.healthy(connection, now)) {
        if (
          command.status === CommandStatus.PENDING &&
          command.dispatchAttempts >= this.policy.maxDispatchAttempts
        )
          await this.store.finish(
            manager,
            command,
            CommandStatus.FAILED,
            null,
            'GATEWAY_UNAVAILABLE',
          );
        else
          await manager.getRepository<GameCommand>('GameCommand').save(command);
        return unchanged();
      }
      command.dispatchLeaseId = randomUUID();
      command.dispatchLeaseExpiresAt = new Date(
        now.getTime() + DISPATCH_LEASE_MS,
      );
      command.dispatchedConnectionId = connection.id;
      command.executionDeadlineAt ??= new Date(
        now.getTime() + this.policy.executionTimeoutMs,
      );
      command.ackDeadlineAt = new Date(
        Math.min(
          command.ackDeadlineAt.getTime(),
          command.executionDeadlineAt.getTime(),
        ),
      );
      const claim: DispatchClaim = {
        leaseId: command.dispatchLeaseId,
        expiresAt: command.dispatchLeaseExpiresAt,
        connection: {
          id: connection.id,
          gameServerId: connection.gameServerId,
          externalConnectionId: connection.externalConnectionId,
        },
        envelope: envelope(command),
      };
      await manager.getRepository<GameCommand>('GameCommand').save(command);
      return { command, claim };
    });
  }
  private async send(claim: DispatchClaim): Promise<TransportAcceptance> {
    if (
      claim.expiresAt <= this.clock.now() ||
      Date.parse(claim.envelope.executionDeadlineAt) <=
        this.clock.now().getTime()
    )
      return { accepted: false, reason: 'TRANSIENT' };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.gateway.send(claim.connection, claim.envelope, controller.signal),
        new Promise<TransportAcceptance>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve({ accepted: false, reason: 'TRANSIENT' });
          }, GATEWAY_SEND_TIMEOUT_MS);
        }),
      ]);
    } catch {
      return { accepted: false, reason: 'TRANSIENT' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async dispatchPending(): Promise<GameCommand[]> {
    return this.dispatchDue([CommandStatus.PENDING]);
  }
  async retryTimedOutDispatches(): Promise<GameCommand[]> {
    return this.dispatchDue([CommandStatus.DISPATCHED]);
  }
  // Commands occupying the server's Agent: DISPATCHED, ACKNOWLEDGED, or
  // PENDING with a live reservation. Read from the database, so the count
  // survives restarts and never depends on in-memory bookkeeping.
  async inFlight(
    gameServerId: string,
    manager: EntityManager = this.database.manager,
    except?: string,
  ): Promise<number> {
    const query = manager
      .getRepository<GameCommand>('GameCommand')
      .createQueryBuilder('command')
      .where('command.gameServerId = :gameServerId', { gameServerId })
      .andWhere(
        '(command.status IN (:...flying) OR (command.status = :pending AND command.dispatchLeaseId IS NOT NULL))',
        {
          flying: [CommandStatus.DISPATCHED, CommandStatus.ACKNOWLEDGED],
          pending: CommandStatus.PENDING,
        },
      );
    if (except) query.andWhere('command.id <> :except', { except });
    return query.getCount();
  }
  // Dispatches the due commands of one server whose type the caller can
  // deliver: every due DISPATCHED retry (already in flight) and at most
  // `pendingLimit` new PENDING ones, oldest first. The caller decides
  // eligibility (session, runtime, capability) before any reservation, so
  // an ineligible server never consumes attempts.
  async dispatchEligible(
    gameServerId: string,
    types: readonly CommandType[],
    pendingLimit: number,
  ): Promise<GameCommand[]> {
    if (!types.length) return [];
    const due = (status: CommandStatus, take: number) =>
      take <= 0
        ? Promise.resolve([] as GameCommand[])
        : this.database
            .getRepository<GameCommand>('GameCommand')
            .createQueryBuilder('command')
            .where('command.gameServerId = :gameServerId', { gameServerId })
            .andWhere('command.status = :status', { status })
            .andWhere('command.type IN (:...types)', { types })
            .andWhere(
              '(command.ackDeadlineAt IS NULL OR command.ackDeadlineAt <= :now)',
              { now: this.clock.now() },
            )
            .andWhere(
              '(command.dispatchLeaseExpiresAt IS NULL OR command.dispatchLeaseExpiresAt <= :now)',
              { now: this.clock.now() },
            )
            .orderBy('command.createdAt', 'ASC')
            .addOrderBy('command.id', 'ASC')
            .take(take)
            .getMany();
    const commands = [
      ...(await due(CommandStatus.DISPATCHED, 100)),
      ...(await due(CommandStatus.PENDING, Math.min(pendingLimit, 100))),
    ];
    const results: GameCommand[] = [];
    for (const command of commands)
      results.push(await this.dispatch(command.id));
    return results;
  }
  // PENDING commands of a server whose type the caller cannot deliver
  // (observability only; nothing is reserved).
  async blockedPending(
    gameServerId: string,
    types: readonly CommandType[],
    limit = 20,
  ): Promise<Pick<GameCommand, 'id' | 'type'>[]> {
    const query = this.database
      .getRepository<GameCommand>('GameCommand')
      .createQueryBuilder('command')
      .select(['command.id', 'command.type'])
      .where('command.gameServerId = :gameServerId', { gameServerId })
      .andWhere('command.status = :pending', {
        pending: CommandStatus.PENDING,
      });
    if (types.length)
      query.andWhere('command.type NOT IN (:...types)', { types });
    return query.orderBy('command.createdAt', 'ASC').take(limit).getMany();
  }
  private async dispatchDue(statuses: CommandStatus[]): Promise<GameCommand[]> {
    const commands = await this.database
      .getRepository<GameCommand>('GameCommand')
      .createQueryBuilder('command')
      .where('command.status IN (:...statuses)', { statuses })
      .andWhere(
        '(command.ackDeadlineAt IS NULL OR command.ackDeadlineAt <= :now)',
        { now: this.clock.now() },
      )
      .andWhere(
        '(command.dispatchLeaseExpiresAt IS NULL OR command.dispatchLeaseExpiresAt <= :now)',
        { now: this.clock.now() },
      )
      .orderBy('command.createdAt', 'ASC')
      .addOrderBy('command.id', 'ASC')
      .take(100)
      .getMany();
    const results: GameCommand[] = [];
    for (const command of commands)
      results.push(await this.dispatch(command.id));
    return results;
  }
}
