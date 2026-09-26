import { SafeDatabaseLogger } from './logging/safe-database.logger.js';
import { fileURLToPath } from 'node:url';
import type { ClientConfig } from 'pg';
import type { DataSourceOptions } from 'typeorm';
import type { ApplicationConfig } from '../config/environment.js';

type DatabaseConfig = ApplicationConfig['database'];

// TLS towards PostgreSQL (DB_SSL_MODE). `require` encrypts without
// verifying the server (explicit opt-in only); `verify-full` verifies the
// chain (optional CA from DB_SSL_CA_FILE) and the hostname.
export function databaseSsl(
  database: DatabaseConfig,
): false | { rejectUnauthorized: boolean; ca?: string } {
  if (database.ssl.mode === 'disable') return false;
  if (database.ssl.mode === 'require') return { rejectUnauthorized: false };
  return {
    rejectUnauthorized: true,
    ...(database.ssl.ca ? { ca: database.ssl.ca } : {}),
  };
}
// A standalone pg client with the application's credentials and TLS, used
// where a connection must never return to the pool (single-instance lock).
export function pgClientConfig(database: DatabaseConfig): ClientConfig {
  return {
    host: database.host,
    port: database.port,
    user: database.username,
    password: database.password,
    database: database.database,
    ssl: databaseSsl(database),
    connectionTimeoutMillis: database.connectTimeoutMs,
    keepAlive: true,
    application_name: 'skyrim-admin-api:instance-lock',
  };
}

function baseOptions(config: ApplicationConfig) {
  const { database } = config;
  return {
    type: 'postgres' as const,
    host: database.host,
    port: database.port,
    username: database.username,
    password: database.password,
    database: database.database,
    logging: database.logging,
    ssl: databaseSsl(database),
    logger: new SafeDatabaseLogger(database.logging),
    synchronize: false,
    migrationsRun: false,
    // Never CREATE EXTENSION as a side effect of connecting (12.2): the
    // runtime only uses the schema; the migration runner creates the
    // required extensions explicitly (src/ops/migration-runner.ts).
    installExtensions: false,
    entities: [fileURLToPath(new URL('../**/*.entity.js', import.meta.url))],
    migrations: [fileURLToPath(new URL('./migrations/*.js', import.meta.url))],
    connectTimeoutMS: database.connectTimeoutMs,
  };
}

// Application pool: bounded, with a client-side query timeout and a slightly
// longer server-side statement_timeout, so runaway queries are also
// cancelled in PostgreSQL. Total connections = replicas × DB_POOL_MAX
// (+1 per replica for the single-instance lock).
export function createDatabaseOptions(
  config: ApplicationConfig,
): DataSourceOptions {
  const { database } = config;
  return {
    ...baseOptions(config),
    extra: {
      max: database.poolMax,
      idleTimeoutMillis: database.poolIdleTimeoutMs,
      connectionTimeoutMillis: database.connectTimeoutMs,
      query_timeout: database.queryTimeoutMs,
      statement_timeout: database.statementTimeoutMs,
      application_name: 'skyrim-admin-api',
    },
  };
}

// Migration runner and TypeORM CLI: one connection, its own statement and
// lock timeouts (never the 5 s API timeout), and a lock_timeout so a DDL
// never waits forever behind a running transaction.
export function createMigrationOptions(
  config: ApplicationConfig,
): DataSourceOptions {
  const { migration } = config.database;
  return {
    ...baseOptions(config),
    extra: {
      max: 1,
      connectionTimeoutMillis: config.database.connectTimeoutMs,
      // Client-side guard slightly above the server-side statement timeout.
      query_timeout: migration.statementTimeoutMs + 5000,
      statement_timeout: migration.statementTimeoutMs,
      lock_timeout: migration.lockTimeoutMs,
      application_name: 'skyrim-admin-api:migrations',
    },
  };
}
