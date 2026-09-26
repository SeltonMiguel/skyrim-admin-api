import { Injectable, Logger, Optional } from '@nestjs/common';
import { Metrics } from '../observability/metrics.js';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { ApplicationConfig } from '../config/environment.js';
import { BridgeClock } from '../game-bridge/bridge-clock.js';
import { RealtimeEventBus } from '../realtime-events/realtime-event-bus.js';
import { ServerControlOperation } from './entities/server-control-operation.entity.js';
import { ServerControlStatus as S } from './server-control.contracts.js';
import type {
  ServerControlErrorCode,
  ServerControlType,
} from './server-control.contracts.js';
import { ServerControlGateway } from './server-control-gateway.js';
import { publishServerControl } from './server-control.events.js';
import type {
  ServerControlAcceptance,
  ServerControlRequest,
} from './server-control-gateway.js';
export const SERVER_CONTROL_SEND_TIMEOUT_MS = 1000;
type Outcome = ServerControlAcceptance | { accepted: 'UNKNOWN' };
// SENT: crossed the delivery boundary (whatever the send said). HELD: no
// eligible Agent yet, still unclaimed. FAILED: failed before the boundary.
// SKIPPED: not (or no longer) an unclaimed PENDING operation.
export type DispatchOutcome = 'SENT' | 'HELD' | 'FAILED' | 'SKIPPED';
export interface ExpiredOperation {
  operationId: string;
  gameServerId: string;
  type: ServerControlType;
}
export const expired = (rows: unknown): ExpiredOperation[] =>
  (
    rows as { id: string; game_server_id: string; type: ServerControlType }[]
  ).map((row) => ({
    operationId: row.id,
    gameServerId: row.game_server_id,
    type: row.type,
  }));
