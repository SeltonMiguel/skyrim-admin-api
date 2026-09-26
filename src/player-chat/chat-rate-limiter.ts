import {
  HttpException,
  HttpStatus,
  Injectable,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { bucketHash } from '../cluster/pg-rate-limiter.js';
import type { ApplicationConfig } from '../config/environment.js';

const SCOPE = 'chat';
export type ChatSlot = { owner: boolean } | { retryAfter: number };

const MAX_TRACKED_BUCKETS = 10_000;

export class ChatRateLimitedException extends HttpException {
  constructor(readonly retryAfter: number) {
    super('Too many messages', HttpStatus.TOO_MANY_REQUESTS);
  }
}
// Anti-spam: a sliding window of sends per player + character link. A slot
// belongs to one Idempotency-Key, so retries of the same message, even
// concurrent ones, never consume extra quota. SINGLE keeps the slots in
// memory; MULTI (12.5) keeps them in rate_limit_slots (hashed bucket and
// key, one transaction under an advisory lock per bucket), so the quota is
// the same whatever replica serves each send. This keyed window does not
// fit the fixed-window RateLimiter contract, hence its own store.
@Injectable()
export class ChatRateLimiter {
  readonly limit: number;
  readonly windowMs: number;
  private readonly shared: boolean;
  private readonly buckets = new Map<string, { at: number; key: string }[]>();
  constructor(
    config: ConfigService<{ application: ApplicationConfig }, true>,
    @Optional() private readonly database?: DataSource,
  ) {
    const application = config.get('application', { infer: true });
    const chat = application.playerChat;
    this.limit = chat.rateLimitCount;
    this.windowMs = chat.rateLimitWindow * 1000;
    this.shared =
      application.deployment?.topology === 'MULTI' && database !== undefined;
  }
  // owner: this call reserved the slot (and must release it on failure);
  // false when the same request key already holds one.
  async acquire(
    bucket: string,
    request: string,
    now = Date.now(),
  ): Promise<ChatSlot> {
    return this.shared
      ? this.acquireShared(bucket, request)
      : this.acquireLocal(bucket, request, now);
  }
  private async acquireShared(
    bucket: string,
    request: string,
  ): Promise<ChatSlot> {
    const key = bucketHash(SCOPE, bucket);
    const slot = bucketHash(SCOPE, request);
    return this.database!.transaction(async (manager) => {
      await manager.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`${SCOPE}:${key}`],
      );
      await manager.query(
        'DELETE FROM rate_limit_slots WHERE scope = $1 AND key_hash = $2 AND expires_at <= now()',
        [SCOPE, key],
      );
      const rows = (await manager.query(
        `SELECT slot_hash, EXTRACT(EPOCH FROM (expires_at - now()))::float8 AS remaining
         FROM rate_limit_slots WHERE scope = $1 AND key_hash = $2 ORDER BY created_at`,
        [SCOPE, key],
      )) as { slot_hash: string; remaining: number }[];
      if (rows.some((row) => row.slot_hash === slot)) return { owner: false };
      if (rows.length >= this.limit)
        return { retryAfter: Math.max(1, Math.ceil(rows[0].remaining)) };
      await manager.query(
        `INSERT INTO rate_limit_slots(scope, key_hash, slot_hash, created_at, expires_at)
         VALUES ($1, $2, $3, now(), now() + $4 * interval '1 millisecond')`,
        [SCOPE, key, slot, this.windowMs],
      );
      return { owner: true };
    });
  }
  private acquireLocal(bucket: string, request: string, now: number): ChatSlot {
    if (this.buckets.size > MAX_TRACKED_BUCKETS)
      for (const [tracked, entries] of this.buckets)
        if (entries.every((e) => now - e.at >= this.windowMs))
          this.buckets.delete(tracked);
    const entries = (this.buckets.get(bucket) ?? []).filter(
      (e) => now - e.at < this.windowMs,
    );
    this.buckets.set(bucket, entries);
    if (entries.some((e) => e.key === request)) return { owner: false };
    if (entries.length >= this.limit)
      return {
        retryAfter: Math.max(
          1,
          Math.ceil((entries[0].at + this.windowMs - now) / 1000),
        ),
      };
    entries.push({ at: now, key: request });
    return { owner: true };
  }
  // Gives the slot back when the send did not happen (error or rollback).
  async release(bucket: string, request: string): Promise<void> {
    if (this.shared) {
      await this.database!.query(
        'DELETE FROM rate_limit_slots WHERE scope = $1 AND key_hash = $2 AND slot_hash = $3',
        [SCOPE, bucketHash(SCOPE, bucket), bucketHash(SCOPE, request)],
      );
      return;
    }
    const entries = this.buckets.get(bucket);
    if (entries)
      this.buckets.set(
        bucket,
        entries.filter((e) => e.key !== request),
      );
  }
  async reset(): Promise<void> {
    this.buckets.clear();
    if (this.shared)
      await this.database!.query(
        'DELETE FROM rate_limit_slots WHERE scope = $1',
        [SCOPE],
      );
  }
}
