import { DataSource } from 'typeorm';
import type { DataSourceOptions } from 'typeorm';
import type { ApplicationConfig } from '../config/environment.js';
import { createMigrationOptions } from '../database/database.options.js';
import { InstanceLock } from '../lifecycle/instance-lock.js';

// Forward-only production migration (12.2). Holds the single-instance lock
// while it runs, so it refuses to start while a backend is up and no
// backend can start mid-migration (recreate deployment). Uses the
// migration timeouts, never the 5 s API query timeout; all pending
// migrations run in one transaction (TypeORM default "all").
// Extensions the schema depends on. The historical VipStore migration uses
// uuid_generate_v4() but never creates uuid-ossp, so it must exist before
// any migration runs; the migration runner is the only place that creates
// it (the application runtime never does).
export const REQUIRED_EXTENSIONS = ['uuid-ossp'] as const;

export class MigrationPrerequisiteError extends Error {
  constructor(extension: string) {
    super(
      `Required PostgreSQL extension "${extension}" is missing and the migration role cannot create it. ` +
        `Grant the migration role CREATE on the database (the extension is trusted since PostgreSQL 13) ` +
        `or have an administrator run: CREATE EXTENSION IF NOT EXISTS "${extension}";`,
    );
    this.name = 'MigrationPrerequisiteError';
  }
}

// Idempotent: only missing extensions are created. Returns the created ones.
export async function ensureExtensions(
  database: DataSource,
): Promise<string[]> {
  const created: string[] = [];
  for (const extension of REQUIRED_EXTENSIONS) {
    const [row] = (await database.query(
      'SELECT count(*)::int AS installed FROM pg_extension WHERE extname = $1',
      [extension],
    )) as { installed: number }[];
    if (row.installed) continue;
    try {
      await database.query(`CREATE EXTENSION IF NOT EXISTS "${extension}"`);
    } catch {
      throw new MigrationPrerequisiteError(extension);
    }
    created.push(extension);
  }
  return created;
}

export async function runMigrations(
  config: ApplicationConfig,
  // Test-only connection overrides (schema, compiled artifacts).
  overrides: Partial<DataSourceOptions> = {},
  log: (message: string) => void = () => undefined,
): Promise<string[]> {
  const lock = new InstanceLock(config.database);
  await lock.acquire();
  const database = new DataSource(migrationOptions(config, overrides));
  try {
    await database.initialize();
    for (const extension of await ensureExtensions(database))
      log(`Created required extension ${extension}`);
    const applied = await database.runMigrations({ transaction: 'all' });
    return applied.map((migration) => migration.name);
  } finally {
    if (database.isInitialized) await database.destroy();
    await lock.release();
  }
}

export function migrationOptions(
  config: ApplicationConfig,
  overrides: Partial<DataSourceOptions>,
): DataSourceOptions {
  const base = createMigrationOptions(config) as DataSourceOptions & {
    extra?: object;
  };
  const extra = (overrides as { extra?: object }).extra;
  return {
    ...base,
    ...overrides,
    extra: { ...base.extra, ...extra },
  } as DataSourceOptions;
}
