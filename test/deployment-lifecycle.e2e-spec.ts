import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { DataSource } from 'typeorm';
import type { DataSourceOptions } from 'typeorm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { compiledDatabaseArtifacts } from './compiled-database.js';
import { loadEnvironment } from '../src/config/environment.js';
import { createDatabaseOptions } from '../src/database/database.options.js';
import { setupApp } from '../src/setup-app.js';
import { AppExpressAdapter } from '../src/common/http/app-express.adapter.js';
import { PasswordService } from '../src/auth/password.service.js';
import { GameServerService } from '../src/game-bridge/game-server.service.js';
import { LifecycleService } from '../src/lifecycle/lifecycle.service.js';
import { gracefulShutdown } from '../src/lifecycle/graceful-shutdown.js';
import { InstanceLockHeldError } from '../src/lifecycle/instance-lock.js';
import { runMigrations } from '../src/ops/migration-runner.js';
import { databaseFindings } from '../src/ops/preflight.checks.js';
import { FakeAgent } from './support/fake-agent.js';
import { RealtimeTestClient } from './support/realtime-client.js';

// Single-instance lock and graceful shutdown with real PostgreSQL (12.2).
const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;
const ENV = {
  SINGLE_INSTANCE_LOCK_ENABLED: 'true',
  GAME_COMMAND_WORKER_INTERVAL_MS: '100',
  GAME_COMMAND_PENDING_TIMEOUT_MS: '60000',
  SERVER_CONTROL_WORKER_INTERVAL_MS: '100',
  SERVER_CONTROL_PENDING_TIMEOUT_MS: '60000',
  SERVER_CONTROL_DELIVERY_WINDOW_MS: '2000',
  SERVER_CONTROL_RESULT_TIMEOUT_MS: '4000',
};
const CONTROL_CAPS = ['SERVER_CONTROL_V1', 'SERVER_START'];
const QUERY_CAPS = ['GAME_COMMAND_V1', 'CHARACTER_INVENTORY_QUERY'];
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

