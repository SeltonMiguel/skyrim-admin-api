import { Logger as NestLogger } from '@nestjs/common';
import type { Logger } from 'typeorm';

// Never log SQL, parameters, driver errors or entities: these can contain secrets.
export class SafeDatabaseLogger implements Logger {
  private readonly logger = new NestLogger('Database');
  // Metrics hook (12.3): counts failures, never sees SQL or parameters.
  onQueryError?: () => void;
  constructor(private readonly enabled: boolean) {}
  logQuery(): void {
    if (this.enabled) this.logger.debug('Database query');
  }
  logQueryError(): void {
    this.onQueryError?.();
    this.logger.error('Database query failed');
  }
  logQuerySlow(time: number): void {
    this.logger.warn(`Slow database query (${time}ms)`);
  }
  logSchemaBuild(): void {
    if (this.enabled) this.logger.log('Database schema operation');
  }
  logMigration(): void {
    this.logger.log('Database migration operation');
  }
  log(): void {
    /* Suppress arbitrary driver messages. */
  }
}
