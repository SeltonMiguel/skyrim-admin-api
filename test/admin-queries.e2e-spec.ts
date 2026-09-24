import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { loadEnvironment } from '../src/config/environment.js';
import type { ApplicationConfig } from '../src/config/environment.js';
import { createDatabaseOptions } from '../src/database/database.options.js';
import { compiledDatabaseArtifacts } from './compiled-database.js';
import { setupApp } from '../src/setup-app.js';
import { AppExpressAdapter } from '../src/common/http/app-express.adapter.js';
import { PasswordService } from '../src/auth/password.service.js';
import { BridgeClock } from '../src/game-bridge/bridge-clock.js';
import { GameServer } from '../src/game-bridge/entities/game-server.entity.js';
import { GameConnection } from '../src/game-bridge/entities/game-connection.entity.js';
import { GameCommand } from '../src/game-bridge/entities/game-command.entity.js';
import { GameCommandResult } from '../src/game-bridge/entities/game-command-result.entity.js';
import {
  CommandStatus as S,
  isTerminal,
} from '../src/game-bridge/command-state.js';
import { RoleName as R } from '../src/rbac/roles.js';
import { Permission as P } from '../src/rbac/permissions.js';
import { ROLE_PERMISSIONS } from '../src/rbac/role-permissions.js';

