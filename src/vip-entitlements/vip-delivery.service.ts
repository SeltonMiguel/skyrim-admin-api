import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { TickDrain } from '../lifecycle/tick-drain.js';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { systemActor, SystemSource } from '../actors/actor.contracts.js';
import type { ApplicationConfig } from '../config/environment.js';
import { AgentSessionRegistry } from '../game-agent/agent-session.registry.js';
import { CommandStatus } from '../game-bridge/command-state.js';
import type { SubmitCommand } from '../game-bridge/command-contract.js';
import { GameCommandBus } from '../game-bridge/game-command-bus.js';
import type { PlayerVipEntitlement } from './entities/player-vip-entitlement.entity.js';
import type { VipRewardDelivery } from './entities/vip-reward-delivery.entity.js';
import {
  deliveryIdempotencyKey,
  DeliveryStatus as D,
  rewardCommand,
} from './vip-delivery.contracts.js';
import type { DeliveryErrorCode } from './vip-delivery.contracts.js';
import { EntitlementStatus } from './vip-entitlement.contracts.js';

export type AdvanceOutcome =
  'COMMAND_CREATED' | 'HELD' | 'CANCELLED' | 'FAILED' | 'SKIPPED';
const TERMINAL: Partial<Record<CommandStatus, D>> = {
  [CommandStatus.SUCCEEDED]: D.SUCCEEDED,
  [CommandStatus.FAILED]: D.FAILED,
  // TIMEOUT (incl. EXECUTION_UNCERTAIN) may have executed: never retried.
  [CommandStatus.TIMEOUT]: D.UNCERTAIN,
};

