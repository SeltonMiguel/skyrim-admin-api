import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BridgeClock } from '../game-bridge/bridge-clock.js';
import { GameConnectionService } from '../game-bridge/game-connection.service.js';
import { RealtimeEventBus } from '../realtime-events/realtime-event-bus.js';
import { ServerControlOperation } from './entities/server-control-operation.entity.js';
import {
  SERVER_CONTROL_TERMINAL,
  ServerControlStatus as S,
} from './server-control.contracts.js';
import type {
  ServerControlErrorCode,
  ServerControlRemoteFailure,
  ServerControlType,
} from './server-control.contracts.js';
import { expired } from './server-control-dispatcher.js';
import type { ExpiredOperation } from './server-control-dispatcher.js';
import { ServerControlRejection } from './server-control-rejection.js';
import { publishServerControl } from './server-control.events.js';

export type ServerControlResultInput = {
  // Always the authenticated session's, never the payload's.
  gameServerId: string;
  connectionId: string;
  operationId: string;
  correlationId: string;
  type: ServerControlType;
} & (
  | { outcome: 'SUCCEEDED' }
  | { outcome: 'FAILED'; errorCode: ServerControlRemoteFailure }
  | { outcome: 'UNCERTAIN' }
);
export interface ServerControlReceived {
  operation: ServerControlOperation;
  // Identical to the recorded terminal result: nothing written.
  duplicate: boolean;
  // False when the result deadline had already made it UNCERTAIN.
  accepted: boolean;
}
const isTerminal = (status: S) =>
  (SERVER_CONTROL_TERMINAL as readonly S[]).includes(status);

// Receives SERVER_CONTROL_RESULT. The result belongs to gameServerId +
// operationId, not to the connection that received the operation: any
// active, healthy session of the same server may report it (reconnect).
// The dispatch connection is provenance only. Never creates an operation.
@Injectable()
export class ServerControlReceiver {
  constructor(
    private readonly database: DataSource,
    private readonly connections: GameConnectionService,
    private readonly clock: BridgeClock,
    private readonly events: RealtimeEventBus,
  ) {}
  async receive(
    input: ServerControlResultInput,
  ): Promise<ServerControlReceived> {
    const status =
      input.outcome === 'SUCCEEDED'
        ? S.SUCCEEDED
        : input.outcome === 'FAILED'
          ? S.FAILED
          : S.UNCERTAIN;
    const errorCode: ServerControlErrorCode | null =
      input.outcome === 'FAILED'
        ? input.errorCode
        : input.outcome === 'UNCERTAIN'
          ? 'OUTCOME_UNKNOWN'
          : null;
    const received = await this.database.transaction(async (manager) => {
      const repository = manager.getRepository<ServerControlOperation>(
        'ServerControlOperation',
      );
      // Only the operation row is locked (never game_servers), so a result
      // cannot deadlock with a new request serialized on the server row.
      const operation = await repository.findOne({
        where: { id: input.operationId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!operation)
        throw new NotFoundException('Server control operation not found');
      if (operation.gameServerId !== input.gameServerId)
        throw new ServerControlRejection('SERVER_MISMATCH');
      if (operation.correlationId !== input.correlationId)
        throw new ServerControlRejection('CORRELATION_MISMATCH');
      if (operation.type !== input.type)
        throw new ServerControlRejection('OPERATION_MISMATCH');
      const connection = await this.connections.active(
        input.gameServerId,
        manager,
      );
      if (
        !connection ||
        connection.id !== input.connectionId ||
        !this.connections.healthy(connection)
      )
        throw new ServerControlRejection('INACTIVE_SESSION');
      // Before the claim nothing was sent: a result is impossible.
      if (!operation.dispatchClaimedAt)
        throw new ServerControlRejection('NOT_DISPATCHED');
      if (isTerminal(operation.status)) {
        // Two "unknown" outcomes agree whoever materialized them.
        const same =
          operation.status === status &&
          (operation.errorCode === errorCode || status === S.UNCERTAIN);
        if (!same) throw new ServerControlRejection('RESULT_CONFLICT');
        return { operation, duplicate: true, accepted: true };
      }
      const now = this.clock.now();
      // Late results are accepted until the deadline; then UNCERTAIN wins.
      if (operation.resultDeadlineAt! <= now) {
        Object.assign(operation, {
          status: S.UNCERTAIN,
          errorCode: 'RESULT_TIMEOUT',
          completedAt: now,
        });
        await repository.save(operation);
        return { operation, duplicate: false, accepted: false };
      }
      Object.assign(operation, {
        status,
        errorCode,
        completedAt: now,
        // A result before the send was reconciled still proves delivery.
        dispatchedAt: operation.dispatchedAt ?? operation.dispatchClaimedAt,
      });
      await repository.save(operation);
      return { operation, duplicate: false, accepted: true };
    });
    // After commit; a duplicate changed nothing and publishes nothing.
    if (!received.duplicate) this.terminal(received.operation);
    return received;
  }
  private terminal(operation: ServerControlOperation): void {
    publishServerControl(this.events, {
      operationId: operation.id,
      gameServerId: operation.gameServerId,
      type: operation.type,
      status: operation.status,
      errorCode: operation.errorCode,
      completedAt: operation.completedAt!,
    });
  }
  // Possibly delivered (claimed) and no result by the persistent deadline:
  // UNCERTAIN, never FAILED and never resent. One fenced UPDATE, so a
  // result committed first wins (the row is re-checked after its lock).
  async expireResults(): Promise<ExpiredOperation[]> {
    const now = this.clock.now();
    const result = await this.database
      .getRepository<ServerControlOperation>('ServerControlOperation')
      .createQueryBuilder()
      .update()
      .set({
        status: S.UNCERTAIN,
        errorCode: 'RESULT_TIMEOUT',
        completedAt: now,
      })
      .where(
        'id IN (SELECT id FROM server_control_operations WHERE status IN (:...open) AND dispatch_claimed_at IS NOT NULL AND result_deadline_at <= :now ORDER BY result_deadline_at LIMIT 100)',
        { open: [S.PENDING, S.DISPATCHED], now },
      )
      .andWhere(
        'status IN (:...open) AND dispatch_claimed_at IS NOT NULL AND result_deadline_at <= :now',
        { open: [S.PENDING, S.DISPATCHED], now },
      )
      .returning('id, game_server_id, type')
      .execute();
    const operations = expired(result.raw);
    for (const op of operations)
      publishServerControl(this.events, {
        ...op,
        status: S.UNCERTAIN,
        errorCode: 'RESULT_TIMEOUT',
        completedAt: now,
      });
    return operations;
  }
}
