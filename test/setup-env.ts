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
// Every suite drives many logins, sockets and mutations from 127.0.0.1, so
// the per-process abuse limits (12.1) default to generous values here. The
// abuse suite (test/security.e2e-spec.ts) sets tight limits explicitly;
// the production defaults are asserted by src/config/environment.spec.ts.
const generous: Record<string, string> = {
  STAFF_LOGIN_RATE_LIMIT_PER_IP: '10000',
  STAFF_LOGIN_RATE_LIMIT_PER_USERNAME: '10000',
  STAFF_LOGIN_MAX_CONCURRENT: '64',
  STAFF_REFRESH_RATE_LIMIT_PER_IP: '100000',
  STAFF_REFRESH_RATE_LIMIT_PER_SESSION: '10000',
  REALTIME_CONNECT_RATE_LIMIT_PER_MINUTE: '100000',
  REALTIME_MAX_CONNECTIONS_PER_IDENTITY: '100',
  AGENT_CONNECT_RATE_LIMIT_PER_MINUTE: '100000',
  AGENT_AUTH_FAILURE_LIMIT_PER_MINUTE: '10000',
  AGENT_MAX_CONCURRENT_AUTH: '64',
  PLAYER_CHARACTER_QUERY_RATE_LIMIT_PER_MINUTE: '10000',
  PLAYER_MARKET_MUTATION_RATE_LIMIT_PER_MINUTE: '10000',
};
for (const [name, value] of Object.entries(generous))
  process.env[name] ??= value;
