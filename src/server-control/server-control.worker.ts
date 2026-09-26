import {
  Injectable,
  Optional,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Metrics } from '../observability/metrics.js';
import { TickDrain } from '../lifecycle/tick-drain.js';
import { ConfigService } from '@nestjs/config';
import type { ApplicationConfig } from '../config/environment.js';
import { ServerControlDispatcher } from './server-control-dispatcher.js';
import { ServerControlReceiver } from './server-control-receiver.js';

const MAX_LOGGED = 1000;

// Production scheduler of the Server Control lifecycle (11.3). Separate
// from the GameCommand worker and never a retry worker. One periodic tick,
// never overlapping:
// 1. unclaimed PENDING past SERVER_CONTROL_PENDING_TIMEOUT_MS -> FAILED /
//    DISPATCH_EXPIRED (nothing was sent);
// 2. claimed operations past their persistent result deadline -> UNCERTAIN
//    / RESULT_TIMEOUT (possibly executed; never resent);
// 3. the first and only dispatch of unclaimed PENDING operations whose
//    server has an eligible Agent (the claim is atomic; an operation that
//    crossed it never comes back here).
@Injectable()
export class ServerControlWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ServerControlWorker.name);
  private readonly intervalMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly drain: TickDrain;
  private stopped = false;
  // Log each held operation once.
  private readonly held = new Set<string>();
  // Conceptual metric: UNCERTAIN outcomes need operator attention.
  private uncertain = 0;
  constructor(
    private readonly dispatcher: ServerControlDispatcher,
    private readonly receiver: ServerControlReceiver,
    config: ConfigService<{ application: ApplicationConfig }, true>,
    @Optional() metrics?: Metrics,
  ) {
    this.drain = new TickDrain(metrics?.worker('server_control'));
    this.intervalMs = config.get('application', {
      infer: true,
    }).serverControl.workerIntervalMs;
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
  // Returns how many operations crossed the delivery boundary.
  async tick(): Promise<number> {
    if (this.running) this.drain.skip();
    if (this.running || this.stopped) return 0;
    this.running = true;
    this.drain.begin();
    try {
      for (const op of await this.dispatcher.expirePending()) {
        this.held.delete(op.operationId);
        this.logger.warn(
          `Server control operation expired before dispatch [operationId=${op.operationId} gameServerId=${op.gameServerId} action=${op.type} errorCode=DISPATCH_EXPIRED]`,
        );
      }
      for (const op of await this.receiver.expireResults()) {
        this.uncertain += 1;
        this.logger.warn(
          `Server control outcome UNCERTAIN: no result before the deadline [operationId=${op.operationId} gameServerId=${op.gameServerId} action=${op.type} errorCode=RESULT_TIMEOUT metric=server_control_uncertain_total value=${this.uncertain}]`,
        );
      }
      let sent = 0;
      for (const id of await this.dispatcher.pendingIds()) {
        const outcome = await this.dispatcher.dispatchSafely(id);
        if (outcome === 'SENT') {
          sent += 1;
          this.held.delete(id);
        } else if (outcome === 'HELD' && !this.held.has(id)) {
          if (this.held.size >= MAX_LOGGED) this.held.clear();
          this.held.add(id);
          this.logger.warn(
            `Server control operation held: no eligible Agent (session or capability) [operationId=${id}]`,
          );
        }
      }
      return sent;
    } catch {
      this.drain.fail();
      this.logger.error('Server control worker tick failed');
      return 0;
    } finally {
      this.running = false;
      this.drain.end();
    }
  }
  // UNCERTAIN outcomes materialized by this instance since boot.
  uncertainCount(): number {
    return this.uncertain;
  }
}
