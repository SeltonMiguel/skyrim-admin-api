import { DataSource } from 'typeorm';
import type { DataSourceOptions } from 'typeorm';
import type { ApplicationConfig } from '../config/environment.js';
import { schemaStatus } from '../database/schema-status.js';
import { INSTANCE_LOCK_KEY } from '../lifecycle/instance-lock.js';
import { migrationOptions } from './migration-runner.js';

export type FindingLevel = 'OK' | 'WARN' | 'ERROR';
export interface Finding {
  level: FindingLevel;
  check: string;
  detail: string;
}
export const MIN_POSTGRES_VERSION = 130000; // gen_random_uuid() is core since 13

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'postgres']);

// Production configuration review (12.2). Nothing here prints a secret or a
// value that could contain one; findings name variables and decisions.
export function configFindings(config: ApplicationConfig): Finding[] {
  const out: Finding[] = [];
  const add = (level: FindingLevel, check: string, detail: string) =>
    out.push({ level, check, detail });
  const { security, database, deployment } = config;
  if (config.nodeEnv !== 'production')
    add(
      'ERROR',
      'NODE_ENV',
      `is ${config.nodeEnv}; production requires NODE_ENV=production`,
    );
  else add('OK', 'NODE_ENV', 'production');
  if (!deployment.singleInstanceLock)
    add(
      'ERROR',
      'SINGLE_INSTANCE_LOCK_ENABLED',
      'the single-instance lock is off',
    );
  else
    add(
      'OK',
      'BACKEND_TOPOLOGY',
      'SINGLE with the single-instance lock (one replica)',
    );
  if (security.trustProxy === 'false')
    add(
      'WARN',
      'TRUST_PROXY',
      'false: correct only if clients reach the backend directly; behind a reverse proxy set its hops or CIDR, or every client shares one rate-limit bucket',
    );
  else add('OK', 'TRUST_PROXY', 'explicit proxy trust configured');
  if (!security.corsOrigins.length)
    add(
      'WARN',
      'CORS_ORIGINS',
      'empty: no browser origin may call the API; confirm no Admin Web runs on another origin',
    );
  else add('OK', 'CORS_ORIGINS', `${security.corsOrigins.length} origin(s)`);
  if (!security.realtimeOrigins.length)
    add(
      'WARN',
      'REALTIME_ALLOWED_ORIGINS',
      'empty: in production every browser Origin is refused on /api/v1/realtime (clients without Origin still connect)',
    );
  else
    add(
      'OK',
      'REALTIME_ALLOWED_ORIGINS',
      `${security.realtimeOrigins.length} origin(s)`,
    );
  if (!security.hstsMaxAgeSeconds)
    add(
      'WARN',
      'SECURITY_HSTS_MAX_AGE_SECONDS',
      '0: HSTS must then be set by the TLS proxy',
    );
  else add('OK', 'SECURITY_HSTS_MAX_AGE_SECONDS', 'HSTS enabled');
  if (security.swaggerEnabled)
    add(
      'WARN',
      'SWAGGER_ENABLED',
      'on: /docs maps every route; keep it behind a private network',
    );
  else add('OK', 'SWAGGER_ENABLED', 'off');
  const local = LOCAL_HOSTS.has(database.host);
  if (database.ssl.mode === 'disable')
    add(
      local ? 'OK' : 'WARN',
      'DB_SSL_MODE',
      local
        ? 'disable (local database)'
        : 'disable towards a non-local host: traffic and credentials are not encrypted',
    );
  else if (database.ssl.mode === 'require')
    add(
      'WARN',
      'DB_SSL_MODE',
      'require: encrypted but the server certificate is not verified; prefer verify-full',
    );
  else add('OK', 'DB_SSL_MODE', 'verify-full');
  add(
    'OK',
    'DB_POOL_MAX',
    `${database.poolMax} per replica (+1 lock connection)`,
  );
  return out;
}

// Database review: reachability, version, extensions, migrations and
// whether a backend currently holds the single-instance lock.
export async function databaseFindings(
  config: ApplicationConfig,
  options: { requireCurrent: boolean },
  overrides: Partial<DataSourceOptions> = {},
): Promise<Finding[]> {
  const out: Finding[] = [];
  const add = (level: FindingLevel, check: string, detail: string) =>
    out.push({ level, check, detail });
  const database = new DataSource(migrationOptions(config, overrides));
  try {
    await database.initialize();
  } catch {
    add('ERROR', 'database', 'unreachable or authentication failed');
    return out;
  }
  try {
    add('OK', 'database', 'reachable');
    const [{ version }] = (await database.query(
      "SELECT current_setting('server_version_num')::int AS version",
    )) as { version: number }[];
    add(
      version >= MIN_POSTGRES_VERSION ? 'OK' : 'ERROR',
      'postgres_version',
      `${version} (minimum ${MIN_POSTGRES_VERSION})`,
    );
    const [ext] = (await database.query(
      "SELECT (SELECT count(*) FROM pg_extension WHERE extname = 'uuid-ossp')::int AS installed, (SELECT count(*) FROM pg_available_extensions WHERE name = 'uuid-ossp')::int AS available",
    )) as { installed: number; available: number }[];
    // Verification only: the preflight never creates anything. After the
    // migration (--require-current) a missing extension is an error; before
    // it, the migration runner will create it if the role may.
    add(
      ext.installed
        ? 'OK'
        : ext.available && !options.requireCurrent
          ? 'WARN'
          : 'ERROR',
      'extension_uuid_ossp',
      ext.installed
        ? 'installed'
        : ext.available
          ? options.requireCurrent
            ? 'missing: run the migration runner (it creates it) or have an administrator create it; the application never creates extensions'
            : 'missing: the migration runner will create it (its role needs CREATE on the database; trusted since PostgreSQL 13)'
          : 'not available on this server: required by the vip_offers id default',
    );
    const status = await schemaStatus(database);
    add(
      status.pending.length
        ? options.requireCurrent
          ? 'ERROR'
          : 'WARN'
        : 'OK',
      'migrations',
      `${status.applied} applied, ${status.known} known, ${status.pending.length} pending${status.pending.length ? ` (${status.pending.join(', ')})` : ''}`,
    );
    if (status.unknown.length)
      add(
        'WARN',
        'migrations_unknown',
        `${status.unknown.length} applied migration(s) unknown to this build (newer schema)`,
      );
    const [lock] = (await database.query(
      "SELECT count(*)::int AS holders FROM pg_locks WHERE locktype = 'advisory' AND classid = $1 AND objid = $2 AND granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
      [...INSTANCE_LOCK_KEY],
    )) as { holders: number }[];
    add(
      'OK',
      'instance_lock',
      lock.holders
        ? 'held: a backend (or migration) is running on this database'
        : 'free: no backend is running on this database',
    );
    return out;
  } catch {
    add('ERROR', 'database', 'inspection query failed');
    return out;
  } finally {
    await database.destroy();
  }
}
export function printFindings(findings: Finding[]): boolean {
  for (const finding of findings)
    console.log(
      `${finding.level.padEnd(5)} ${finding.check}: ${finding.detail}`,
    );
  return !findings.some((finding) => finding.level === 'ERROR');
}
