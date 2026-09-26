import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { ApplicationConfig } from '../config/environment.js';
import { Metrics } from '../observability/metrics.js';
import { InstanceIdentity } from './instance-identity.js';

export type LeaseSurface = 'PLAYER' | 'STAFF';

// Cluster-wide realtime connection quota (12.5, MULTI): one lease row per
// authenticated socket, counted per (surface, principal) under an advisory
// transaction lock, so connections spread over replicas share one cap.
// Leases are renewed in one UPDATE per instance, deleted on close and on
// shutdown, and simply expire when an instance dies. No token is stored.
// The total and unauthenticated socket caps stay per process (they protect
// this process's memory). SINGLE: disabled (the in-memory count is exact).
@Injectable()
export class RealtimeLeaseService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger('RealtimeLeases');
  readonly enabled: boolean;
  private readonly ttlMs: number;
  private readonly renewMs: number;
  private readonly cleanupMs: number;
  private readonly held = new Set<string>();
  private renewTimer?: ReturnType<typeof setInterval>;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  constructor(
    private readonly database: DataSource,
    private readonly instance: InstanceIdentity,
    config: ConfigService<{ application: ApplicationConfig }, true>,
    @Optional() private readonly metrics?: Metrics,
  ) {
    const application = config.get('application', { infer: true });
    this.enabled = application.deployment.topology === 'MULTI';
    this.ttlMs = application.cluster.realtimeLeaseTtlMs;
    this.renewMs = application.cluster.realtimeLeaseRenewMs;
    this.cleanupMs = application.cluster.cleanupIntervalMs;
    metrics?.onCollect(() => metrics.realtimeLeases.set(this.held.size));
  }
  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.renewTimer = setInterval(() => void this.renew(), this.renewMs);
    this.renewTimer.unref();
    this.cleanupTimer = setInterval(() => void this.purge(), this.cleanupMs);
    this.cleanupTimer.unref();
  }
  async beforeApplicationShutdown(): Promise<void> {
    if (this.renewTimer) clearInterval(this.renewTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    if (!this.enabled) return;
    try {
      await this.database.query(
        'DELETE FROM realtime_connection_leases WHERE instance_id = $1',
        [this.instance.id],
      );
    } catch {
      this.logger.warn('Realtime leases not released on shutdown; they expire');
    }
    this.held.clear();
  }
  // The lease id, or null when the principal already holds `max` live
  // leases in the cluster. Throws on a database failure (the caller
  // refuses the socket).
  async acquire(
    surface: LeaseSurface,
    principalId: string,
    sessionId: string | undefined,
    max: number,
  ): Promise<string | null> {
    const id = randomUUID();
    const acquired = await this.database.transaction(async (manager) => {
      await manager.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`realtime:${surface}:${principalId}`],
      );
      const [{ n }] = (await manager.query(
        `SELECT count(*)::int AS n FROM realtime_connection_leases
         WHERE surface = $1 AND principal_id = $2 AND expires_at > now()`,
        [surface, principalId],
      )) as { n: number }[];
      if (n >= max) return false;
      await manager.query(
        `INSERT INTO realtime_connection_leases(id, surface, principal_id, session_id, instance_id, connected_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, now(), now() + $6 * interval '1 millisecond')`,
        [
          id,
          surface,
          principalId,
          sessionId ?? null,
          this.instance.id,
          this.ttlMs,
        ],
      );
      return true;
    });
    if (!acquired) return null;
    this.held.add(id);
    return id;
  }
  async release(id: string): Promise<void> {
    this.held.delete(id);
    try {
      await this.database.query(
        'DELETE FROM realtime_connection_leases WHERE id = $1',
        [id],
      );
    } catch {
      this.logger.warn('Realtime lease not released; it expires');
    }
  }
  // One UPDATE for every socket of this instance.
  async renew(): Promise<void> {
    if (!this.held.size) return;
    try {
      await this.database.query(
        `UPDATE realtime_connection_leases SET expires_at = now() + $2 * interval '1 millisecond'
         WHERE instance_id = $1`,
        [this.instance.id, this.ttlMs],
      );
    } catch {
      this.logger.warn('Realtime leases not renewed');
    }
  }
  async purge(): Promise<number> {
    try {
      const [, affected] = (await this.database.query(
        `DELETE FROM realtime_connection_leases WHERE id IN (
           SELECT id FROM realtime_connection_leases WHERE expires_at <= now()
           ORDER BY expires_at LIMIT 1000)`,
      )) as [unknown, number];
      if (affected)
        this.metrics?.clusterCleanup.inc({ kind: 'realtime_leases' }, affected);
      return affected ?? 0;
    } catch {
      this.logger.warn('Realtime lease cleanup failed');
      return 0;
    }
  }
}
