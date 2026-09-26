import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { TickDrain } from '../lifecycle/tick-drain.js';
import { ConfigService } from '@nestjs/config';
import type { ApplicationConfig } from '../config/environment.js';
import { BridgeClock } from '../game-bridge/bridge-clock.js';
import { outbound } from './agent-protocol.contracts.js';
import { AgentSessionRegistry } from './agent-session.registry.js';
import { AgentWorkService } from './agent-work.service.js';

const MAX_REMEMBERED = 5000;

// Best-effort, low-latency hint of new work (Etapa 11.4). A periodic tick
// reads the canonical work of each ACTIVE session's server (first page) and
// pushes, as an unsolicited WORK_ITEMS (inReplyTo null), the items this
// connection was not told about yet. The remembered set is only a push
// optimization: it is per connection, bounded, and never the source of
// truth. A failed or lost push changes nothing; WORK_SYNC recovers it and
// the Agent's journal makes a repeated workId harmless. It never runs inside
// a domain transaction and domains never call it.
@Injectable()
export class AgentWorkNotifier
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(AgentWorkNotifier.name);
  private readonly intervalMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly drain = new TickDrain();
  private stopped = false;
  private readonly told = new Map<string, Set<string>>();
  constructor(
    private readonly sessions: AgentSessionRegistry,
    private readonly work: AgentWorkService,
    private readonly clock: BridgeClock,
    config: ConfigService<{ application: ApplicationConfig }, true>,
  ) {
    this.intervalMs = config.get('application', {
      infer: true,
    }).agent.workPushIntervalMs;
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
  async tick(): Promise<number> {
    if (this.running || this.stopped) return 0;
    this.running = true;
    this.drain.begin();
    let pushed = 0;
    try {
      const active = this.sessions.activeSessions();
      const live = new Set(active.map((s) => s.connectionId));
      for (const connectionId of this.told.keys())
        if (!live.has(connectionId)) this.told.delete(connectionId);
      for (const session of active) {
        const { items } = await this.work.page(session.gameServerId, {});
        let told = this.told.get(session.connectionId);
        if (!told || told.size > MAX_REMEMBERED) {
          told = new Set();
          this.told.set(session.connectionId, told);
        }
        const fresh = items.filter(
          (item) => !told.has(`${item.kind}:${item.workId}`),
        );
        if (!fresh.length) continue;
        const sent = this.sessions.send(
          session.gameServerId,
          session.connectionId,
          outbound(
            'WORK_ITEMS',
            session.gameServerId,
            { inReplyTo: null, items: fresh, nextCursor: null },
            this.clock.now(),
          ),
        );
        if (!sent) continue;
        for (const item of fresh) told.add(`${item.kind}:${item.workId}`);
        pushed += fresh.length;
        this.logger.log(
          `Agent work pushed [gameServerId=${session.gameServerId} connectionId=${session.connectionId} count=${fresh.length}]`,
        );
      }
    } catch {
      this.logger.error('Agent work push failed');
    } finally {
      this.running = false;
      this.drain.end();
    }
    return pushed;
  }
}
