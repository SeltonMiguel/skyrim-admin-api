import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ApplicationConfig } from '../config/environment.js';

const MAX_TRACKED_BUCKETS = 10_000;

export class ChatRateLimitedException extends HttpException {
  constructor(readonly retryAfter: number) {
    super('Too many messages', HttpStatus.TOO_MANY_REQUESTS);
  }
}
// Anti-spam MVP: a sliding window of sends per player + character link, in
// memory. Single instance only; it is not distributed security (a shared
// mechanism is Etapa 12). A slot belongs to one Idempotency-Key, so retries
// of the same message, even concurrent ones, never consume extra quota.
@Injectable()
export class ChatRateLimiter {
  readonly limit: number;
  readonly windowMs: number;
  private readonly buckets = new Map<string, { at: number; key: string }[]>();
  constructor(config: ConfigService<{ application: ApplicationConfig }, true>) {
    const chat = config.get('application', { infer: true }).playerChat;
    this.limit = chat.rateLimitCount;
    this.windowMs = chat.rateLimitWindow * 1000;
  }
  // owner: this call reserved the slot (and must release it on failure);
  // false when the same request key already holds one.
  acquire(
    bucket: string,
    request: string,
    now = Date.now(),
  ): { owner: boolean } | { retryAfter: number } {
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
  release(bucket: string, request: string): void {
    const entries = this.buckets.get(bucket);
    if (entries)
      this.buckets.set(
        bucket,
        entries.filter((e) => e.key !== request),
      );
  }
  reset(): void {
    this.buckets.clear();
  }
}
