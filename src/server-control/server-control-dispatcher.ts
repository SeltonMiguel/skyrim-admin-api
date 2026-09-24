import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BridgeClock } from '../game-bridge/bridge-clock.js';
import { ServerControlOperation } from './entities/server-control-operation.entity.js';
import { ServerControlStatus as S } from './server-control.contracts.js';
import type { ServerControlErrorCode } from './server-control.contracts.js';
import { ServerControlGateway } from './server-control-gateway.js';
import type {
  ServerControlAcceptance,
  ServerControlRequest,
} from './server-control-gateway.js';

export const SERVER_CONTROL_SEND_TIMEOUT_MS = 1000;
type Outcome = ServerControlAcceptance | { accepted: 'UNKNOWN' };

// At-most-once delivery: a claim is taken by one autocommit UPDATE, the gateway
// is called with no transaction open, and a claimed operation is never resent.
@Injectable()
export class ServerControlDispatcher {
  private readonly logger = new Logger(ServerControlDispatcher.name);
  constructor(
    private readonly database: DataSource,
    private readonly gateway: ServerControlGateway,
    private readonly clock: BridgeClock,
  ) {}
  private repository() {
    return this.database.getRepository<ServerControlOperation>(
      'ServerControlOperation',
    );
  }
  async dispatch(id: string): Promise<void> {
    const unclaimed = (enabled: boolean) =>
      this.repository()
        .createQueryBuilder()
        .update()
        .where('id = :id', { id })
        .andWhere('status = :pending', { pending: S.PENDING })
        .andWhere('dispatch_claimed_at IS NULL')
        .andWhere(
          `${enabled ? '' : 'NOT '}EXISTS (SELECT 1 FROM game_servers s WHERE s.id = game_server_id AND s.enabled)`,
        );
    const claim = await unclaimed(true)
      .set({ dispatchClaimedAt: this.clock.now() })
      .execute();
    if (claim.affected !== 1) {
      await unclaimed(false)
        .set({
          status: S.FAILED,
          errorCode: 'SERVER_DISABLED',
          completedAt: this.clock.now(),
        })
        .execute();
      return;
    }
    const operation = await this.repository().findOneByOrFail({ id });
    const outcome = await this.send({
      operationId: operation.id,
      gameServerId: operation.gameServerId,
      type: operation.type,
      correlationId: operation.correlationId,
      requestedAt: operation.createdAt.toISOString(),
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
    await this.repository().update({ id, status: S.PENDING }, values);
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
  // Recovery entry point for a future worker: unclaimed work left by a crash
  // between commit and dispatch. Claimed-but-unresolved work is never resent.
  async dispatchPending(): Promise<number> {
    const pending = await this.repository()
      .createQueryBuilder('operation')
      .select('operation.id')
      .where('operation.status = :status', { status: S.PENDING })
      .andWhere('operation.dispatchClaimedAt IS NULL')
      .orderBy('operation.createdAt', 'ASC')
      .addOrderBy('operation.id', 'ASC')
      .take(100)
      .getMany();
    for (const { id } of pending) await this.dispatchSafely(id);
    return pending.length;
  }
  // The request is already committed and audited; dispatch trouble never
  // turns an accepted 202 into an error.
  async dispatchSafely(id: string): Promise<void> {
    try {
      await this.dispatch(id);
    } catch {
      this.logger.error(`Server control dispatch failed [operationId=${id}]`);
    }
  }
}
