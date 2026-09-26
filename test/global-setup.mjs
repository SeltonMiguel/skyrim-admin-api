// E2E global setup (12.2): the suites apply migrations directly into their
// own schemas, so the shared test database needs the extensions the
// migration runner would ensure (the runtime never creates them). Same
// explicit, idempotent step as src/ops/migration-runner.ts.
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import pg from 'pg';

export default async function globalSetup() {
  if (process.env.TEST_DATABASE_INTEGRATION !== 'true') return;
  const file = existsSync('.env') ? parse(readFileSync('.env')) : {};
  const env = { ...file, ...process.env };
  const client = new pg.Client({
    host: env.DB_HOST,
    port: Number(env.DB_PORT ?? 5432),
    user: env.DB_USERNAME,
    password: env.DB_PASSWORD,
    database: env.DB_DATABASE,
  });
  await client.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  } finally {
    await client.end();
  }
}
