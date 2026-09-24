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

export const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_TRACKED_KEYS = 10_000;

// Baseline, per-process fixed window keyed by route and client IP. It is not
// shared across instances; distributed limiting is hardened in Etapa 12.
@Injectable()
export class PlayerAuthRateLimiter {
  readonly limit: number;
  private readonly windows = new Map<
    string,
    { start: number; count: number }
  >();
  constructor(config: ConfigService<{ application: ApplicationConfig }, true>) {
    this.limit = config.get('application', {
      infer: true,
    }).playerAuth.rateLimitPerMinute;
  }
  // Returns seconds to wait when the limit is exceeded, otherwise null.
  consume(key: string, now = Date.now()): number | null {
    if (this.windows.size > MAX_TRACKED_KEYS)
      for (const [tracked, window] of this.windows)
        if (now - window.start >= RATE_LIMIT_WINDOW_MS)
          this.windows.delete(tracked);
    const window = this.windows.get(key);
    if (!window || now - window.start >= RATE_LIMIT_WINDOW_MS) {
      this.windows.set(key, { start: now, count: 1 });
      return null;
    }
    if (window.count >= this.limit)
      return Math.ceil((window.start + RATE_LIMIT_WINDOW_MS - now) / 1000);
    window.count++;
    return null;
  }
  reset(): void {
    this.windows.clear();
  }
}
@Injectable()
export class PlayerAuthRateLimitGuard implements CanActivate {
  constructor(private readonly limiter: PlayerAuthRateLimiter) {}
  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const retryAfter = this.limiter.consume(
      `${context.getClass().name}.${context.getHandler().name}:${request.ip ?? 'unknown'}`,
    );
    if (retryAfter === null) return true;
    http.getResponse<Response>().setHeader('Retry-After', String(retryAfter));
    throw new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS);
  }
}
