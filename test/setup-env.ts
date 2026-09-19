import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';

// HTTP e2e uses a substituted DataSource and deterministic example settings.
// Real PostgreSQL integration keeps the developer's environment intact.
const integration = process.env.TEST_DATABASE_INTEGRATION === 'true';
if (!integration) {
  Object.assign(process.env, parse(readFileSync('.env.example')));
}
process.env.NODE_ENV = 'test';
process.env.DB_LOGGING = 'false';
