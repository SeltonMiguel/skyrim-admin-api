import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { PostgresRateLimiter } from '../cluster/pg-rate-limiter.js';
import type { ApplicationConfig } from '../config/environment.js';
import { Metrics } from '../observability/metrics.js';
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
    // Abuse controls (12.1): SINGLE keeps the in-memory store; MULTI (12.5)
    // shares one PostgreSQL store between replicas (quotas cluster-wide).
    // The ConcurrencyLimiter stays per process: it protects this process's
    // CPU and memory (Argon2, HELLO verifications).
    {
      provide: RateLimiter,
      inject: [ConfigService, DataSource, { token: Metrics, optional: true }],
      useFactory: (
        config: ConfigService<{ application: ApplicationConfig }, true>,
        database: DataSource,
        metrics?: Metrics,
      ): RateLimiter => {
        const application = config.get('application', { infer: true });
        return application.deployment.topology === 'MULTI'
          ? new PostgresRateLimiter(
              database,
              application.cluster.cleanupIntervalMs,
              metrics,
            )
          : new MemoryRateLimiter();
      },
    },
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
