import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ApplicationConfig } from '../config/environment.js';
import { ConcurrencyLimiter } from '../common/rate-limit/concurrency-limiter.js';
import { RateLimiter } from '../common/rate-limit/rate-limiter.js';
import { TooManyRequestsException } from '../common/rate-limit/too-many-requests.exception.js';
import { fingerprint, SecurityLog } from '../common/security/security-log.js';

const LOGIN_IP = 'staff-login-ip';
const LOGIN_USERNAME = 'staff-login-username';
const REFRESH_IP = 'staff-refresh-ip';
const REFRESH_SESSION = 'staff-refresh-session';
const HASHING = 'staff-login-hash';

// Staff login/refresh abuse controls (12.1), applied before any Argon2 or
// database work:
// - login: one bucket per client IP (a NAT is not locked out by one account)
//   and one per normalized username (a distributed attack on one account is
//   bounded); both count every attempt, and a successful login clears the
//   username bucket;
// - at most `maxConcurrent` Argon2 verifications run at once; extra
//   attempts get 429 immediately instead of queueing memory;
// - refresh: per client IP before verification, per session after it.
// The public answer is always the same generic 429 with Retry-After; it
// never tells which bucket was exhausted or whether the account exists.
@Injectable()
export class StaffAuthThrottle {
  private readonly policy: ApplicationConfig['security'];
  constructor(
    private readonly limiter: RateLimiter,
    private readonly concurrency: ConcurrencyLimiter,
    private readonly log: SecurityLog,
    config: ConfigService<{ application: ApplicationConfig }, true>,
  ) {
    this.policy = config.get('application', { infer: true }).security;
  }
  // Returns the release of the Argon2 slot; throws 429 when throttled.
  beginLogin(ip: string | undefined, username: string): () => void {
    const { windowMs, perIp, perUsername, maxConcurrent } =
      this.policy.staffLogin;
    const address = ip ?? 'unknown';
    const byIp = this.limiter.consume(LOGIN_IP, address, {
      limit: perIp,
      windowMs,
    });
    if (!byIp.allowed)
      this.refuse(
        'staff_login_throttled',
        address,
        byIp.retryAfterSeconds,
        username,
      );
    const byUser = this.limiter.consume(LOGIN_USERNAME, username, {
      limit: perUsername,
      windowMs,
    });
    if (!byUser.allowed)
      this.refuse(
        'staff_login_throttled',
        address,
        byUser.retryAfterSeconds,
        username,
      );
    const release = this.concurrency.tryAcquire(HASHING, maxConcurrent);
    if (!release) {
      this.log.warn('staff_login_busy', { ip: address, max: maxConcurrent });
      throw new TooManyRequestsException(1);
    }
    return release;
  }
  loginSucceeded(username: string): void {
    this.limiter.reset(LOGIN_USERNAME, username);
  }
  refreshAttempt(ip: string | undefined): void {
    const { windowMs, perIp } = this.policy.staffRefresh;
    const address = ip ?? 'unknown';
    const decision = this.limiter.consume(REFRESH_IP, address, {
      limit: perIp,
      windowMs,
    });
    if (!decision.allowed) {
      this.log.warn('staff_refresh_throttled', { ip: address, scope: 'ip' });
      throw new TooManyRequestsException(decision.retryAfterSeconds);
    }
  }
  refreshSession(ip: string | undefined, sessionId: string): void {
    const { windowMs, perSession } = this.policy.staffRefresh;
    const decision = this.limiter.consume(REFRESH_SESSION, sessionId, {
      limit: perSession,
      windowMs,
    });
    if (!decision.allowed) {
      this.log.warn('staff_refresh_throttled', {
        ip: ip ?? 'unknown',
        sessionId,
        scope: 'session',
      });
      throw new TooManyRequestsException(decision.retryAfterSeconds);
    }
  }
  private refuse(
    event: string,
    ip: string,
    retryAfter: number,
    username: string,
  ): never {
    this.log.warn(event, { ip, user: fingerprint(username) });
    throw new TooManyRequestsException(retryAfter);
  }
}