describeDatabase('Single-instance lock and graceful shutdown (12.2)', () => {
  let admin: DataSource, options: DataSourceOptions;
  let overrides: Partial<DataSourceOptions>;
  const schema = `deploy_life_test_${randomUUID().replaceAll('-', '')}`;
  const password = 'Deployment-Lifecycle-Password-42';
  type Instance = { app: INestApplication<App>; db: DataSource; url: string };
  const running: Instance[] = [];
  const agents: FakeAgent[] = [];
  const sockets: RealtimeTestClient[] = [];

  const boot = async (): Promise<Instance> => {
    const db = new DataSource({
      ...options,
      ...overrides,
      extra: {
        ...(options as { extra?: object }).extra,
        options: `-c search_path=${schema},public`,
      },
    } as DataSourceOptions);
    await db.initialize();
    const { AppModule } = await import('../src/app.module.js');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DataSource)
      .useValue(db)
      .compile();
    const app = module.createNestApplication(new AppExpressAdapter());
    app.useLogger(false);
    setupApp(app);
    try {
      await app.listen(0, '127.0.0.1');
    } catch (error) {
      await app.close().catch(() => undefined);
      if (db.isInitialized) await db.destroy();
      throw error;
    }
    const address = (
      app.getHttpServer() as unknown as Server
    ).address() as AddressInfo;
    const instance = {
      app: app as INestApplication<App>,
      db,
      url: `ws://127.0.0.1:${address.port}`,
    };
    running.push(instance);
    return instance;
  };
  const stop = async (instance: Instance) => {
    expect(
      await gracefulShutdown(instance.app, 10000, 'TEST', () => {
        throw new Error('graceful shutdown timed out');
      }),
    ).toBe(true);
    running.splice(running.indexOf(instance), 1);
    if (instance.db.isInitialized) await instance.db.destroy();
  };
  const http = (instance: Instance) => request(instance.app.getHttpServer());
  const staffToken = async (instance: Instance) =>
    (
      await http(instance)
        .post('/api/v1/auth/login')
        .send({ username: 'coordinator', password })
        .expect(200)
    ).body.accessToken as string;

  beforeAll(async () => {
    Object.assign(process.env, ENV);
    options = createDatabaseOptions(loadEnvironment());
    if (options.type !== 'postgres') throw new Error('PostgreSQL required');
    admin = new DataSource(options);
    await admin.initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    overrides = {
      schema,
      ...(await compiledDatabaseArtifacts()),
      extra: { options: `-c search_path=${schema},public` },
    } as Partial<DataSourceOptions>;
    expect(await runMigrations(loadEnvironment(), overrides)).toHaveLength(27);
    await admin.query(
      `INSERT INTO "${schema}".staff_users(username, display_name, password_hash, role_name) VALUES ('coordinator', 'C', $1, 'COORDINATOR')`,
      [await new PasswordService().hash(password)],
    );
  }, 60000);
  afterEach(async () => {
    for (const s of sockets.splice(0)) if (!s.closed) await s.close();
    for (const a of agents.splice(0)) await a.close();
  });
  afterAll(async () => {
    for (const instance of running.splice(0)) {
      await instance.app.close().catch(() => undefined);
      if (instance.db.isInitialized) await instance.db.destroy();
    }
    for (const name of Object.keys(ENV)) delete process.env[name];
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  it('refuses a second instance and any migration while one runs, and lets the next start after it stops', async () => {
    const a = await boot();
    await http(a).get('/api/v1/ready').expect(200);
    const findings = await databaseFindings(
      loadEnvironment(),
      { requireCurrent: true },
      overrides,
    );
    expect(findings.find((f) => f.check === 'instance_lock')?.detail).toMatch(
      /^held/,
    );
    await expect(boot()).rejects.toThrow(InstanceLockHeldError);
    await expect(boot()).rejects.toThrow(
      /single-instance lock.*not supported before Stage 12\.5/,
    );
    await expect(runMigrations(loadEnvironment(), overrides)).rejects.toThrow(
      InstanceLockHeldError,
    );
    // A still serves normally.
    await http(a).get('/api/v1/ready').expect(200);
    await stop(a);
    const b = await boot();
    await http(b).get('/api/v1/ready').expect(200);
    await stop(b);
    // Free again: the migration runner may take the lock.
    expect(await runMigrations(loadEnvironment(), overrides)).toEqual([]);
  });

  it('shuts down gracefully: readiness first, SHUTDOWN sockets, lock released; guarantees kept on the next instance', async () => {
    const a = await boot();
    const token = await staffToken(a);
    const server = await a.app
      .get(GameServerService)
      .register({ code: randomUUID(), name: 'Recreate' });
    const key = (
      await http(a)
        .post(`/api/v1/admin/game-servers/${server.id}/agent-credentials`)
        .auth(token, { type: 'bearer' })
        .expect(201)
    ).body as { credentialId: string; credentialSecret: string };
    const agent = new FakeAgent(a.url, server.id);
    agents.push(agent);
    await agent.hello(key, CONTROL_CAPS, {
      gameProcessState: 'STOPPED',
      skseReady: false,
    });
    const staff = new RealtimeTestClient(`${a.url}/api/v1/realtime`);
    sockets.push(staff);
    expect(await staff.authenticate('STAFF', token)).toMatchObject({
      type: 'AUTHENTICATED',
    });
    // Server Control crosses its delivery boundary; no result is reported.
    const operationId = (
      await http(a)
        .post(`/api/v1/game-servers/${server.id}/control/start`)
        .auth(token, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .expect(202)
    ).body.operationId as string;
    agent.perform(await agent.control(operationId), undefined, false);
    const status = async (instance: Instance) =>
      (
        await instance.db.query(
          'SELECT status FROM server_control_operations WHERE id = $1',
          [operationId],
        )
      )[0].status as string;
    await eventually(async () => (await status(a)) === 'DISPATCHED');
    // A GameCommand this Agent cannot run stays PENDING in PostgreSQL.
    const commandId = (
      await http(a)
        .post(
          `/api/v1/game-servers/${server.id}/characters/opaque:c/inventory/query`,
        )
        .auth(token, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({})
        .expect(202)
    ).body.commandId as string;
    // Graceful shutdown: readiness goes first.
    a.app.get(LifecycleService).beginShutdown();
    expect(
      (await http(a).get('/api/v1/ready').expect(503)).body.checks,
    ).toMatchObject({ shuttingDown: true });
    await stop(a);
    expect(await agent.client.closedWith()).toEqual({
      code: 1001,
      reason: 'SHUTDOWN',
    });
    expect(await staff.closedWith()).toEqual({
      code: 1001,
      reason: 'SHUTDOWN',
    });
    const [connection] = await admin.query(
      `SELECT status, disconnect_reason FROM "${schema}".game_connections WHERE id = $1`,
      [agent.connectionId],
    );
    expect(connection).toEqual({
      status: 'DISCONNECTED',
      disconnect_reason: 'SHUTDOWN',
    });
    expect(
      (
        await admin.query(
          `SELECT status FROM "${schema}".game_commands WHERE id = $1`,
          [commandId],
        )
      )[0].status,
    ).toBe('PENDING');
    // The lock was released: the next instance (recreate) starts.
    const b = await boot();
    await http(b).get('/api/v1/ready').expect(200);
    const resumed = new FakeAgent(
      b.url,
      server.id,
      agent.journal,
      agent.executions,
      agent.operations,
      agent.performed,
    );
    agents.push(resumed);
    await resumed.hello(key, [...CONTROL_CAPS, ...QUERY_CAPS]);
    // At-least-once: the PENDING command is delivered by the new process.
    const sent = await resumed.command(commandId);
    expect(sent.payload).toMatchObject({ commandId, attempt: 1 });
    // At-most-once: the claimed operation is never resent; it ends UNCERTAIN.
    await eventually(async () => (await status(b)) === 'UNCERTAIN');
    expect(resumed.controls()).toEqual([]);
    expect(agent.performed.get(operationId)).toBe(1);
    await stop(b);
  });
});
