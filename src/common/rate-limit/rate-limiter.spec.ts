import { ConcurrencyLimiter } from './concurrency-limiter.js';
import { MAX_RATE_LIMIT_KEYS, MemoryRateLimiter } from './rate-limiter.js';

describe('Shared rate limiter (12.1)', () => {
  const rule = { limit: 2, windowMs: 10_000 };
  it('counts per scope and key in fixed windows with Retry-After', async () => {
    const limiter = new MemoryRateLimiter();
    expect((await limiter.consume('s', 'a', rule, 0)).allowed).toBe(true);
    expect((await limiter.check('s', 'a', rule, 0)).allowed).toBe(true);
    expect((await limiter.consume('s', 'a', rule, 0)).allowed).toBe(true);
    expect(await limiter.consume('s', 'a', rule, 1000)).toEqual({
      allowed: false,
      retryAfterSeconds: 9,
    });
    expect((await limiter.check('s', 'a', rule, 1000)).allowed).toBe(false);
    expect((await limiter.consume('other', 'a', rule, 1000)).allowed).toBe(
      true,
    );
    expect((await limiter.consume('s', 'b', rule, 1000)).allowed).toBe(true);
    expect((await limiter.consume('s', 'a', rule, 10_000)).allowed).toBe(true);
    await limiter.reset('s', 'a');
    expect((await limiter.check('s', 'a', rule, 10_001)).allowed).toBe(true);
    await limiter.reset('s');
    expect(limiter.size()).toBe(1);
    await limiter.reset();
    expect(limiter.size()).toBe(0);
  });
  it('stays bounded under a flood of distinct keys', () => {
    const limiter = new MemoryRateLimiter();
    for (let i = 0; i < MAX_RATE_LIMIT_KEYS + 500; i++)
      limiter.consumeNow('flood', String(i), rule, 0);
    expect(limiter.size()).toBeLessThanOrEqual(MAX_RATE_LIMIT_KEYS);
  });
  it('caps concurrent work and releases slots once', () => {
    const slots = new ConcurrencyLimiter();
    const a = slots.tryAcquire('hash', 2)!;
    const b = slots.tryAcquire('hash', 2)!;
    expect(slots.tryAcquire('hash', 2)).toBeNull();
    a();
    a();
    expect(slots.running('hash')).toBe(1);
    expect(slots.tryAcquire('hash', 2)).not.toBeNull();
    b();
  });
});
