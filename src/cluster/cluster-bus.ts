import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { DataSource } from 'typeorm';
import type { ApplicationConfig } from '../config/environment.js';
import { pgClientConfig } from '../database/database.options.js';
import { Metrics } from '../observability/metrics.js';
import { InstanceIdentity } from './instance-identity.js';

// Closed catalog of cross-instance signals (12.5). None of them is an
// authority: each has a database fence that holds when the signal is lost.
export const CLUSTER_KINDS = [
  // Realtime envelope + recipients: wake-ups for sockets on other replicas.
  'REALTIME',
  // Player session / account revoked: close local sockets at once (UX);
  // delivery authorization re-reads the database anyway.
  'PLAYER_SESSION_REVOKED',
  'PLAYER_ACCOUNT_REVOKED',
  // Agent session superseded, revoked or closed elsewhere: close the local
  // socket; every state-changing frame is fenced by the database anyway.
  'AGENT_SESSION_CLOSED',
  'AGENT_CREDENTIAL_REVOKED',
] as const;
export type ClusterKind = (typeof CLUSTER_KINDS)[number];
export type ClusterPayload = Record<string, unknown>;
type Handler = (payload: ClusterPayload) => void | Promise<void>;
const MIN_BACKOFF_MS = 250;

// PostgreSQL bus of a MULTI deployment (12.5). Publishing inserts the
// envelope in distributed_bus_events and NOTIFYs only `origin:eventId` in
// the same autocommit statement, so a receiver never sees an id before its
// row. Every instance LISTENs on a dedicated pg.Client (never a pool
// connection: LISTEN is session state; behind PgBouncer it needs a direct
// connection or session pooling). The originator never receives its own
// events (it already delivered them locally). Delivery is best effort and
// may duplicate; a lost NOTIFY is recovered by HTTP/DB, never replayed.
// SINGLE: disabled, publish() is a no-op.
@Injectable()
export class ClusterBus
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger('ClusterBus');
  readonly enabled: boolean;
  private readonly cluster: ApplicationConfig['cluster'];
  private readonly database: ApplicationConfig['database'];
  private readonly handlers = new Map<ClusterKind, Set<Handler>>();
  private client?: pg.Client;
  private listening = false;
  private stopped = false;
  private attempt = 0;
  private reconnect?: ReturnType<typeof setTimeout>;
  private cleanup?: ReturnType<typeof setInterval>;
  constructor(
    private readonly dataSource: DataSource,
    private readonly instance: InstanceIdentity,
    config: ConfigService<{ application: ApplicationConfig }, true>,
    @Optional() private readonly metrics?: Metrics,
  ) {
    const application = config.get('application', { infer: true });
    this.enabled = application.deployment.topology === 'MULTI';
    this.cluster = application.cluster;
    this.database = application.database;
    if (this.enabled) this.metrics?.clusterBusConnected.set(0);
  }
  get connected(): boolean {
    return this.listening;
  }
  subscribe(kind: ClusterKind, handler: Handler): () => void {
    const set = this.handlers.get(kind) ?? new Set<Handler>();
    set.add(handler);
    this.handlers.set(kind, set);
    return () => set.delete(handler);
  }
  // Never throws: a failed publish is logged and counted; the database
  // fences keep correctness, HTTP recovers the state.
  async publish(kind: ClusterKind, payload: ClusterPayload): Promise<void> {
    if (!this.enabled || this.stopped) return;
    try {
      await this.dataSource.query(
        `WITH event AS (
           INSERT INTO distributed_bus_events(id, kind, origin_instance_id, payload, expires_at)
           VALUES ($1, $2, $3, $4, now() + $5 * interval '1 millisecond')
           RETURNING id
         )
         SELECT pg_notify($6, $3 || ':' || id::text) FROM event`,
        [
          randomUUID(),
          kind,
          this.instance.id,
          JSON.stringify(payload),
          this.cluster.busEventTtlMs,
          this.cluster.busChannel,
        ],
      );
      this.metrics?.clusterBusMessages.inc({ kind, outcome: 'published' });
    } catch {
      this.metrics?.clusterBusMessages.inc({ kind, outcome: 'publish_failed' });
      this.logger.error(`Cluster bus publish failed [kind=${kind}]`);
    }
  }
  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return;
    await this.listen();
    this.cleanup = setInterval(
      () => void this.purge(),
      this.cluster.cleanupIntervalMs,
    );
    this.cleanup.unref();
  }
  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.reconnect) clearTimeout(this.reconnect);
    if (this.cleanup) clearInterval(this.cleanup);
    const client = this.client;
    this.client = undefined;
    this.setListening(false);
    await client?.end().catch(() => undefined);
  }
  // Bounded delete of expired envelopes; any replica may run it.
  async purge(): Promise<number> {
    try {
      const [, affected] = (await this.dataSource.query(
        `DELETE FROM distributed_bus_events WHERE id IN (
           SELECT id FROM distributed_bus_events WHERE expires_at <= now()
           ORDER BY expires_at LIMIT 1000)`,
      )) as [unknown, number];
      if (affected)
        this.metrics?.clusterCleanup.inc({ kind: 'bus_events' }, affected);
      return affected ?? 0;
    } catch {
      this.logger.warn('Cluster bus cleanup failed');
      return 0;
    }
  }
  private setListening(value: boolean): void {
    this.listening = value;
    this.metrics?.clusterBusConnected.set(value ? 1 : 0);
  }
  private async listen(): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client({
      ...pgClientConfig(this.database),
      application_name: `skyrim-admin-api:bus`,
    });
    const lost = () => {
      if (this.client !== client) return;
      this.client = undefined;
      this.setListening(false);
      client.removeAllListeners();
      void client.end().catch(() => undefined);
      if (this.stopped) return;
      this.logger.warn(
        `Cluster bus listener lost; reconnecting [instanceId=${this.instance.id}]`,
      );
      this.schedule();
    };
    client.on('error', lost);
    client.on('end', lost);
    client.on('notification', (message) => {
      if (message.channel === this.cluster.busChannel && message.payload)
        void this.receive(message.payload);
    });
    try {
      this.client = client;
      await client.connect();
      // Quoted identifier: the channel pattern is validated at boot.
      await client.query(`LISTEN "${this.cluster.busChannel}"`);
      if (this.client !== client) return;
      if (this.attempt > 0) {
        this.metrics?.clusterBusReconnects.inc();
        this.logger.log(
          `Cluster bus listener restored [instanceId=${this.instance.id} attempts=${this.attempt}]`,
        );
      } else
        this.logger.log(
          `Cluster bus listening [instanceId=${this.instance.id}]`,
        );
      this.attempt = 0;
      this.setListening(true);
    } catch {
      this.metrics?.clusterBusErrors.inc();
      if (this.client === client) lost();
    }
  }
  private schedule(): void {
    if (this.stopped || this.reconnect) return;
    this.attempt++;
    const delay = Math.min(
      this.cluster.busReconnectMaxMs,
      MIN_BACKOFF_MS * 2 ** Math.min(this.attempt - 1, 16),
    );
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined;
      void this.listen();
    }, delay);
    this.reconnect.unref();
  }
  private async receive(notification: string): Promise<void> {
    if (this.stopped) return;
    const [origin, id] = notification.split(':');
    if (!origin || !id || origin === this.instance.id) return;
    try {
      const [row] = (await this.dataSource.query(
        'SELECT kind, payload FROM distributed_bus_events WHERE id = $1 AND expires_at > now()',
        [id],
      )) as { kind: ClusterKind; payload: ClusterPayload }[];
      if (!row) {
        this.metrics?.clusterBusMessages.inc({
          kind: 'unknown',
          outcome: 'expired',
        });
        return;
      }
      this.metrics?.clusterBusMessages.inc({
        kind: row.kind,
        outcome: 'received',
      });
      for (const handler of this.handlers.get(row.kind) ?? [])
        try {
          await handler(row.payload);
        } catch {
          this.logger.error(`Cluster bus handler failed [kind=${row.kind}]`);
        }
    } catch {
      this.metrics?.clusterBusMessages.inc({
        kind: 'unknown',
        outcome: 'read_failed',
      });
      this.logger.warn('Cluster bus event not read');
    }
  }
  // Test/diagnostic hook: the backend pid of the LISTEN session.
  get listenerPid(): number | undefined {
    return (this.client as unknown as { processID?: number })?.processID;
  }
}
