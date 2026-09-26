import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { DataSource } from 'typeorm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { compiledDatabaseArtifacts } from './compiled-database.js';
import { loadEnvironment } from '../src/config/environment.js';
import { createDatabaseOptions } from '../src/database/database.options.js';
import { setupApp } from '../src/setup-app.js';
import { AppExpressAdapter } from '../src/common/http/app-express.adapter.js';
import { PasswordService } from '../src/auth/password.service.js';
import { GameServerService } from '../src/game-bridge/game-server.service.js';
import { AgentSessionRegistry } from '../src/game-agent/agent-session.registry.js';
import { VipDeliveryService } from '../src/vip-entitlements/vip-delivery.service.js';
import { AppLogger } from '../src/observability/app-logger.js';
import type { LogRecord } from '../src/observability/app-logger.js';
import { BacklogCollector } from '../src/observability/backlog.collector.js';
import { FakeAgent } from './support/fake-agent.js';
import { RealtimeTestClient } from './support/realtime-client.js';

// Metrics and structured logs against real PostgreSQL, sockets and Agent
// (12.3). Values are compared as deltas: counters are process-wide.
const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;
const TOKEN = `metrics-${randomUUID()}-${randomUUID()}`;
const ENV = {
  METRICS_ENABLED: 'true',
  METRICS_BEARER_TOKEN: TOKEN,
  METRICS_COLLECTION_INTERVAL_MS: '60000',
  LOG_FORMAT: 'json',
  LOG_LEVEL: 'debug',
  APP_VERSION: '12.3.0-test',
  GIT_SHA: 'abcdef1',
  GAME_COMMAND_WORKER_INTERVAL_MS: '100',
  SERVER_CONTROL_WORKER_INTERVAL_MS: '100',
  SERVER_CONTROL_DELIVERY_WINDOW_MS: '1000',
  SERVER_CONTROL_RESULT_TIMEOUT_MS: '1500',
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually<T>(
  check: () => Promise<T | undefined | false>,
  timeoutMs = 8000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for state');
    await pause(25);
  }
}

