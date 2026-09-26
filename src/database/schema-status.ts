import type { DataSource } from 'typeorm';

export interface SchemaStatus {
  known: number;
  applied: number;
  // Known to this build but not applied: the schema is behind the code.
  pending: string[];
  // Applied but unknown to this build: a newer, backward-compatible schema
  // (expand/contract) that an older build may still run against.
  unknown: string[];
}
const name = (migration: { name?: string; constructor: { name: string } }) =>
  migration.name ?? migration.constructor.name;

// Read-only comparison of the build's migrations with the migrations table;
// never applies anything.
export async function schemaStatus(
  database: DataSource,
): Promise<SchemaStatus> {
  const known = database.migrations.map(name);
  const table = database.options.migrationsTableName ?? 'migrations';
  const exists = (
    (await database.query('SELECT to_regclass($1) AS present', [table])) as {
      present: string | null;
    }[]
  )[0]?.present;
  const rows: { name: string }[] = exists
    ? await database.query(`SELECT name FROM "${table.replace(/"/g, '')}"`)
    : [];
  const applied = new Set(rows.map((row) => row.name));
  const knownSet = new Set(known);
  return {
    known: known.length,
    applied: applied.size,
    pending: known.filter((migration) => !applied.has(migration)),
    unknown: [...applied].filter((migration) => !knownSet.has(migration)),
  };
}
