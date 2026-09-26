import {
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { RateLimiter } from '../common/rate-limit/rate-limiter.js';
import type {
  RateLimitDecision,
  RateLimitRule,
} from '../common/rate-limit/rate-limiter.js';
import type { Metrics } from '../observability/metrics.js';

// Keys are hashed with their scope: an IP, username, session or player id
// never reaches the database in plaintext.
export const bucketHash = (scope: string, key: string) =>
  createHash('sha256').update(`${scope}\u0000${key}`).digest('hex');
const REFUSED: RateLimitDecision = { allowed: false, retryAfterSeconds: 1 };

// Shared RateLimiter of a MULTI deployment (12.5): one PostgreSQL row per
// (scope, hashed key), updated by one atomic upsert, so an attacker
// spreading attempts over replicas hits the same bucket. The window clock
// is the database's (`now` arguments are ignored), identical for every
// replica. A storage failure refuses the attempt (fail closed, counted in
// rate_limit_backend_errors_total): these limits protect authentication
// and costly actions, which need the same database anyway.
export class PostgresRateLimiter
  extends RateLimiter
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger('PostgresRateLimiter');
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private readonly database: DataSource,
    private readonly cleanupIntervalMs: number,
    private readonly metrics?: Metrics,
  ) {
    super();
  }
  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.purge(), this.cleanupIntervalMs);
    this.timer.unref();
  }
  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }
  async consume(
    scope: string,
    key: string,
    rule: RateLimitRule,
  ): Promise<RateLimitDecision> {
    try {
      const [row] = (await this.database.query(
        `INSERT INTO rate_limit_buckets AS b (scope, key_hash, hits, window_started_at, expires_at)
         VALUES ($1, $2, 1, now(), now() + $3 * interval '1 millisecond')
         ON CONFLICT (scope, key_hash) DO UPDATE SET
           hits = CASE WHEN b.expires_at <= now() THEN 1 ELSE LEAST(b.hits + 1, $4 + 1) END,
           window_started_at = CASE WHEN b.expires_at <= now() THEN now() ELSE b.window_started_at END,
           expires_at = CASE WHEN b.expires_at <= now() THEN now() + $3 * interval '1 millisecond' ELSE b.expires_at END
         RETURNING hits, EXTRACT(EPOCH FROM (expires_at - now()))::float8 AS remaining`,
        [scope, bucketHash(scope, key), rule.windowMs, rule.limit],
      )) as { hits: number; remaining: number }[];
      return decide(row.hits <= rule.limit, row.remaining);
    } catch {
      return this.failed(scope);
    }
  }
  async check(
    scope: string,
    key: string,
    rule: RateLimitRule,
  ): Promise<RateLimitDecision> {
    try {
      const [row] = (await this.database.query(
        `SELECT hits, EXTRACT(EPOCH FROM (expires_at - now()))::float8 AS remaining
         FROM rate_limit_buckets WHERE scope = $1 AND key_hash = $2 AND expires_at > now()`,
        [scope, bucketHash(scope, key)],
      )) as { hits: number; remaining: number }[];
      return decide(!row || row.hits < rule.limit, row?.remaining ?? 0);
    } catch {
      return this.failed(scope);
    }
  }
  async reset(scope?: string, key?: string): Promise<void> {
    try {
      if (scope === undefined)
        await this.database.query('DELETE FROM rate_limit_buckets');
      else if (key === undefined)
        await this.database.query(
          'DELETE FROM rate_limit_buckets WHERE scope = $1',
          [scope],
        );
      else
        await this.database.query(
          'DELETE FROM rate_limit_buckets WHERE scope = $1 AND key_hash = $2',
          [scope, bucketHash(scope, key)],
        );
    } catch {
      this.metrics?.rateLimitBackendErrors.inc();
      this.logger.error(`Shared rate limit reset failed [scope=${scope}]`);
    }
  }
  // Bounded delete of expired rows (buckets and chat slots); any replica.
  async purge(): Promise<number> {
    let total = 0;
    for (const [table, kind] of [
      ['rate_limit_buckets', 'rate_limits'],
      ['rate_limit_slots', 'rate_limit_slots'],
    ] as const)
      try {
        const [, affected] = (await this.database.query(
          `DELETE FROM ${table} WHERE ctid IN (
             SELECT ctid FROM ${table} WHERE expires_at <= now() LIMIT 5000)`,
        )) as [unknown, number];
        if (affected) this.metrics?.clusterCleanup.inc({ kind }, affected);
        total += affected ?? 0;
      } catch {
        this.logger.warn(`Rate limit cleanup failed [table=${table}]`);
      }
    return total;
  }
  private failed(scope: string): RateLimitDecision {
    this.metrics?.rateLimitBackendErrors.inc();
    this.logger.error(
      `Shared rate limit unavailable; refusing [scope=${scope}]`,
    );
    return REFUSED;
  }
}
function decide(ok: boolean, remainingSeconds: number): RateLimitDecision {
  return ok
    ? { allowed: true, retryAfterSeconds: 0 }
    : {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(remainingSeconds)),
      };
}
