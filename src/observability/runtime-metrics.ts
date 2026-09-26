import { Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SafeDatabaseLogger } from '../database/logging/safe-database.logger.js';
import { LifecycleService } from '../lifecycle/lifecycle.service.js';
import { Metrics } from './metrics.js';

interface PgPool {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  on(event: 'error', listener: () => void): void;
}

// Scrape-time reads of in-memory state (pool, lifecycle) and the database
// query-error hook. No query per scrape.
@Injectable()
export class RuntimeMetrics implements OnModuleInit {
  constructor(
    private readonly metrics: Metrics,
    private readonly database: DataSource,
    private readonly lifecycle: LifecycleService,
  ) {}
  onModuleInit(): void {
    const pool = (this.database.driver as { master?: PgPool } | undefined)
      ?.master;
    pool?.on('error', () => this.metrics.dbPoolErrors.inc());
    const logger = this.database.logger as unknown;
    if (logger instanceof SafeDatabaseLogger)
      logger.onQueryError = () => this.metrics.dbQueryErrors.inc();
    this.metrics.onCollect(() => {
      if (pool) {
        this.metrics.dbPool.set({ state: 'total' }, pool.totalCount);
        this.metrics.dbPool.set({ state: 'idle' }, pool.idleCount);
        this.metrics.dbPool.set({ state: 'waiting' }, pool.waitingCount);
      }
      const state = this.lifecycle.state();
      this.metrics.ready.set(
        state.bootstrapped && !state.shuttingDown && state.lock ? 1 : 0,
      );
      this.metrics.instanceLock.set(
        this.lifecycle.lockRequired ? (state.lock ? 1 : 0) : -1,
      );
    });
  }
}
