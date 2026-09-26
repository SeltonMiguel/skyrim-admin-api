import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { ApplicationConfig } from '../config/environment.js';
import { TickDrain } from '../lifecycle/tick-drain.js';
import { Metrics } from './metrics.js';

const COMMAND_OPEN = ['PENDING', 'DISPATCHED', 'ACKNOWLEDGED'];
const CONTROL_STATES = ['PENDING', 'DISPATCHED', 'UNCERTAIN'];
const VIP_STATES = [
  'PENDING',
  'COMMAND_CREATED',
  'SUCCEEDED',
  'FAILED',
  'UNCERTAIN',
  'CANCELLED',
];
const WORK = [
  'trade_settlement',
  'marketplace_custody',
  'marketplace_settlement',
  'marketplace_release',
  'marketplace_release_failed',
];
const AGE = 'EXTRACT(EPOCH FROM now() - min(%s))::float8';
type Row = { key: string; n: number; age: number | null };

// DB-backed state gauges (12.3): a handful of aggregated queries every
// METRICS_COLLECTION_INTERVAL_MS (never per scrape, never per item), so
// the gauges are rebuilt from PostgreSQL after any restart. States follow
// the real schema: trade AWAITING_GAME_CONFIRMATION (since locked_at),
// listing PENDING_CUSTODY, purchase AWAITING_GAME_CONFIRMATION, release
// PENDING/FAILED, VIP delivery statuses.
@Injectable()
export class BacklogCollector
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(BacklogCollector.name);
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly drain: TickDrain;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  constructor(
    private readonly database: DataSource,
    private readonly metrics: Metrics,
    config: ConfigService<{ application: ApplicationConfig }, true>,
  ) {
    const observability = config.get('application', {
      infer: true,
    }).observability;
    this.enabled = observability.metricsEnabled;
    this.intervalMs = observability.collectionIntervalMs;
    this.drain = new TickDrain(metrics.worker('backlog_collector'));
  }
  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    void this.collect();
    this.timer = setInterval(() => void this.collect(), this.intervalMs);
    this.timer.unref();
  }
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.drain.wait();
  }
  async collect(): Promise<boolean> {
    if (this.stopped) return false;
    if (this.drain.active) {
      this.drain.skip();
      return false;
    }
    this.drain.begin();
    try {
      await this.commands();
      await this.controls();
      await this.work();
      await this.vip();
      this.metrics.backlogCollected.set(Math.floor(Date.now() / 1000));
      return true;
    } catch {
      this.drain.fail();
      this.metrics.backlogErrors.inc();
      this.logger.error('Backlog collection failed');
      return false;
    } finally {
      this.drain.end();
    }
  }
  private async rows(sql: string, params: unknown[] = []): Promise<Row[]> {
    return (await this.database.query(sql, params)) as Row[];
  }
  private async commands() {
    const rows = await this.rows(
      `SELECT status AS key, count(*)::int AS n, ${AGE.replace('%s', 'created_at')} AS age
       FROM game_commands WHERE status = ANY($1) GROUP BY status`,
      [COMMAND_OPEN],
    );
    for (const status of COMMAND_OPEN) {
      const row = rows.find((r) => r.key === status);
      this.metrics.commandBacklog.set({ status }, row?.n ?? 0);
      this.metrics.commandOldest.set({ status }, row?.age ?? 0);
    }
  }
  private async controls() {
    const rows = await this.rows(
      `SELECT status AS key, count(*)::int AS n, NULL AS age
       FROM server_control_operations WHERE status = ANY($1) GROUP BY status`,
      [CONTROL_STATES],
    );
    for (const status of CONTROL_STATES)
      this.metrics.controlOperations.set(
        { status },
        rows.find((r) => r.key === status)?.n ?? 0,
      );
  }
  private async work() {
    const rows = await this.rows(
      `SELECT 'trade_settlement' AS key, count(*)::int AS n, ${AGE.replace('%s', 'locked_at')} AS age
         FROM player_trades WHERE status = 'AWAITING_GAME_CONFIRMATION'
       UNION ALL SELECT 'marketplace_custody', count(*)::int, ${AGE.replace('%s', 'created_at')}
         FROM player_marketplace_listings WHERE status = 'PENDING_CUSTODY'
       UNION ALL SELECT 'marketplace_settlement', count(*)::int, ${AGE.replace('%s', 'created_at')}
         FROM player_marketplace_purchases WHERE status = 'AWAITING_GAME_CONFIRMATION'
       UNION ALL SELECT 'marketplace_release', count(*)::int, ${AGE.replace('%s', 'created_at')}
         FROM player_marketplace_item_releases WHERE status = 'PENDING'
       UNION ALL SELECT 'marketplace_release_failed', count(*)::int, ${AGE.replace('%s', 'created_at')}
         FROM player_marketplace_item_releases WHERE status = 'FAILED'`,
    );
    for (const work of WORK) {
      const row = rows.find((r) => r.key === work);
      this.metrics.workBacklog.set({ work }, row?.n ?? 0);
      this.metrics.workOldest.set({ work }, row?.age ?? 0);
    }
  }
  private async vip() {
    const rows = await this.rows(
      `SELECT status AS key, count(*)::int AS n, NULL AS age
       FROM vip_reward_deliveries GROUP BY status
       UNION ALL SELECT 'open_oldest', 0, ${AGE.replace('%s', 'created_at')}
       FROM vip_reward_deliveries WHERE status IN ('PENDING', 'COMMAND_CREATED')`,
    );
    for (const status of VIP_STATES)
      this.metrics.vipDeliveries.set(
        { status },
        rows.find((r) => r.key === status)?.n ?? 0,
      );
    this.metrics.vipOldest.set(
      rows.find((r) => r.key === 'open_oldest')?.age ?? 0,
    );
  }
}
