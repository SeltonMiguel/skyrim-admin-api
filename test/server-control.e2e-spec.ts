import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { compiledDatabaseArtifacts } from './compiled-database.js';
import { loadEnvironment } from '../src/config/environment.js';
import { createDatabaseOptions } from '../src/database/database.options.js';
import { setupApp } from '../src/setup-app.js';
import { AppExpressAdapter } from '../src/common/http/app-express.adapter.js';
import { PasswordService } from '../src/auth/password.service.js';
import { RoleName as R } from '../src/rbac/roles.js';
import { GameServer } from '../src/game-bridge/entities/game-server.entity.js';
import { GameCommand } from '../src/game-bridge/entities/game-command.entity.js';
import { GameCommandBus } from '../src/game-bridge/game-command-bus.js';
import { GameServerService } from '../src/game-bridge/game-server.service.js';
import { GameGateway } from '../src/game-bridge/game-gateway.js';
import { ServerControlOperation } from '../src/server-control/entities/server-control-operation.entity.js';
import { ServerControlGateway } from '../src/server-control/server-control-gateway.js';
import { ServerControlDispatcher } from '../src/server-control/server-control-dispatcher.js';
import {
  SERVER_CONTROL_POLICY,
  SERVER_CONTROL_TYPES,
  ServerControlStatus as S,
} from '../src/server-control/server-control.contracts.js';
import type { ServerControlType } from '../src/server-control/server-control.contracts.js';
import { MockGameGateway } from './support/mock-game-gateway.js';
import { MockServerControlGateway } from './support/mock-server-control-gateway.js';