describeDatabase('Observability: metrics and structured logs (12.3)', () => {
  let admin: DataSource, database: DataSource, app: INestApplication<App>;
  let url: string, staffToken: string;
  const schema = `observability_test_${randomUUID().replaceAll('-', '')}`;
  const password = 'Observability-Password-42';
  const records: LogRecord[] = [];
  const secrets: string[] = [TOKEN, password];
  const ids: string[] = [];
  const agents: FakeAgent[] = [];
  const sockets: RealtimeTestClient[] = [];
  const http = () => request(app.getHttpServer());
  const scrape = async () =>
    (
      await http()
        .get('/api/v1/metrics')
        .set('Authorization', `Bearer ${TOKEN}`)
        .expect(200)
    ).text;
  // Sum of the samples of one metric whose labels include `labels`.
  const value = async (name: string, labels: Record<string, string> = {}) => {
    let total = 0;
    for (const line of (await scrape()).split('\n')) {
      if (!line.startsWith(`skyrim_admin_${name}`)) continue;
      const match = /^([\w]+)(\{([^}]*)\})? (\S+)$/.exec(line);
      if (!match || match[1] !== `skyrim_admin_${name}`) continue;
      const set = Object.fromEntries(
        [...(match[3] ?? '').matchAll(/(\w+)="([^"]*)"/g)].map((m) => [
          m[1],
          m[2],
        ]),
      );
      if (Object.entries(labels).every(([k, v]) => set[k] === v))
        total += Number(match[4]);
    }
    return total;
  };

  beforeAll(async () => {
    Object.assign(process.env, ENV);
    const options = createDatabaseOptions(loadEnvironment());
    if (options.type !== 'postgres') throw new Error('PostgreSQL required');
    admin = new DataSource(options);
    await admin.initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    database = new DataSource({
      ...options,
      schema,
      ...(await compiledDatabaseArtifacts()),
      extra: { ...options.extra, options: `-c search_path=${schema},public` },
    });
    await database.initialize();
    expect(await database.runMigrations()).toHaveLength(27);
    const { AppModule } = await import('../src/app.module.js');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DataSource)
      .useValue(database)
      .compile();
    app = module.createNestApplication(new AppExpressAdapter(), {
      bufferLogs: true,
    });
    const logger = app.get(AppLogger);
    logger.echo = false;
    logger.sink = (record) => records.push(record);
    app.useLogger(logger);
    setupApp(app);
    await app.listen(0, '127.0.0.1');
    const address = (
      app.getHttpServer() as unknown as Server
    ).address() as AddressInfo;
    url = `ws://127.0.0.1:${address.port}`;
    await database.query(
      "INSERT INTO staff_users(username, display_name, password_hash, role_name) VALUES ('coordinator', 'C', $1, 'COORDINATOR')",
      [await new PasswordService().hash(password)],
    );
    staffToken = (
      await http()
        .post('/api/v1/auth/login')
        .send({ username: 'coordinator', password })
        .expect(200)
    ).body.accessToken;
    secrets.push(staffToken);
  }, 60000);
  afterEach(async () => {
    for (const s of sockets.splice(0)) if (!s.closed) await s.close();
    for (const a of agents.splice(0)) await a.close();
    await eventually(async () => app.get(AgentSessionRegistry).count() === 0);
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    for (const name of Object.keys(ENV)) delete process.env[name];
    await app?.close();
    if (database?.isInitialized) await database.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });
  const server = async () => {
    const created = await app
      .get(GameServerService)
      .register({ code: randomUUID(), name: 'Observed' });
    ids.push(created.id);
    return created;
  };
  const agent = async (
    serverId: string,
    caps: string[],
    runtime = { gameProcessState: 'RUNNING', skseReady: true },
  ) => {
    const key = (
      await http()
        .post(`/api/v1/admin/game-servers/${serverId}/agent-credentials`)
        .auth(staffToken, { type: 'bearer' })
        .expect(201)
    ).body as { credentialId: string; credentialSecret: string };
    secrets.push(key.credentialSecret);
    const created = new FakeAgent(url, serverId);
    agents.push(created);
    await created.hello(key, caps, runtime);
    return created;
  };

  it('protects /metrics with the bearer token and serves Prometheus text', async () => {
    await http().get('/api/v1/metrics').expect(401);
    await http()
      .get('/api/v1/metrics')
      .set('Authorization', 'Bearer not-the-token-at-all-000000000000')
      .expect(401);
    const ok = await http()
      .get('/api/v1/metrics')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(200);
    expect(ok.headers['content-type']).toContain('text/plain');
    expect(ok.text).toContain(
      'skyrim_admin_app_info{version="12.3.0-test",git_sha="abcdef1",topology="SINGLE"} 1',
    );
    expect(ok.text).toContain(
      'skyrim_admin_db_pool_connections{state="total"}',
    );
    expect(ok.text).toContain('skyrim_admin_ready 1');
    expect(ok.text).toContain('skyrim_admin_instance_lock_held -1');
  });

  it('counts HTTP by route template, never by concrete id', async () => {
    const s = await server();
    const route = '/api/v1/game-servers/:id';
    const before = await value('http_requests_total', {
      method: 'GET',
      route,
      status: '200',
    });
    for (let i = 0; i < 3; i++)
      await http()
        .get(`/api/v1/game-servers/${s.id}`)
        .auth(staffToken, { type: 'bearer' })
        .expect(200);
    await http()
      .get(`/api/v1/game-servers/${randomUUID()}`)
      .auth(staffToken, { type: 'bearer' })
      .expect(404);
    await http().get(`/api/v1/no-such-route/${randomUUID()}`).expect(404);
    expect(
      await value('http_requests_total', {
        method: 'GET',
        route,
        status: '200',
      }),
    ).toBe(before + 3);
    expect(
      await value('http_requests_total', { route, status: '404' }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await value('http_requests_total', { route: 'unmatched', status: '404' }),
    ).toBeGreaterThanOrEqual(1);
    // The scrape itself is not measured.
    expect(await scrape()).not.toContain('route="/api/v1/metrics"');
    // One structured request log per request, with the template and requestId.
    const log = records.find(
      (r) =>
        r.event === 'http_request' && r.route === route && r.status === 200,
    );
    expect(log).toMatchObject({
      level: 'log',
      context: 'Http',
      method: 'GET',
      requestId: expect.any(String),
      durationMs: expect.any(Number),
    });
  });

  it('observes a GameCommand end to end and the Agent session lifecycle', async () => {
    const s = await server();
    const type = 'CHARACTER_INVENTORY_QUERY';
    const terminal = {
      command_type: type,
      status: 'SUCCEEDED',
      error_code: 'none',
    };
    const [created, succeeded, acks, auth, disconnects] = await Promise.all([
      value('game_commands_created_total', {
        command_type: type,
        actor_type: 'STAFF',
      }),
      value('game_command_terminal_total', terminal),
      value('game_command_dispatch_to_ack_seconds_count', {
        command_type: type,
      }),
      value('agent_auth_total', { outcome: 'success' }),
      value('agent_disconnects_total'),
    ]);
    const host = await agent(s.id, ['GAME_COMMAND_V1', type]);
    expect(await value('agent_auth_total', { outcome: 'success' })).toBe(
      auth + 1,
    );
    expect(await value('agent_sessions_active')).toBe(1);
    const commandId = (
      await http()
        .post(
          `/api/v1/game-servers/${s.id}/characters/opaque:c/inventory/query`,
        )
        .auth(staffToken, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({})
        .expect(202)
    ).body.commandId as string;
    ids.push(commandId);
    const sent = await host.command(commandId);
    host.ack(sent);
    await eventually(
      async () =>
        (await value('game_command_dispatch_to_ack_seconds_count', {
          command_type: type,
        })) ===
        acks + 1,
    );
    await host.reply(
      host.result(sent.payload!, {
        outcome: 'SUCCEEDED',
        result: { characterId: 'opaque:c', items: [] },
      }),
    );
    expect(
      await value('game_commands_created_total', {
        command_type: type,
        actor_type: 'STAFF',
      }),
    ).toBe(created + 1);
    expect(await value('game_command_terminal_total', terminal)).toBe(
      succeeded + 1,
    );
    expect(
      await value('game_command_duration_seconds_count', {
        command_type: type,
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await value('game_command_dispatch_attempts_total', {
        command_type: type,
        attempt: 'first',
      }),
    ).toBeGreaterThanOrEqual(1);
    await host.close();
    await eventually(
      async () => (await value('agent_disconnects_total')) === disconnects + 1,
    );
    expect(await value('agent_sessions_active')).toBe(0);
    // Correlation lives in logs, with the ids as fields.
    expect(
      records.some(
        (r) => r.commandId === commandId && r.context === 'AgentGameGateway',
      ),
    ).toBe(true);
  });

  it('keeps Server Control UNCERTAIN distinct and alertable', async () => {
    const s = await server();
    const host = await agent(s.id, ['SERVER_CONTROL_V1', 'SERVER_RESTART'], {
      gameProcessState: 'RUNNING',
      skseReady: true,
    });
    const before = await value('server_control_uncertain_total', {
      type: 'SERVER_RESTART',
    });
    const created = await value('server_control_created_total', {
      type: 'SERVER_RESTART',
    });
    const operationId = (
      await http()
        .post(`/api/v1/game-servers/${s.id}/control/restart`)
        .auth(staffToken, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .expect(202)
    ).body.operationId as string;
    ids.push(operationId);
    host.perform(await host.control(operationId), undefined, false);
    await eventually(
      async () =>
        (await value('server_control_uncertain_total', {
          type: 'SERVER_RESTART',
        })) ===
        before + 1,
    );
    expect(
      await value('server_control_created_total', { type: 'SERVER_RESTART' }),
    ).toBe(created + 1);
    expect(
      await value('server_control_terminal_total', {
        type: 'SERVER_RESTART',
        status: 'UNCERTAIN',
        error_code: 'RESULT_TIMEOUT',
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(await app.get(BacklogCollector).collect()).toBe(true);
    expect(
      await value('server_control_operations', { status: 'UNCERTAIN' }),
    ).toBeGreaterThanOrEqual(1);
  });

  it('rebuilds backlog gauges from PostgreSQL and records worker success and failure', async () => {
    const s = await server();
    // A command no Agent can run stays PENDING in the database.
    ids.push(
      (
        await http()
          .post(
            `/api/v1/game-servers/${s.id}/characters/opaque:c/inventory/query`,
          )
          .auth(staffToken, { type: 'bearer' })
          .set('Idempotency-Key', randomUUID())
          .send({})
          .expect(202)
      ).body.commandId,
    );
    expect(await app.get(BacklogCollector).collect()).toBe(true);
    expect(
      await value('game_commands_backlog', { status: 'PENDING' }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await value('game_commands_oldest_age_seconds', { status: 'PENDING' }),
    ).toBeGreaterThanOrEqual(0);
    for (const work of [
      'trade_settlement',
      'marketplace_custody',
      'marketplace_settlement',
      'marketplace_release',
      'marketplace_release_failed',
    ])
      expect(await scrape()).toContain(
        `skyrim_admin_work_backlog{work="${work}"} 0`,
      );
    expect(await scrape()).toContain(
      'skyrim_admin_vip_deliveries{status="FAILED"} 0',
    );
    expect(await value('backlog_collection_timestamp_seconds')).toBeGreaterThan(
      0,
    );
    // Worker ticks: the loop keeps running and reports each outcome.
    await eventually(
      async () =>
        (await value('worker_ticks_total', {
          worker: 'game_command',
          outcome: 'success',
        })) > 0,
    );
    expect(
      await value('worker_last_success_timestamp_seconds', {
        worker: 'game_command',
      }),
    ).toBeGreaterThan(0);
    const vip = app.get(VipDeliveryService);
    const errors = await value('worker_ticks_total', {
      worker: 'vip_delivery',
      outcome: 'error',
    });
    jest.spyOn(vip, 'reconcile').mockRejectedValueOnce(new Error('boom'));
    await vip.tick();
    expect(
      await value('worker_ticks_total', {
        worker: 'vip_delivery',
        outcome: 'error',
      }),
    ).toBe(errors + 1);
    expect(
      records.some(
        (r) => r.message === 'VIP delivery tick failed' && r.level === 'error',
      ),
    ).toBe(true);
  });

  it('counts realtime sockets and refusals per surface', async () => {
    const staff = new RealtimeTestClient(`${url}/api/v1/realtime`);
    sockets.push(staff);
    await staff.authenticate('STAFF', staffToken);
    expect(await value('realtime_connections', { surface: 'staff' })).toBe(1);
    const failures = await value('realtime_rejects_total', {
      reason: 'auth_failed',
    });
    const bad = new RealtimeTestClient(`${url}/api/v1/realtime`);
    sockets.push(bad);
    await bad.authenticate('PLAYER', 'not-a-token');
    expect(
      await value('realtime_rejects_total', { reason: 'auth_failed' }),
    ).toBe(failures + 1);
    await staff.close();
    await eventually(
      async () =>
        (await value('realtime_connections', { surface: 'staff' })) === 0,
    );
  });

  it('never exposes identifiers as labels nor secrets in metrics or logs', async () => {
    const text = await scrape();
    expect(ids.length).toBeGreaterThan(5);
    for (const id of ids) expect(text).not.toContain(id);
    expect(text).not.toMatch(/username|player_id|staff_id|game_server_id|ip="/);
    const logs = JSON.stringify(records);
    for (const secret of secrets) {
      expect(text).not.toContain(secret);
      expect(logs).not.toContain(secret);
    }
    expect(
      records.every(
        (r) => typeof r.time === 'string' && typeof r.level === 'string',
      ),
    ).toBe(true);
  });
});
