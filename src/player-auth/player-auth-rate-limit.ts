import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { ApplicationConfig } from '../config/environment.js';
import { RateLimiter } from '../common/rate-limit/rate-limiter.js';

export const RATE_LIMIT_WINDOW_MS = 60_000;
const SCOPE = 'player-auth';

// Fixed window per route and client IP (request.ip, resolved by the
// TRUST_PROXY policy, so X-Forwarded-For counts only through a trusted
// proxy). Backed by the shared RateLimiter (shared between replicas in MULTI, 12.5).
@Injectable()
export class PlayerAuthRateLimiter {
  readonly limit: number;
  constructor(
    private readonly limiter: RateLimiter,
    config: ConfigService<{ application: ApplicationConfig }, true>,
  ) {
    this.limit = config.get('application', {
      infer: true,
    }).playerAuth.rateLimitPerMinute;
  }
  // Returns seconds to wait when the limit is exceeded, otherwise null.
  async consume(key: string, now = Date.now()): Promise<number | null> {
    const decision = await this.limiter.consume(
      SCOPE,
      key,
      { limit: this.limit, windowMs: RATE_LIMIT_WINDOW_MS },
      now,
    );
    return decision.allowed ? null : decision.retryAfterSeconds;
  }
  reset(): Promise<void> {
    return this.limiter.reset(SCOPE);
  }
}
@Injectable()
export class PlayerAuthRateLimitGuard implements CanActivate {
  constructor(private readonly limiter: PlayerAuthRateLimiter) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const retryAfter = await this.limiter.consume(
      `${context.getClass().name}.${context.getHandler().name}:${request.ip ?? 'unknown'}`,
    );
    if (retryAfter === null) return true;
    http.getResponse<Response>().setHeader('Retry-After', String(retryAfter));
    throw new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS);
  }
}