const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;
const AUTHORIZED = [R.COORDINATOR, R.DEV];
describeDatabase('Server Control with real PostgreSQL', () => {
  let admin: DataSource, database: DataSource, app: INestApplication<App>;
  let servers: GameServerService, dispatcher: ServerControlDispatcher;
  let server: GameServer;
  const gateway = new MockServerControlGateway();
  const gameGateway = new MockGameGateway();
  const schema = `server_control_test_${randomUUID().replaceAll('-', '')}`;
  const tokens = new Map<R, string>(),
    staffIds = new Map<R, string>();
  const http = () => request(app.getHttpServer());
  const path = (type: ServerControlType, serverId = server.id) =>
    `/api/v1/game-servers/${serverId}/control/${SERVER_CONTROL_POLICY[type].path}`;
  const post = (
    type: ServerControlType,
    key: string = randomUUID(),
    role = R.COORDINATOR,
    serverId = server.id,
  ) =>
    http()
      .post(path(type, serverId))
      .auth(tokens.get(role)!, { type: 'bearer' })
      .set('Idempotency-Key', key);
  const get = (id: string, role = R.COORDINATOR) =>
    http()
      .get(`/api/v1/server-control-operations/${id}`)
      .auth(tokens.get(role)!, { type: 'bearer' });
  const operations = () =>
    database.getRepository<ServerControlOperation>('ServerControlOperation');
  const read = (id: string) => operations().findOneByOrFail({ id });
  const count = () => operations().countBy({ gameServerId: server.id });
  const audits = (id: string) =>
    database.query(
      "SELECT * FROM audit_logs WHERE metadata->>'operationId' = $1",
      [id],
    );
  const setEnabled = (enabled: boolean) =>
    database
      .getRepository<GameServer>('GameServer')
      .update(server.id, { enabled });
  beforeAll(async () => {
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
    expect(await database.runMigrations()).toHaveLength(20);
    expect(await database.runMigrations()).toHaveLength(0);
    const { AppModule } = await import('../src/app.module.js');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DataSource)
      .useValue(database)
      .overrideProvider(ServerControlGateway)
      .useValue(gateway)
      .overrideProvider(GameGateway)
      .useValue(gameGateway)
      .compile();
    app = module.createNestApplication(new AppExpressAdapter());
    app.useLogger(false);
    setupApp(app);
    await app.listen(0, '127.0.0.1');
    servers = app.get(GameServerService);
    dispatcher = app.get(ServerControlDispatcher);
    const password = 'Server-Control-Test-Password-42';
    const hash = await new PasswordService().hash(password);
    for (const role of Object.values(R)) {
      const id = randomUUID();
      staffIds.set(role, id);
      await database.query(
        'INSERT INTO staff_users(id, username, display_name, password_hash, role_name) VALUES ($1,$2,$3,$4,$5)',
        [id, role.toLowerCase(), role, hash, role],
      );
      const { body } = await http()
        .post('/api/v1/auth/login')
        .send({ username: role.toLowerCase(), password })
        .expect(200);
      tokens.set(role, body.accessToken);
    }
  }, 30000);
  beforeEach(async () => {
    gateway.reset();
    gameGateway.sends = [];
    server = await servers.register({
      code: randomUUID(),
      name: 'Server control test',
    });
  });
  afterAll(async () => {
    await app?.close();
    if (database?.isInitialized) await database.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });
  it('adds only the operation table, reuses existing grants and has no schema diff', async () => {
    expect(database.options.synchronize).toBe(false);
    expect(await database.showMigrations()).toBe(false);
    expect(
      (await database.driver.createSchemaBuilder().log()).upQueries,
    ).toEqual([]);
    expect(await database.query('SELECT * FROM migrations')).toHaveLength(20);
    expect(await database.query('SELECT * FROM permissions')).toHaveLength(36);
    expect(await database.query('SELECT * FROM role_permissions')).toHaveLength(
      93,
    );
    expect(
      await database.query(
        "SELECT role_name, permission_name FROM role_permissions WHERE permission_name LIKE 'SERVER_%' ORDER BY role_name, permission_name",
      ),
    ).toEqual(
      ['COORDINATOR', 'DEV'].flatMap((role_name) =>
        ['SERVER_PAUSE', 'SERVER_RESTART', 'SERVER_START'].map(
          (permission_name) => ({ role_name, permission_name }),
        ),
      ),
    );
    const rows = await database.query(
      'SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename',
      [schema],
    );
    expect(rows.map((r: { tablename: string }) => r.tablename)).toEqual([
      'audit_logs',
      'character_professions',
      'economy_accounts',
      'economy_entries',
      'economy_transactions',
      'game_command_results',
      'game_commands',
      'game_connections',
      'game_servers',
      'migrations',
      'permissions',
      'player_character_link_challenges',
      'player_characters',
      'player_chat_direct_threads',
      'player_chat_messages',
      'player_chat_requests',
      'player_group_invites',
      'player_group_members',
      'player_groups',
      'player_guild_invites',
      'player_guild_members',
      'player_guilds',
      'player_identities',
      'player_marketplace_currency_escrows',
      'player_marketplace_custody_events',
      'player_marketplace_listings',
      'player_marketplace_purchases',
      'player_marketplace_requests',
      'player_marketplace_settlement_events',
      'player_sessions',
      'player_trade_currency_escrows',
      'player_trade_items',
      'player_trade_offers',
      'player_trade_requests',
      'player_trade_settlement_events',
      'player_trades',
      'players',
      'profession_experience_events',
      'role_permissions',
      'roles',
      'server_control_operations',
      'staff_sessions',
      'staff_users',
      'vip_offers',
    ]);
  });
  it.each(Object.values(R))(
    'enforces the explicit start/pause/restart and detail matrix for %s',
    async (role) => {
      const authorized = AUTHORIZED.includes(role);
      for (const type of SERVER_CONTROL_TYPES) {
        const response = await post(type, randomUUID(), role).expect(
          authorized ? 202 : 403,
        );
        const id = authorized
          ? response.body.operationId
          : (await post(type).expect(202)).body.operationId;
        await get(id, role).expect(authorized ? 200 : 403);
        if (authorized)
          expect((await read(id)).requestedByStaffId).toBe(staffIds.get(role));
        expect(await audits(id)).toHaveLength(1);
      }
      expect(await count()).toBe(3);
    },
  );
  it('rejects anonymous calls without persistence', async () => {
    for (const type of SERVER_CONTROL_TYPES)
      await http()
        .post(path(type))
        .set('Idempotency-Key', randomUUID())
        .expect(401);
    await http()
      .get(`/api/v1/server-control-operations/${randomUUID()}`)
      .expect(401);
    expect(await count()).toBe(0);
  });
  it.each(SERVER_CONTROL_TYPES)(
    'accepts %s with 202, Location, allowlisted body and atomic Audit, dispatching once after commit',
    async (type) => {
      const requestId = randomUUID(),
        key = `key-${randomUUID()}`;
      const { body, headers, text } = await post(type, key)
        .set('x-request-id', requestId)
        .expect(202);
      expect(headers.location).toBe(
        `/api/v1/server-control-operations/${body.operationId}`,
      );
      const operation = await read(body.operationId);
      expect(body).toEqual({
        operationId: operation.id,
        gameServerId: server.id,
        type,
        status: S.DISPATCHED,
        correlationId: operation.correlationId,
        requestId,
        createdAt: operation.createdAt.toISOString(),
      });
      expect(text).not.toContain(key);
      expect(text).not.toMatch(/idempotency|claim|lease|payload/i);
      expect(gateway.sends).toEqual([
        {
          operationId: operation.id,
          gameServerId: server.id,
          type,
          correlationId: operation.correlationId,
          requestedAt: operation.createdAt.toISOString(),
        },
      ]);
      const entries = await audits(operation.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        action: SERVER_CONTROL_POLICY[type].auditAction,
        outcome: 'SUCCESS',
        resource_type: 'SERVER_CONTROL',
        resource_id: operation.id,
        status_code: 202,
        actor_staff_id: staffIds.get(R.COORDINATOR),
        request_id: requestId,
      });
      expect(entries[0].metadata).toEqual({
        gameServerId: server.id,
        operationId: operation.id,
        correlationId: operation.correlationId,
        type,
      });
      expect(JSON.stringify(entries[0])).not.toContain(key);
      expect(JSON.stringify(entries[0].metadata)).not.toMatch(
        /idempotency|token|header|payload|secret|gateway/i,
      );
      // Gameplay pipeline untouched.
      expect(
        await database
          .getRepository<GameCommand>('GameCommand')
          .countBy({ gameServerId: server.id }),
      ).toBe(0);
      expect(gameGateway.sends).toHaveLength(0);
    },
  );
  it.each(SERVER_CONTROL_TYPES)(
    'deduplicates concurrent and repeated %s requests: one operation, one Audit, one dispatch',
    async (type) => {
      const key = randomUUID();
      const responses = await Promise.all(
        Array.from({ length: 8 }, () => post(type, key).expect(202)),
      );
      expect(new Set(responses.map((r) => r.body.operationId)).size).toBe(1);
      expect(new Set(responses.map((r) => r.body.correlationId)).size).toBe(1);
      const id = responses[0].body.operationId;
      expect(await count()).toBe(1);
      expect(await audits(id)).toHaveLength(1);
      expect(gateway.sends).toHaveLength(1);
      const replay = await post(type, key, R.DEV).expect(202);
      expect(replay.body).toMatchObject({
        operationId: id,
        correlationId: responses[0].body.correlationId,
        status: S.DISPATCHED,
      });
      expect(replay.headers.location).toBe(
        `/api/v1/server-control-operations/${id}`,
      );
      expect((await read(id)).requestedByStaffId).toBe(
        staffIds.get(R.COORDINATOR),
      );
      expect(await audits(id)).toHaveLength(1);
      expect(gateway.sends).toHaveLength(1);
    },
  );
  it('rejects a key reused for another operation, including concurrently, and scopes keys to the server', async () => {
    const key = randomUUID();
    const first = (await post('SERVER_START', key).expect(202)).body;
    await post('SERVER_RESTART', key).expect(409);
    await post('SERVER_PAUSE', key, R.DEV).expect(409);
    expect(await count()).toBe(1);
    const other = await servers.register({ code: randomUUID(), name: 'Other' });
    const scoped = (
      await post('SERVER_RESTART', key, R.COORDINATOR, other.id).expect(202)
    ).body;
    expect(scoped.operationId).not.toBe(first.operationId);
    const raced = randomUUID();
    const responses = await Promise.all([
      post('SERVER_START', raced),
      post('SERVER_RESTART', raced),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([202, 409]);
    expect(await count()).toBe(2);
    expect(
      await audits(responses.find((r) => r.status === 202)!.body.operationId),
    ).toHaveLength(1);
    expect(gateway.sends).toHaveLength(3);
  });
  it('requires a valid Idempotency-Key, UUID route and empty body without persistence', async () => {
    for (const type of SERVER_CONTROL_TYPES) {
      await http()
        .post(path(type))
        .auth(tokens.get(R.COORDINATOR)!, { type: 'bearer' })
        .expect(400);
      for (const key of ['', 'a b', 'a,b', 'x'.repeat(129)])
        await post(type, key).expect(400);
      await post(type, randomUUID(), R.COORDINATOR, 'invalid').expect(400);
      for (const extra of [
        { command: 'shutdown' },
        { args: ['-x'] },
        { executablePath: '/bin/sh' },
        { env: { A: '1' } },
        { type: 'SERVER_RESTART' },
        { requestedByStaffId: randomUUID() },
        { gameServerId: randomUUID() },
      ])
        await post(type).send(extra).expect(400);
    }
    expect(await count()).toBe(0);
    expect(gateway.sends).toHaveLength(0);
  });
  it('returns 404 for unknown servers and 409 for disabled servers, including replays', async () => {
    await post(
      'SERVER_START',
      randomUUID(),
      R.COORDINATOR,
      randomUUID(),
    ).expect(404);
    const key = randomUUID();
    await post('SERVER_START', key).expect(202);
    await setEnabled(false);
    for (const type of SERVER_CONTROL_TYPES) await post(type).expect(409);
    await post('SERVER_START', key).expect(409);
    await setEnabled(true);
    expect(await count()).toBe(1);
    expect(gateway.sends).toHaveLength(1);
  });
  it('rolls back the operation when Audit fails, never dispatches, and permits a safe retry', async () => {
    for (const type of SERVER_CONTROL_TYPES) {
      const key = randomUUID(),
        requestId = randomUUID();
      await database.query(
        `ALTER TABLE audit_logs ADD CONSTRAINT server_control_audit_failure CHECK (request_id <> '${requestId}')`,
      );
      try {
        await post(type, key).set('x-request-id', requestId).expect(503);
        expect(await operations().countBy({ idempotencyKey: key })).toBe(0);
        expect(
          await database.query(
            'SELECT id FROM audit_logs WHERE request_id = $1',
            [requestId],
          ),
        ).toEqual([]);
        expect(gateway.sends).toHaveLength(0);
      } finally {
        await database.query(
          'ALTER TABLE audit_logs DROP CONSTRAINT server_control_audit_failure',
        );
      }
      const { body } = await post(type, key).expect(202);
      expect(await audits(body.operationId)).toHaveLength(1);
      gateway.reset();
    }
  });
  it('dispatches only after commit and holds no transaction or lock during gateway I/O', async () => {
    let verified = false;
    gateway.beforeSend = async (sent) => {
      // A separate connection sees the committed row and Audit and can lock both.
      await database.transaction(async (manager) => {
        await manager.query(
          'SELECT id FROM game_servers WHERE id = $1 FOR UPDATE NOWAIT',
          [server.id],
        );
        expect(
          await manager.query(
            'SELECT status FROM server_control_operations WHERE id = $1 FOR UPDATE NOWAIT',
            [sent.operationId],
          ),
        ).toEqual([{ status: S.PENDING }]);
        expect(
          await manager.query(
            "SELECT id FROM audit_logs WHERE metadata->>'operationId' = $1",
            [sent.operationId],
          ),
        ).toHaveLength(1);
      });
      expect(
        await database.query(
          "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state LIKE 'idle in transaction%'",
        ),
      ).toEqual([]);
      verified = true;
    };
    const { body } = await post('SERVER_RESTART').expect(202);
    expect(verified).toBe(true);
    expect(body.status).toBe(S.DISPATCHED);
    expect(gateway.sends).toHaveLength(1);
  });
  it('never reports success without an Agent: disconnected and rejected fail, ambiguous stays DISPATCHED', async () => {
    const cases = [
      [
        { accepted: false, reason: 'UNAVAILABLE' },
        S.FAILED,
        'AGENT_UNAVAILABLE',
      ],
      [{ accepted: false, reason: 'REJECTED' }, S.FAILED, 'AGENT_REJECTED'],
      [new Error('socket reset'), S.DISPATCHED, null],
      ['HANG', S.DISPATCHED, null],
    ] as const;
    for (const [response, status, errorCode] of cases) {
      gateway.responses = [response];
      const accepted = await post('SERVER_START').expect(202);
      expect(accepted.body.status).toBe(status);
      const detail = (await get(accepted.body.operationId).expect(200)).body;
      expect(detail).toMatchObject({ status, errorCode });
      expect(detail.status).not.toBe(S.SUCCEEDED);
      if (status === S.FAILED) {
        expect(detail.completedAt).not.toBeNull();
        expect(detail.dispatchedAt).toBeNull();
        expect(detail.errorMessage).toEqual(expect.any(String));
      } else {
        expect(detail.dispatchedAt).not.toBeNull();
        expect(detail.completedAt).toBeNull();
      }
      const [entry] = await audits(accepted.body.operationId);
      expect(entry.outcome).toBe('SUCCESS');
    }
    // Failed and ambiguous work is never resent by the recovery path.
    const sends = gateway.sends.length;
    await dispatcher.dispatchPending();
    expect(gateway.sends).toHaveLength(sends);
  });
  it('recovers unclaimed work after commit, fails it if the server was disabled, and never resends claims', async () => {
    const base = {
      gameServerId: server.id,
      status: S.PENDING,
      correlationId: randomUUID(),
      requestedByStaffId: staffIds.get(R.DEV)!,
      type: 'SERVER_PAUSE' as const,
    };
    const orphan = await operations().save(
      operations().create({ ...base, idempotencyKey: randomUUID() }),
    );
    const claimed = await operations().save(
      operations().create({
        ...base,
        correlationId: randomUUID(),
        idempotencyKey: randomUUID(),
        dispatchClaimedAt: new Date(),
      }),
    );
    await dispatcher.dispatchPending();
    expect(gateway.sends.map((s) => s.operationId)).toEqual([orphan.id]);
    expect((await read(orphan.id)).status).toBe(S.DISPATCHED);
    expect((await read(claimed.id)).status).toBe(S.PENDING);
    await dispatcher.dispatch(orphan.id);
    expect(gateway.sends).toHaveLength(1);
    const disabled = await operations().save(
      operations().create({
        ...base,
        correlationId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    );
    await setEnabled(false);
    try {
      await dispatcher.dispatchPending();
      expect(await read(disabled.id)).toMatchObject({
        status: S.FAILED,
        errorCode: 'SERVER_DISABLED',
      });
      expect(gateway.sends).toHaveLength(1);
    } finally {
      await setEnabled(true);
    }
  });
  it('protects detail by stored type and current grants, hides internals and isolates other domains', async () => {
    const ids = new Map<ServerControlType, string>();
    for (const type of SERVER_CONTROL_TYPES)
      ids.set(type, (await post(type).expect(202)).body.operationId);
    const detail = await get(ids.get('SERVER_RESTART')!, R.DEV).expect(200);
    const stored = await read(ids.get('SERVER_RESTART')!);
    expect(Object.keys(detail.body).sort()).toEqual(
      [
        'operationId',
        'gameServerId',
        'type',
        'status',
        'correlationId',
        'requestId',
        'createdAt',
        'requestedByStaffId',
        'dispatchedAt',
        'completedAt',
        'errorCode',
        'errorMessage',
      ].sort(),
    );
    expect(detail.text).not.toContain(stored.idempotencyKey);
    expect(detail.text).not.toMatch(/claim|idempotency/i);
    await database.query(
      "DELETE FROM role_permissions WHERE role_name='DEV' AND permission_name='SERVER_RESTART'",
    );
    try {
      await get(ids.get('SERVER_RESTART')!, R.DEV).expect(403);
      await get(ids.get('SERVER_START')!, R.DEV).expect(200);
      await post('SERVER_RESTART', randomUUID(), R.DEV).expect(403);
    } finally {
      await database.query(
        "INSERT INTO role_permissions VALUES ('DEV', 'SERVER_RESTART')",
      );
    }
    for (const role of [R.GENERAL_CHIEF, R.ADMIN, R.MODERATOR, R.SUPPORT]) {
      await get(ids.get('SERVER_START')!, role).expect(403);
      await get(randomUUID(), role).expect(403);
    }
    await get(randomUUID()).expect(404);
    await get('invalid').expect(400);
    const command = await app.get(GameCommandBus).submit({
      type: 'BRIDGE_PING',
      payload: { nonce: 'ping' },
      gameServerId: server.id,
      idempotencyKey: randomUUID(),
    });
    await get(command.id).expect(404);
    for (const route of ['game-commands', 'world-operations'])
      await http()
        .get(`/api/v1/${route}/${ids.get('SERVER_START')}`)
        .auth(tokens.get(R.COORDINATOR)!, { type: 'bearer' })
        .expect(404);
  });
  it('documents exactly three fixed control routes and exposes no arbitrary execution endpoint', async () => {
    const { body } = await http().get('/docs-json').expect(200);
    const control = Object.keys(body.paths).filter((p) =>
      p.includes('/control'),
    );
    expect(control.sort()).toEqual(
      ['pause', 'restart', 'start'].map(
        (p) => `/api/v1/game-servers/{serverId}/control/${p}`,
      ),
    );
    for (const type of SERVER_CONTROL_TYPES) {
      const route =
        body.paths[
          `/api/v1/game-servers/{serverId}/control/${SERVER_CONTROL_POLICY[type].path}`
        ];
      expect(Object.keys(route)).toEqual(['post']);
      expect(route.post.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
          }),
        ]),
      );
      for (const code of ['202', '400', '401', '403', '404', '409', '503'])
        expect(route.post.responses).toHaveProperty(code);
      expect(route.post.responses['202'].headers).toHaveProperty('Location');
      expect(
        route.post.responses['202'].content['application/json'].schema.$ref,
      ).toContain('ServerControlOperationReferenceDto');
      expect(route.post.description).toContain(
        SERVER_CONTROL_POLICY[type].permission,
      );
    }
    expect(
      body.paths['/api/v1/server-control-operations/{operationId}'].get,
    ).toBeDefined();
    expect(
      body.components.schemas.EmptyServerControlBodyDto.properties ?? {},
    ).toEqual({});
    for (const suffix of ['execute', 'command', 'shell', 'stop', 'raw'])
      await http()
        .post(`/api/v1/game-servers/${server.id}/control/${suffix}`)
        .auth(tokens.get(R.COORDINATOR)!, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({ command: 'x' })
        .expect(404);
    expect(await count()).toBe(0);
  });
  it('reverts only the operation table and reapplies cleanly', async () => {
    await database.undoLastMigration(); // Etapa 10.15 Player Chat
    await database.undoLastMigration(); // Etapa 10.14 Player Marketplace
    await database.undoLastMigration(); // Etapa 10.13 Player Trades
    await database.undoLastMigration(); // Etapa 10.12 Economy
    await database.undoLastMigration(); // Etapa 10.9 Player Guilds
    await database.undoLastMigration(); // Etapa 10.8 Player Groups
    await database.undoLastMigration(); // Etapa 10.7 Professions
    await database.undoLastMigration(); // Etapa 10.4 Player Characters
    await database.undoLastMigration(); // Etapa 10.3 Player Sessions
    await database.undoLastMigration(); // Etapa 10.2 Generic Actor
    await database.undoLastMigration(); // Etapa 10.1 Player Accounts
    await database.undoLastMigration();
    expect(
      await database.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename = 'server_control_operations'",
        [schema],
      ),
    ).toEqual([]);
    expect(await database.query('SELECT * FROM permissions')).toHaveLength(36);
    expect(await database.query('SELECT * FROM role_permissions')).toHaveLength(
      93,
    );
    expect(await database.runMigrations()).toHaveLength(12);
    expect(await database.runMigrations()).toHaveLength(0);
    expect(
      (await database.driver.createSchemaBuilder().log()).upQueries,
    ).toEqual([]);
  });
});
