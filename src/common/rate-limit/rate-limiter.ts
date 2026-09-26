import { Injectable } from '@nestjs/common';

export interface RateLimitRule {
  readonly limit: number;
  readonly windowMs: number;
}
export interface RateLimitDecision {
  readonly allowed: boolean;
  // Whole seconds until the window resets; 0 when allowed.
  readonly retryAfterSeconds: number;
}

// The only rate-limiting primitive of the backend (12.1): fixed windows per
// (scope, key). Callers never keep their own maps. SINGLE uses the
// in-memory implementation (per process); MULTI (12.5) uses the PostgreSQL
// one (src/cluster/pg-rate-limiter.ts), so every replica shares one bucket.
// Asynchronous since 12.5 for that store. Keys must never contain secrets;
// the shared store hashes them.
export abstract class RateLimiter {
  // Counts one attempt and says whether it is allowed.
  abstract consume(
    scope: string,
    key: string,
    rule: RateLimitRule,
    now?: number,
  ): Promise<RateLimitDecision>;
  // Says whether one more attempt would be allowed, without counting it.
  abstract check(
    scope: string,
    key: string,
    rule: RateLimitRule,
    now?: number,
  ): Promise<RateLimitDecision>;
  // Forgets a key (e.g. after a successful login) or a whole scope.
  abstract reset(scope?: string, key?: string): Promise<void>;
}

// Bound on tracked keys; expired windows are pruned first, then the oldest
// entries, so memory stays bounded under a flood of distinct keys.
export const MAX_RATE_LIMIT_KEYS = 50_000;
const PRUNE_INTERVAL_MS = 1000;

@Injectable()
export class MemoryRateLimiter extends RateLimiter {
  private readonly windows = new Map<
    string,
    { start: number; count: number; windowMs: number }
  >();
  private lastPrune = 0;
  // Effects are synchronous; the Promise only matches the shared contract.
  async consume(
    scope: string,
    key: string,
    rule: RateLimitRule,
    now = Date.now(),
  ): Promise<RateLimitDecision> {
    return this.consumeNow(scope, key, rule, now);
  }
  consumeNow(
    scope: string,
    key: string,
    rule: RateLimitRule,
    now = Date.now(),
  ): RateLimitDecision {
    const id = `${scope}\u0000${key}`;
    const window = this.current(id, now);
    if (!window) {
      this.prune(now);
      this.windows.set(id, { start: now, count: 1, windowMs: rule.windowMs });
      return allowed(rule.limit >= 1, now, now, rule);
    }
    if (window.count >= rule.limit)
      return allowed(false, window.start, now, rule);
    window.count++;
    return allowed(true, window.start, now, rule);
  }
  async check(
    scope: string,
    key: string,
    rule: RateLimitRule,
    now = Date.now(),
  ): Promise<RateLimitDecision> {
    const window = this.current(`${scope}\u0000${key}`, now);
    if (!window || window.count < rule.limit)
      return { allowed: true, retryAfterSeconds: 0 };
    return allowed(false, window.start, now, rule);
  }
  async reset(scope?: string, key?: string): Promise<void> {
    this.resetNow(scope, key);
  }
  resetNow(scope?: string, key?: string): void {
    if (scope === undefined) return this.windows.clear();
    if (key !== undefined) {
      this.windows.delete(`${scope}\u0000${key}`);
      return;
    }
    for (const id of this.windows.keys())
      if (id.startsWith(`${scope}\u0000`)) this.windows.delete(id);
  }
  size(): number {
    return this.windows.size;
  }
  private current(id: string, now: number) {
    const window = this.windows.get(id);
    if (window && now - window.start < window.windowMs) return window;
    if (window) this.windows.delete(id);
    return undefined;
  }
  private prune(now: number): void {
    if (this.windows.size < MAX_RATE_LIMIT_KEYS) return;
    if (now - this.lastPrune >= PRUNE_INTERVAL_MS) {
      this.lastPrune = now;
      for (const [id, window] of this.windows)
        if (now - window.start >= window.windowMs) this.windows.delete(id);
    }
    // Still full of live windows: evict the oldest insertions.
    for (const id of this.windows.keys()) {
      if (this.windows.size < MAX_RATE_LIMIT_KEYS) break;
      this.windows.delete(id);
    }
  }
}
function allowed(
  ok: boolean,
  start: number,
  now: number,
  rule: RateLimitRule,
): RateLimitDecision {
  return ok
    ? { allowed: true, retryAfterSeconds: 0 }
    : {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((start + rule.windowMs - now) / 1000),
        ),
      };
}
