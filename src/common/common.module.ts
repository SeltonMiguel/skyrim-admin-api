import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { HttpExceptionFilter } from './filters/http-exception.filter.js';
import { RequestContext } from './request-context/request-context.service.js';
import { ClientAddress } from './net/client-address.service.js';
import { SecurityLog } from './security/security-log.js';
import { ConcurrencyLimiter } from './rate-limit/concurrency-limiter.js';
import { MemoryRateLimiter, RateLimiter } from './rate-limit/rate-limiter.js';

@Global()
@Module({
  providers: [
    RequestContext,
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    // Abuse controls (12.1): one limiter store and one proxy policy per
    // process; 12.5 replaces the RateLimiter provider with a shared one.
    { provide: RateLimiter, useClass: MemoryRateLimiter },
    ConcurrencyLimiter,
    ClientAddress,
    SecurityLog,
  ],
  exports: [
    RequestContext,
    RateLimiter,
    ConcurrencyLimiter,
    ClientAddress,
    SecurityLog,
  ],
})
export class CommonModule {}