const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;
describeDatabase('Admin read APIs with real PostgreSQL', () => {
  let admin: DataSource, database: DataSource, app: INestApplication<App>;
  const schema = `queries_test_${randomUUID().replaceAll('-', '')}`;
  const now = new Date('2026-09-20T12:00:00Z');
  const tokens = new Map<R, string>();
  const staffIds = new Map<R, string>();
  const http = () => request(app.getHttpServer());
  const get = (path: string, role = R.SUPPORT) =>
    http().get(`/api/v1${path}`).auth(tokens.get(role)!, { type: 'bearer' });
  const servers = () => database.getRepository<GameServer>('GameServer');
  const connections = () =>
    database.getRepository<GameConnection>('GameConnection');
  const commands = () => database.getRepository<GameCommand>('GameCommand');
  const server = (enabled = true, name = 'Server') =>
    servers().save(
      servers().create({ id: randomUUID(), code: randomUUID(), name, enabled }),
    );
  const connection = (
    gameServerId: string,
    overrides: Partial<GameConnection> = {},
  ) =>
    connections().save(
      connections().create({
        id: randomUUID(),
        gameServerId,
        externalConnectionId: randomUUID(),
        status: 'CONNECTED',
        bridgeVersion: 'test',
        protocolVersion: '1',
        connectedAt: now,
        lastHeartbeatAt: now,
        disconnectedAt: null,
        disconnectReason: null,
        createdAt: now,
        ...overrides,
      }),
    );
  const command = (
    gameServerId: string,
    status = S.PENDING,
    overrides: Partial<GameCommand> = {},
  ) =>
    commands().save(
      commands().create({
        id: randomUUID(),
        gameServerId,
        type: 'BRIDGE_PING',
        status,
        payload: { nonce: 'ping' },
        idempotencyKey: randomUUID(),
        correlationId: randomUUID(),
        requestId: 'query-fixture',
        requestedByStaffId: staffIds.get(R.SUPPORT),
        dispatchAttempts: 1,
        lastDispatchAt: now,
        ackDeadlineAt: new Date(now.getTime() + 5000),
        executionDeadlineAt: new Date(now.getTime() + 30000),
        acknowledgedAt: null,
        completedAt: isTerminal(status) ? now : null,
        createdAt: now,
        dispatchLeaseId: null,
        dispatchLeaseExpiresAt: null,
        ...overrides,
      }),
    );
  beforeAll(async () => {
    const config = loadEnvironment();
    const options = createDatabaseOptions(config);
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
    expect(await database.runMigrations()).toHaveLength(11);
    expect(await database.runMigrations()).toHaveLength(0);
    // Roll back only this stage and prove previous permission data survives.
    await database.undoLastMigration(); // Etapa 10.2 Generic Actor
    await database.undoLastMigration(); // Etapa 10.1 Player Accounts
    await database.undoLastMigration(); // Etapa 09 Server Control
    await database.undoLastMigration(); // Etapa 08 VIP Store
    await database.undoLastMigration(); // Etapa 07 World permission grants
    await database.undoLastMigration(); // Etapa 05 result size constraint
    await database.undoLastMigration();
    expect(await database.query('SELECT * FROM permissions')).toHaveLength(29);
    expect(await database.query('SELECT * FROM role_permissions')).toHaveLength(
      71,
    );
    expect(
      await database.query(
        "SELECT * FROM permissions WHERE name IN ('DASHBOARD_READ', 'GAME_BRIDGE_READ')",
      ),
    ).toEqual([]);
    expect(await database.runMigrations()).toHaveLength(7);
    expect(await database.runMigrations()).toHaveLength(0);
    const { AppModule } = await import('../src/app.module.js');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DataSource)
      .useValue(database)
      .overrideProvider(BridgeClock)
      .useValue({ now: () => now })
      .overrideProvider(ConfigService)
      .useValue(
        new ConfigService({
          application: {
            ...config,
            gameBridge: { ...config.gameBridge, heartbeatTimeoutMs: 30000 },
          } satisfies ApplicationConfig,
        }),
      )
      .compile();
    app = module.createNestApplication(new AppExpressAdapter());
    app.useLogger(false);
    setupApp(app);
    await app.listen(0, '127.0.0.1');
    const password = 'Queries-Test-Password-42';
    const hash = await new PasswordService().hash(password);
    for (const role of Object.values(R)) {
      const id = randomUUID();
      await database.query(
        'INSERT INTO staff_users(id, username, display_name, password_hash, role_name) VALUES ($1,$2,$3,$4,$5)',
        [id, role.toLowerCase(), role, hash, role],
      );
      staffIds.set(role, id);
      const { body } = await http()
        .post('/api/v1/auth/login')
        .send({ username: role.toLowerCase(), password })
        .expect(200);
      tokens.set(role, body.accessToken);
    }
  }, 30000);
  beforeEach(async () => {
    // All fixture mutations stay in this suite's fresh UUID schema.
    await database.query('DELETE FROM game_command_results');
    await database.query('DELETE FROM game_commands');
    await database.query('DELETE FROM game_connections');
    await database.query('DELETE FROM game_servers');
  });
  afterAll(async () => {
    await app?.close();
    if (database?.isInitialized) await database.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });
  it('applies the incremental migration, leaves no pending migration and matches entity metadata', async () => {
    expect(database.options.synchronize).toBe(false);
    expect(await database.showMigrations()).toBe(false);
    expect(
      (await database.driver.createSchemaBuilder().log()).upQueries,
    ).toEqual([]);
    expect(await database.query('SELECT * FROM migrations')).toHaveLength(11);
    expect(await database.query('SELECT * FROM permissions')).toHaveLength(36);
  });
  it.each(Object.values(R))(
    'persists both explicit read grants and permits all six GET APIs for %s',
    async (role) => {
      const rows: { permission_name: P }[] = await database.query(
        'SELECT permission_name FROM role_permissions WHERE role_name = $1',
        [role],
      );
      expect(rows.map((r) => r.permission_name).sort()).toEqual(
        [...ROLE_PERMISSIONS[role]].sort(),
      );
      const s = await server();
      const c = await command(s.id);
      for (const path of [
        '/dashboard',
        '/game-servers',
        `/game-servers/${s.id}`,
        `/game-servers/${s.id}/connections`,
        `/game-servers/${s.id}/commands`,
        `/game-commands/${c.id}`,
      ])
        await get(path, role).expect(200);
    },
  );
  it.each([
    '/dashboard',
    '/game-servers',
    `/game-servers/${randomUUID()}`,
    `/game-servers/${randomUUID()}/connections`,
    `/game-servers/${randomUUID()}/commands`,
    `/game-commands/${randomUUID()}`,
  ])('rejects anonymous GET %s', async (path) => {
    await http().get(`/api/v1${path}`).expect(401);
  });
  it('enforces live permission grants independently and does not grant Audit access', async () => {
    const s = await server();
    const c = await command(s.id);
    for (const role of [R.SUPPORT, R.DEV])
      await get('/audit', role).expect(403);
    await database.query(
      "DELETE FROM role_permissions WHERE role_name = 'SUPPORT' AND permission_name = 'DASHBOARD_READ'",
    );
    try {
      await get('/dashboard').expect(403);
      await get('/game-servers').expect(200);
    } finally {
      await database.query(
        "INSERT INTO role_permissions VALUES ('SUPPORT', 'DASHBOARD_READ')",
      );
    }
    await database.query(
      "DELETE FROM role_permissions WHERE role_name = 'SUPPORT' AND permission_name = 'GAME_BRIDGE_READ'",
    );
    try {
      for (const path of [
        '/game-servers',
        `/game-servers/${s.id}`,
        `/game-servers/${s.id}/connections`,
        `/game-servers/${s.id}/commands`,
        `/game-commands/${c.id}`,
      ])
        await get(path).expect(403);
      await get('/dashboard').expect(200);
    } finally {
      await database.query(
        "INSERT INTO role_permissions VALUES ('SUPPORT', 'GAME_BRIDGE_READ')",
      );
    }
  });
  it('returns an empty dashboard and rejects a custom window or ordering', async () => {
    const { body } = await get('/dashboard').expect(200);
    expect(body).toEqual({
      generatedAt: now.toISOString(),
      servers: {
        total: 0,
        enabled: 0,
        disabled: 0,
        online: 0,
        stale: 0,
        offline: 0,
      },
      commands: {
        windowHours: 24,
        total: 0,
        byStatus: {
          PENDING: 0,
          DISPATCHED: 0,
          ACKNOWLEDGED: 0,
          SUCCEEDED: 0,
          FAILED: 0,
          TIMEOUT: 0,
        },
        attentionRequired: 0,
      },
    });
    await get('/dashboard').query({ windowHours: 48 }).expect(400);
    await get('/dashboard').query({ order: 'status' }).expect(400);
  });
  it('counts all server health categories with disabled precedence and exact heartbeat boundary', async () => {
    const online = await server();
    await connection(online.id, {
      lastHeartbeatAt: new Date(now.getTime() - 29999),
    });
    const stale = await server();
    await connection(stale.id, {
      lastHeartbeatAt: new Date(now.getTime() - 30000),
    });
    const offline = await server();
    const disabled = await server(false);
    await connection(disabled.id);
    expect((await get('/dashboard').expect(200)).body.servers).toEqual({
      total: 4,
      enabled: 3,
      disabled: 1,
      online: 1,
      stale: 1,
      offline: 1,
    });
    for (const [s, health] of [
      [online, 'ONLINE'],
      [stale, 'STALE'],
      [offline, 'OFFLINE'],
      [disabled, 'DISABLED'],
    ] as const) {
      const { body } = await get(`/game-servers/${s.id}`).expect(200);
      expect(body.health).toBe(health);
      const filtered = await get('/game-servers').query({ health }).expect(200);
      expect(
        filtered.body.items.map((item: { id: string }) => item.id),
      ).toEqual([s.id]);
    }
  });
  it('counts commands by status in the inclusive 24-hour creation window only', async () => {
    const s = await server();
    for (const status of Object.values(S)) await command(s.id, status);
    await command(s.id, S.FAILED, {
      createdAt: new Date(now.getTime() - 86400000),
    });
    await command(s.id, S.TIMEOUT, {
      createdAt: new Date(now.getTime() - 86400001),
    });
    await command(s.id, S.FAILED, { createdAt: new Date(now.getTime() + 1) });
    expect((await get('/dashboard').expect(200)).body.commands).toEqual({
      windowHours: 24,
      total: 7,
      byStatus: {
        PENDING: 1,
        DISPATCHED: 1,
        ACKNOWLEDGED: 1,
        SUCCEEDED: 1,
        FAILED: 2,
        TIMEOUT: 1,
      },
      attentionRequired: 3,
    });
  });
  it('lists servers deterministically, paginates, and filters exact code and enabled', async () => {
    const a = await server(true, 'A');
    const b = await server(false, 'B');
    const c = await server(true, 'A');
    const expected = [a.id, c.id].sort();
    const { body } = await get('/game-servers')
      .query({ page: 2, limit: 1 })
      .expect(200);
    expect(body).toMatchObject({ total: 3, page: 2, limit: 1, totalPages: 3 });
    expect(body.items.map((item: { id: string }) => item.id)).toEqual([
      expected[1],
    ]);
    expect(
      (
        await get('/game-servers').query({ enabled: false }).expect(200)
      ).body.items.map((item: { id: string }) => item.id),
    ).toEqual([b.id]);
    expect(
      (await get('/game-servers').query({ enabled: true }).expect(200)).body
        .total,
    ).toBe(2);
    expect(
      (await get('/game-servers').query({ code: a.code }).expect(200)).body
        .items[0].id,
    ).toBe(a.id);
    expect(
      (await get('/game-servers').query({ code: 'absent' }).expect(200)).body,
    ).toMatchObject({ items: [], total: 0, totalPages: 0 });
  });
  it('shows only the current connection on detail and null when offline', async () => {
    const s = await server();
    expect(
      (await get(`/game-servers/${s.id}`).expect(200)).body.currentConnection,
    ).toBeNull();
    await connection(s.id, {
      status: 'DISCONNECTED',
      disconnectedAt: now,
      disconnectReason: 'SUPERSEDED',
    });
    const active = await connection(s.id);
    const { body } = await get(`/game-servers/${s.id}`).expect(200);
    expect(body.currentConnection).toEqual({
      id: active.id,
      externalConnectionId: active.externalConnectionId,
      status: 'CONNECTED',
      bridgeVersion: 'test',
      protocolVersion: '1',
      connectedAt: now.toISOString(),
      lastHeartbeatAt: now.toISOString(),
    });
  });
  it.each([
    '/game-servers/bad',
    '/game-servers/bad/connections',
    '/game-servers/bad/commands',
    '/game-commands/bad',
  ])('rejects malformed UUID before PostgreSQL for %s', async (path) => {
    await get(path).expect(400);
  });
  it.each([
    `/game-servers/${randomUUID()}`,
    `/game-servers/${randomUUID()}/connections`,
    `/game-servers/${randomUUID()}/commands`,
    `/game-commands/${randomUUID()}`,
  ])('returns 404 for missing resource %s', async (path) => {
    await get(path).expect(404);
  });
  it('returns empty history pages for existing servers', async () => {
    const s = await server();
    for (const kind of ['connections', 'commands'])
      expect(
        (await get(`/game-servers/${s.id}/${kind}`).expect(200)).body,
      ).toEqual({ items: [], total: 0, page: 1, limit: 20, totalPages: 0 });
  });
  it('paginates connection history and filters status and connectedAt inclusively', async () => {
    const s = await server();
    const other = await server();
    const first = await connection(s.id, {
      connectedAt: new Date(now.getTime() - 1000),
      status: 'DISCONNECTED',
      disconnectedAt: now,
      disconnectReason: 'SUPERSEDED',
    });
    const second = await connection(s.id, {
      status: 'DISCONNECTED',
      disconnectedAt: now,
      disconnectReason: 'REQUESTED',
    });
    const third = await connection(s.id);
    await connection(other.id);
    const ordered = [second.id, third.id].sort().reverse().concat(first.id);
    const { body } = await get(`/game-servers/${s.id}/connections`)
      .query({ page: 2, limit: 2 })
      .expect(200);
    expect(body).toMatchObject({ total: 3, totalPages: 2, page: 2, limit: 2 });
    expect(body.items.map((item: { id: string }) => item.id)).toEqual(
      ordered.slice(2),
    );
    expect(
      (
        await get(`/game-servers/${s.id}/connections`)
          .query({ status: 'CONNECTED' })
          .expect(200)
      ).body.items[0].id,
    ).toBe(third.id);
    expect(
      (
        await get(`/game-servers/${s.id}/connections`)
          .query({ status: 'DISCONNECTED' })
          .expect(200)
      ).body.total,
    ).toBe(2);
    const filtered = await get(`/game-servers/${s.id}/connections`)
      .query({ from: now.toISOString(), to: now.toISOString() })
      .expect(200);
    expect(filtered.body.items.map((item: { id: string }) => item.id)).toEqual(
      ordered.slice(0, 2),
    );
  });
  it('lists command summaries in deterministic pages without payload, result or coordination data', async () => {
    const s = await server();
    const other = await server();
    const a = await command(s.id);
    const b = await command(s.id, S.FAILED);
    await command(other.id);
    const expected = [a.id, b.id].sort().reverse();
    for (let page = 1; page <= 2; page++) {
      const { body, text } = await get(`/game-servers/${s.id}/commands`)
        .query({ page, limit: 1 })
        .expect(200);
      expect(body).toMatchObject({ total: 2, totalPages: 2, page, limit: 1 });
      expect(body.items.map((item: { id: string }) => item.id)).toEqual([
        expected[page - 1],
      ]);
      expect(text).not.toMatch(
        /payload|result|dispatchLease|idempotencyKey|passwordHash|refreshTokenHash/,
      );
    }
  });
  it.each([
    'status',
    'type',
    'requestedByStaffId',
    'requestId',
    'correlationId',
  ] as const)('filters command %s with bound equality', async (filter) => {
    const s = await server();
    const target = await command(s.id, S.FAILED);
    await command(s.id, S.PENDING, {
      requestedByStaffId: staffIds.get(R.DEV),
      requestId: 'other',
    });
    const value = target[filter];
    const { body } = await get(`/game-servers/${s.id}/commands`)
      .query({ [filter]: value })
      .expect(200);
    expect(body.total).toBe(filter === 'type' ? 2 : 1);
    for (const item of body.items) expect(item[filter]).toBe(value);
  });
  it('filters command creation dates inclusively and combines filters', async () => {
    const s = await server();
    const target = await command(s.id, S.FAILED);
    await command(s.id, S.PENDING);
    await command(s.id, S.FAILED, { createdAt: new Date(now.getTime() - 1) });
    const { body } = await get(`/game-servers/${s.id}/commands`)
      .query({
        from: now.toISOString(),
        to: now.toISOString(),
        status: S.FAILED,
        requestId: target.requestId,
      })
      .expect(200);
    expect(body.items.map((item: { id: string }) => item.id)).toEqual([
      target.id,
    ]);
  });
  it('presents operational command detail without payload/result body, leases or idempotency', async () => {
    const s = await server();
    const c = await command(s.id, S.PENDING, {
      dispatchLeaseId: randomUUID(),
      dispatchLeaseExpiresAt: new Date(now.getTime() + 2000),
    });
    const pending = await get(`/game-commands/${c.id}`).expect(200);
    expect(pending.body).toMatchObject({
      result: null,
    });
    expect(pending.text).not.toContain(c.dispatchLeaseId!);
    expect(pending.text).not.toContain(c.idempotencyKey);
    expect(pending.text).not.toMatch(
      /payload|dispatchLease|idempotencyKey|passwordHash|refreshTokenHash/,
    );
    await commands().update(c.id, {
      status: S.SUCCEEDED,
      completedAt: now,
      dispatchLeaseId: null,
      dispatchLeaseExpiresAt: null,
    });
    await database
      .getRepository<GameCommandResult>('GameCommandResult')
      .insert({
        gameCommandId: c.id,
        outcome: S.SUCCEEDED,
        result: { nonce: 'ping' },
        errorCode: null,
        errorMessage: null,
        receivedAt: now,
      });
    const { body } = await get(`/game-commands/${c.id}`).expect(200);
    expect(body).toMatchObject({
      id: c.id,
      status: S.SUCCEEDED,
      ackDeadlineAt: c.ackDeadlineAt?.toISOString(),
      executionDeadlineAt: c.executionDeadlineAt?.toISOString(),
      result: {
        outcome: S.SUCCEEDED,
        errorCode: null,
        receivedAt: now.toISOString(),
      },
    });
  });
  it('presents a failure result with null result JSON', async () => {
    const s = await server();
    const c = await command(s.id, S.FAILED);
    await database
      .getRepository<GameCommandResult>('GameCommandResult')
      .insert({
        gameCommandId: c.id,
        outcome: S.FAILED,
        result: null,
        errorCode: 'BRIDGE_ERROR',
        errorMessage: 'Bridge reported failure',
        receivedAt: now,
      });
    expect(
      (await get(`/game-commands/${c.id}`).expect(200)).body.result,
    ).toEqual({
      outcome: S.FAILED,
      errorCode: 'BRIDGE_ERROR',
      receivedAt: now.toISOString(),
    });
  });
  it.each([
    { limit: 101 },
    { limit: 0 },
    { page: 0 },
    { limit: 1.5 },
    { page: 'bad' },
    { status: 'UNKNOWN' },
    { type: 'EXECUTE' },
    { requestedByStaffId: 'invalid' },
    { correlationId: 'invalid' },
    { requestId: "' OR true" },
    { from: '2026-02-30T00:00:00Z' },
    { to: 'bad' },
    { from: '2026-09-20T12:00:00' },
    { from: '2026-09-21T00:00:00Z', to: now.toISOString() },
    { order: 'payload' },
    { payload: '{"nonce":"execute"}' },
  ])('rejects invalid command query %j', async (query) => {
    const s = await server();
    await get(`/game-servers/${s.id}/commands`).query(query).expect(400);
  });
  it.each([
    { status: 'STALE' },
    { limit: 101 },
    { from: 'bad' },
    { from: '2026-09-21T00:00:00Z', to: now.toISOString() },
  ])('rejects invalid connection query %j', async (query) => {
    const s = await server();
    await get(`/game-servers/${s.id}/connections`).query(query).expect(400);
  });
  it.each([
    { health: 'UNKNOWN' },
    { enabled: '0' },
    { enabled: 'falsee' },
    { limit: 101 },
    { order: 'name DESC; DROP TABLE' },
  ])('rejects invalid server query %j', async (query) => {
    await get('/game-servers').query(query).expect(400);
  });
  it('accepts maximum page size', async () => {
    const s = await server();
    for (const path of [
      '/game-servers',
      `/game-servers/${s.id}/connections`,
      `/game-servers/${s.id}/commands`,
    ])
      await get(path).query({ limit: 100 }).expect(200);
  });
  it('does not mutate stale connections, overdue commands, leases or audit logs during queries', async () => {
    const s = await server();
    await connection(s.id, {
      lastHeartbeatAt: new Date(now.getTime() - 30000),
    });
    const c = await command(s.id, S.PENDING, {
      dispatchLeaseId: randomUUID(),
      dispatchLeaseExpiresAt: new Date(now.getTime() - 1000),
      executionDeadlineAt: new Date(now.getTime() - 1000),
    });
    const snapshot = async () =>
      Promise.all([
        database.query('SELECT * FROM game_servers ORDER BY id'),
        database.query('SELECT * FROM game_connections ORDER BY id'),
        database.query('SELECT * FROM game_commands ORDER BY id'),
        database.query('SELECT * FROM game_command_results ORDER BY id'),
        database.query('SELECT * FROM audit_logs ORDER BY id'),
      ]);
    const before = await snapshot();
    for (const path of [
      '/dashboard',
      '/game-servers',
      `/game-servers/${s.id}`,
      `/game-servers/${s.id}/connections`,
      `/game-servers/${s.id}/commands`,
      `/game-commands/${c.id}`,
    ]) {
      const response = await get(path)
        .set('x-request-id', 'readonly-check')
        .expect(200);
      expect(response.headers['x-request-id']).toBe('readonly-check');
      expect(response.text).not.toMatch(
        /passwordHash|refreshTokenHash|accessToken|refreshToken|dispatchLease|idempotencyKey/,
      );
    }
    expect(await snapshot()).toEqual(before);
  });
  it.each(['post', 'patch', 'put', 'delete'] as const)(
    'exposes no %s mutation on any read API or generic execution endpoint',
    async (method) => {
      const s = await server();
      const c = await command(s.id);
      for (const path of [
        '/dashboard',
        '/game-servers',
        `/game-servers/${s.id}`,
        `/game-servers/${s.id}/connections`,
        `/game-servers/${s.id}/commands`,
        `/game-commands/${c.id}`,
        '/game-commands',
        '/command',
        '/execute',
        '/console',
        '/game-command',
      ])
        await http()
          [method](`/api/v1${path}`)
          .auth(tokens.get(R.COORDINATOR)!, { type: 'bearer' })
          .send({ payload: { nonce: 'never-executed' } })
          .expect(404);
      expect(await commands().count()).toBe(1);
    },
  );
  it('documents six read APIs, filters, response DTOs, permissions and errors without internal fields', async () => {
    const { body } = await http().get('/docs-json').expect(200);
    for (const path of [
      '/dashboard',
      '/game-servers',
      '/game-servers/{id}',
      '/game-servers/{id}/connections',
      '/game-servers/{id}/commands',
      '/game-commands/{id}',
    ]) {
      const route = body.paths[`/api/v1${path}`];
      expect(Object.keys(route)).toEqual(['get']);
      expect(route.get.security).toEqual([{ bearer: [] }]);
      for (const status of ['200', '400', '401', '403'])
        expect(route.get.responses).toHaveProperty(status);
      if (path.includes('{id}'))
        expect(route.get.responses).toHaveProperty('404');
    }
    const names = body.paths[
      '/api/v1/game-servers/{id}/commands'
    ].get.parameters.map((p: { name: string }) => p.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'id',
        'page',
        'limit',
        'status',
        'type',
        'requestId',
        'correlationId',
        'requestedByStaffId',
        'from',
        'to',
      ]),
    );
    expect(
      body.components.schemas.CommandListDto.properties,
    ).not.toHaveProperty('payload');
    expect(
      body.components.schemas.CommandDetailDto.properties,
    ).not.toHaveProperty('payload');
    expect(body.components.schemas.CommandDetailDto.properties).toHaveProperty(
      'result',
    );
    expect(JSON.stringify(body)).not.toMatch(
      /dispatchLease|idempotencyKey|passwordHash|refreshTokenHash/,
    );
  });
});