// Gameplay delivery of CHARACTER entitlements (Etapa 11.4), reusing the
// GameCommand pipeline of 11.2: typed *_GIVE commands only, created as
// SYSTEM:VIP_DELIVERY with an idempotency key derived from the delivery, so
// one delivery never yields two commands. A periodic, non-overlapping tick
// (1) mirrors terminal command results into deliveries (reconciliation by
// game_command_id, rebuilt from the database after any restart) and
// (2) creates the command of PENDING deliveries once the character's
// server has an Agent able to run it. The command is created in the same
// transaction that re-checks the entitlement under its row lock, so a
// revoke/expiry either happens first (CANCELLED, never delivered) or after
// (no clawback: the command follows its lifecycle).
@Injectable()
export class VipDeliveryService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(VipDeliveryService.name);
  private readonly intervalMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly drain = new TickDrain();
  private stopped = false;
  private readonly held = new Set<string>();
  constructor(
    private readonly database: DataSource,
    private readonly bus: GameCommandBus,
    private readonly sessions: AgentSessionRegistry,
    config: ConfigService<{ application: ApplicationConfig }, true>,
  ) {
    this.intervalMs = config.get('application', {
      infer: true,
    }).vipDelivery.workerIntervalMs;
  }
  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }
  // Graceful shutdown: stop scheduling, then await the running tick.
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.drain.wait();
  }
  async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    this.drain.begin();
    try {
      await this.reconcile();
      const pending = await this.deliveries(this.database.manager)
        .createQueryBuilder('delivery')
        .select('delivery.id')
        .where('delivery.status = :pending', { pending: D.PENDING })
        .orderBy('delivery.createdAt', 'ASC')
        .addOrderBy('delivery.id', 'ASC')
        .take(100)
        .getMany();
      for (const { id } of pending) await this.advanceSafely(id);
    } catch {
      this.logger.error('VIP delivery tick failed');
    } finally {
      this.running = false;
      this.drain.end();
    }
  }
  private deliveries(manager: EntityManager) {
    return manager.getRepository<VipRewardDelivery>('VipRewardDelivery');
  }
  private async advanceSafely(id: string): Promise<AdvanceOutcome> {
    try {
      return await this.advance(id);
    } catch {
      this.logger.error(`VIP delivery not advanced [deliveryId=${id}]`);
      return 'SKIPPED';
    }
  }
  async advance(id: string): Promise<AdvanceOutcome> {
    const found = await this.deliveries(this.database.manager).findOneBy({
      id,
    });
    if (!found || found.status !== D.PENDING) return 'SKIPPED';
    const command = rewardCommand(found.reward, found.characterExternalId);
    // Readiness first, outside any lock: an offline Agent keeps the right
    // pending (never consumed by a command that would expire unsent).
    if (
      command &&
      !(
        this.sessions.isRuntimeReady(found.gameServerId) &&
        this.sessions.supportsCommand(found.gameServerId, command.type)
      )
    ) {
      if (!this.held.has(id)) {
        if (this.held.size >= 1000) this.held.clear();
        this.held.add(id);
        this.logger.log(
          `VIP delivery held: no ready Agent [deliveryId=${id} gameServerId=${found.gameServerId}]`,
        );
      }
      return 'HELD';
    }
    const outcome = await this.database.transaction(async (manager) => {
      // Same lock order as revoke: entitlement row first.
      const entitlement = await manager
        .getRepository<PlayerVipEntitlement>('PlayerVipEntitlement')
        .findOneOrFail({
          where: { id: found.entitlementId },
          lock: { mode: 'pessimistic_write' },
        });
      const delivery = await this.deliveries(manager).findOneOrFail({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (delivery.status !== D.PENDING) return 'SKIPPED' as const;
      const now = new Date();
      const ended: DeliveryErrorCode | null =
        entitlement.status === EntitlementStatus.REVOKED
          ? 'ENTITLEMENT_REVOKED'
          : entitlement.status === EntitlementStatus.EXPIRED ||
              (entitlement.expiresAt !== null && entitlement.expiresAt <= now)
            ? 'ENTITLEMENT_EXPIRED'
            : null;
      if (ended) {
        await this.finish(manager, id, D.CANCELLED, ended);
        return 'CANCELLED' as const;
      }
      if (!command) {
        await this.finish(manager, id, D.FAILED, 'UNSUPPORTED_REWARD');
        return 'FAILED' as const;
      }
      const { command: created } = await this.bus.submitInTransaction(
        {
          gameServerId: delivery.gameServerId,
          type: command.type,
          payload: command.payload,
          idempotencyKey: deliveryIdempotencyKey(id),
          actor: systemActor(SystemSource.VIP_DELIVERY),
        } as SubmitCommand,
        manager,
      );
      await this.deliveries(manager).update(
        { id, status: D.PENDING },
        { status: D.COMMAND_CREATED, gameCommandId: created.id },
      );
      return 'COMMAND_CREATED' as const;
    });
    this.held.delete(id);
    const log = `[deliveryId=${id} entitlementId=${found.entitlementId} gameServerId=${found.gameServerId}]`;
    if (outcome === 'COMMAND_CREATED')
      this.logger.log(`VIP delivery command created ${log}`);
    else if (outcome !== 'SKIPPED')
      this.logger.warn(
        `VIP delivery ended without command ${log} outcome=${outcome}`,
      );
    return outcome;
  }
  private finish(
    manager: EntityManager,
    id: string,
    status: D,
    errorCode: DeliveryErrorCode | null,
  ) {
    return this.deliveries(manager).update(
      { id, status: D.PENDING },
      { status, errorCode, completedAt: new Date() },
    );
  }
  // COMMAND_CREATED deliveries whose command reached a terminal status.
  async reconcile(): Promise<number> {
    const rows: {
      id: string;
      status: CommandStatus;
      error_code: string | null;
    }[] = await this.database.query(
      `SELECT d.id, c.status, r.error_code
       FROM vip_reward_deliveries d
       JOIN game_commands c ON c.id = d.game_command_id
       LEFT JOIN game_command_results r ON r.game_command_id = c.id
       WHERE d.status = $1 AND c.status IN ('SUCCEEDED', 'FAILED', 'TIMEOUT')
       ORDER BY d.created_at, d.id
       LIMIT 100`,
      [D.COMMAND_CREATED],
    );
    for (const row of rows) {
      const status = TERMINAL[row.status]!;
      await this.deliveries(this.database.manager).update(
        { id: row.id, status: D.COMMAND_CREATED },
        {
          status,
          errorCode:
            status === D.SUCCEEDED ? null : (row.error_code ?? row.status),
          completedAt: new Date(),
        },
      );
      const log = `[deliveryId=${row.id} status=${status}]`;
      if (status === D.SUCCEEDED)
        this.logger.log(`VIP delivery succeeded ${log}`);
      else this.logger.warn(`VIP delivery ${status.toLowerCase()} ${log}`);
    }
    return rows.length;
  }
}