// At-most-once delivery. The delivery boundary is the claim: one autocommit
// UPDATE (status PENDING, unclaimed, server enabled) that fixes the target
// session, notAfter and the result deadline. Before it nothing was sent and
// the operation may wait or fail safely; after it the operation is never
// sent again, by this or any other path. The gateway is called once, with
// no transaction open.
@Injectable()
export class ServerControlDispatcher {
  private readonly logger = new Logger(ServerControlDispatcher.name);
  private readonly pendingTimeoutMs: number;
  private readonly deliveryWindowMs: number;
  private readonly resultTimeoutMs: number;
  constructor(
    private readonly database: DataSource,
    private readonly gateway: ServerControlGateway,
    private readonly clock: BridgeClock,
    config: ConfigService<{ application: ApplicationConfig }, true>,
    private readonly events: RealtimeEventBus,
    @Optional() private readonly metrics?: Metrics,
  ) {
    const policy = config.get('application', { infer: true }).serverControl;
    this.pendingTimeoutMs = policy.pendingTimeoutMs;
    this.deliveryWindowMs = policy.deliveryWindowMs;
    this.resultTimeoutMs = policy.resultTimeoutMs;
  }
  private repository() {
    return this.database.getRepository<ServerControlOperation>(
      'ServerControlOperation',
    );
  }
  private unclaimed(id: string, enabled: boolean) {
    return this.repository()
      .createQueryBuilder()
      .update()
      .where('id = :id', { id })
      .andWhere('status = :pending', { pending: S.PENDING })
      .andWhere('dispatch_claimed_at IS NULL')
      .andWhere(
        `${enabled ? '' : 'NOT '}EXISTS (SELECT 1 FROM game_servers s WHERE s.id = game_server_id AND s.enabled)`,
      );
  }
  private async failIfDisabled(
    pending: Pick<ServerControlOperation, 'id' | 'gameServerId' | 'type'>,
  ): Promise<boolean> {
    const completedAt = this.clock.now();
    const failed = await this.unclaimed(pending.id, false)
      .set({ status: S.FAILED, errorCode: 'SERVER_DISABLED', completedAt })
      .execute();
    if (failed.affected !== 1) return false;
    this.terminal(pending, 'SERVER_DISABLED', completedAt);
    return true;
  }
  // Every FAILED written here is committed (autocommit UPDATE) and wakes
  // the Staff after it; nothing was sent for any of them.
  private terminal(
    operation: Pick<ServerControlOperation, 'id' | 'gameServerId' | 'type'>,
    errorCode: ServerControlErrorCode,
    completedAt: Date,
  ): void {
    publishServerControl(
      this.events,
      {
        operationId: operation.id,
        gameServerId: operation.gameServerId,
        type: operation.type,
        status: S.FAILED,
        errorCode,
        completedAt,
      },
      this.metrics,
    );
  }
  async dispatch(id: string): Promise<DispatchOutcome> {
    const pending = await this.repository().findOneBy({ id });
    if (
      !pending ||
      pending.status !== S.PENDING ||
      pending.dispatchClaimedAt !== null
    )
      return 'SKIPPED';
    // Eligibility before the claim: an absent or incompatible Agent keeps
    // the operation PENDING (never sent) until the pending timeout.
    const connectionId = this.gateway.target(
      pending.gameServerId,
      pending.type,
    );
    if (!connectionId)
      return (await this.failIfDisabled(pending)) ? 'FAILED' : 'HELD';
    const issuedAt = this.clock.now();
    const notAfter = new Date(issuedAt.getTime() + this.deliveryWindowMs);
    const claim = await this.unclaimed(id, true)
      .set({
        dispatchClaimedAt: issuedAt,
        dispatchConnectionId: connectionId,
        notAfter,
        resultDeadlineAt: new Date(issuedAt.getTime() + this.resultTimeoutMs),
      })
      .execute();
    if (claim.affected !== 1)
      return (await this.failIfDisabled(pending)) ? 'FAILED' : 'SKIPPED';
    // ---- Delivery boundary crossed: from here on, never resent. ----
    const operation = await this.repository().findOneByOrFail({ id });
    const outcome = await this.send({
      operationId: operation.id,
      gameServerId: operation.gameServerId,
      connectionId,
      type: operation.type,
      correlationId: operation.correlationId,
      requestedAt: operation.createdAt.toISOString(),
      issuedAt: issuedAt.toISOString(),
      notAfter: notAfter.toISOString(),
    });
    const now = this.clock.now();
    // Only a definite refusal proves non-delivery; ambiguity is DISPATCHED.
    const values =
      outcome.accepted === false
        ? {
            status: S.FAILED,
            completedAt: now,
            errorCode: (outcome.reason === 'UNAVAILABLE'
              ? 'AGENT_UNAVAILABLE'
              : 'AGENT_REJECTED') as ServerControlErrorCode,
          }
        : { status: S.DISPATCHED, dispatchedAt: now };
    // Fenced by PENDING: a result that already arrived wins.
    const written = await this.repository().update(
      { id, status: S.PENDING },
      values,
    );
    if (values.errorCode && written.affected === 1)
      this.terminal(operation, values.errorCode, now);
    if (outcome.accepted === 'UNKNOWN')
      this.logger.warn(
        `Server control send ambiguous, treated as delivered [operationId=${id} gameServerId=${operation.gameServerId} action=${operation.type} connectionId=${connectionId}]`,
      );
    return 'SENT';
  }
  private async send(request: ServerControlRequest): Promise<Outcome> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.gateway.send(request, controller.signal),
        new Promise<Outcome>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve({ accepted: 'UNKNOWN' });
          }, SERVER_CONTROL_SEND_TIMEOUT_MS);
        }),
      ]);
    } catch {
      return { accepted: 'UNKNOWN' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  // Unclaimed PENDING operations (new, held, or left by a crash between
  // commit and dispatch), oldest first. Claimed work is never resent.
  async pendingIds(limit = 100): Promise<string[]> {
    const pending = await this.repository()
      .createQueryBuilder('operation')
      .select('operation.id')
      .where('operation.status = :status', { status: S.PENDING })
      .andWhere('operation.dispatchClaimedAt IS NULL')
      .orderBy('operation.createdAt', 'ASC')
      .addOrderBy('operation.id', 'ASC')
      .take(limit)
      .getMany();
    return pending.map(({ id }) => id);
  }
  async dispatchPending(): Promise<number> {
    const ids = await this.pendingIds();
    for (const id of ids) await this.dispatchSafely(id);
    return ids.length;
  }
  // The request is already committed and audited; dispatch trouble never
  // turns an accepted 202 into an error.
  async dispatchSafely(id: string): Promise<DispatchOutcome> {
    try {
      return await this.dispatch(id);
    } catch {
      this.logger.error(`Server control dispatch failed [operationId=${id}]`);
      return 'SKIPPED';
    }
  }
  // Never claimed within the pending timeout: nothing was sent, so FAILED
  // is safe. Fenced like the claim, so exactly one of them wins.
  async expirePending(): Promise<ExpiredOperation[]> {
    const now = this.clock.now();
    const cutoff = new Date(now.getTime() - this.pendingTimeoutMs);
    const result = await this.repository()
      .createQueryBuilder()
      .update()
      .set({
        status: S.FAILED,
        errorCode: 'DISPATCH_EXPIRED',
        completedAt: now,
      })
      .where(
        'id IN (SELECT id FROM server_control_operations WHERE status = :pending AND dispatch_claimed_at IS NULL AND created_at <= :cutoff ORDER BY created_at LIMIT 100)',
        { pending: S.PENDING, cutoff },
      )
      .andWhere('status = :pending AND dispatch_claimed_at IS NULL', {
        pending: S.PENDING,
      })
      .returning('id, game_server_id, type')
      .execute();
    const operations = expired(result.raw);
    for (const op of operations)
      this.terminal(
        { id: op.operationId, gameServerId: op.gameServerId, type: op.type },
        'DISPATCH_EXPIRED',
        now,
      );
    return operations;
  }
}
