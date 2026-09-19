import { SafeDatabaseLogger } from './logging/safe-database.logger.js';
import { fileURLToPath } from 'node:url';
import type { DataSourceOptions } from 'typeorm';
import type { ApplicationConfig } from '../config/environment.js';

export function createDatabaseOptions(
  config: ApplicationConfig,
): DataSourceOptions {
  return {
    type: 'postgres',
    ...config.database,
    logger: new SafeDatabaseLogger(config.database.logging),
    synchronize: false,
    migrationsRun: false,
    entities: [fileURLToPath(new URL('../**/*.entity.js', import.meta.url))],
    migrations: [fileURLToPath(new URL('./migrations/*.js', import.meta.url))],
    connectTimeoutMS: 5000,
    extra: {
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
    },
  };
}
