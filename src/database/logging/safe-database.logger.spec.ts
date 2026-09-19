import { Logger as NestLogger } from '@nestjs/common';
import { jest } from '@jest/globals';
import type { Logger } from 'typeorm';
import { SafeDatabaseLogger } from './safe-database.logger.js';

describe('Database logging', () => {
  it('omits query text, parameters and driver errors even when logging is enabled', () => {
    const calls: unknown[][] = [];
    const spies = (['debug', 'error', 'warn', 'log'] as const).map((method) =>
      jest
        .spyOn(NestLogger.prototype, method)
        .mockImplementation((...args: unknown[]) => {
          calls.push(args);
        }),
    );
    try {
      const logger: Logger = new SafeDatabaseLogger(true);
      logger.logQuery('SQL secret', ['password-secret', 'hash-secret']);
      logger.logQueryError('error-secret', 'SQL secret', ['token-secret']);
      logger.logQuerySlow(100, 'SQL secret', ['hash-secret']);
      logger.logSchemaBuild('schema-secret');
      logger.logMigration('migration-secret');
      logger.log('warn', 'driver-secret');
      expect(calls.length).toBeGreaterThan(0);
      expect(JSON.stringify(calls)).not.toContain('secret');
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});
