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
import { GameCommand } from '../src/game-bridge/entities/game-command.entity.js';
import { GameCommandResult } from '../src/game-bridge/entities/game-command-result.entity.js';
import { GameServer } from '../src/game-bridge/entities/game-server.entity.js';
import { GameCommandBus } from '../src/game-bridge/game-command-bus.js';
import { GameCommandDispatcher } from '../src/game-bridge/game-command-dispatcher.js';
import { GameCommandReceiver } from '../src/game-bridge/game-command-receiver.js';
import { GameServerService } from '../src/game-bridge/game-server.service.js';
import { GameConnectionService } from '../src/game-bridge/game-connection.service.js';
import { GameGateway } from '../src/game-bridge/game-gateway.js';
import { BridgeClock } from '../src/game-bridge/bridge-clock.js';
import { CommandStatus as S } from '../src/game-bridge/command-state.js';
import type { ResultMessage } from '../src/game-bridge/command-contract.js';
import {
  MockGameGateway,
  TestBridgeClock,
} from './support/mock-game-gateway.js';
import { worldCases } from './support/world-cases.js';
import type { WorldCase } from './support/world-cases.js';
import { WORLD_COMMAND_TYPES } from '../src/world-management/world-command.contracts.js';

const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;
describeDatabase('World with real PostgreSQL', () => {
  let admin: DataSource, database: DataSource, app: INestApplication<App>;
  let bus: GameCommandBus,
    dispatcher: GameCommandDispatcher,
    receiver: GameCommandReceiver,
    servers: GameServerService,
    connections: GameConnectionService;
  let server: GameServer;
  const gateway = new MockGameGateway();
  const clock = new TestBridgeClock();
  const schema = `world_test_${randomUUID().replaceAll('-', '')}`;
  const tokens = new Map<R, string>(),
    staffIds = new Map<R, string>();
  const http = () => request(app.getHttpServer());
  const cases = (role = R.COORDINATOR) => worldCases(staffIds.get(role)!);
  const path = (sample: WorldCase, serverId = server.id) =>
    `/api/v1/game-servers/${serverId}/world/${sample.path}`;
  const post = (
    sample: WorldCase,
    key: string = randomUUID(),
    role = R.COORDINATOR,
  ) =>
    http()
      .post(path(sample))
      .auth(tokens.get(role)!, { type: 'bearer' })
      .set('Idempotency-Key', key);
  const get = (id: string, role = R.COORDINATOR) =>
    http()
      .get(`/api/v1/world-operations/${id}`)
      .auth(tokens.get(role)!, { type: 'bearer' });
  const generic = (id: string, role = R.SUPPORT) =>
    http()
      .get(`/api/v1/game-commands/${id}`)
      .auth(tokens.get(role)!, { type: 'bearer' });
  const commands = () => database.getRepository<GameCommand>('GameCommand');
  const results = () =>
    database.getRepository<GameCommandResult>('GameCommandResult');
  const read = (id: string) => commands().findOneByOrFail({ id });
  const audits = (id: string) =>
    database.query(
      "SELECT * FROM audit_logs WHERE metadata->>'commandId' = $1",
      [id],
    );
  const message = (command: GameCommand, result: unknown): ResultMessage =>
    ({
      protocolVersion: '1',
      serverId: command.gameServerId,
      connectionId: command.dispatchedConnectionId!,
      commandId: command.id,
      correlationId: command.correlationId,
      outcome: S.SUCCEEDED,
      result,
    }) as ResultMessage;
  async function dispatched(sample: WorldCase) {
    const { body } = await post(sample).send(sample.body).expect(202);
    await connections.connect({
      gameServerId: server.id,
      externalConnectionId: randomUUID(),
    });
    return dispatcher.dispatch(body.commandId);
  }
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
    expect(await database.runMigrations()).toHaveLength(16);
    expect(await database.runMigrations()).toHaveLength(0);
    const { AppModule } = await import('../src/app.module.js');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DataSource)
      .useValue(database)
      .overrideProvider(GameGateway)
      .useValue(gateway)
      .overrideProvider(BridgeClock)
      .useValue(clock)
      .compile();
    app = module.createNestApplication(new AppExpressAdapter());
    app.useLogger(false);
    setupApp(app);
    await app.listen(0, '127.0.0.1');
    bus = app.get(GameCommandBus);
    dispatcher = app.get(GameCommandDispatcher);
    receiver = app.get(GameCommandReceiver);
    servers = app.get(GameServerService);
    connections = app.get(GameConnectionService);
    const password = 'World-Test-Password-42';
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
    gateway.sends = [];
    gateway.responses = [];
    gateway.beforeSend = undefined;
    gateway.available = true;
    server = await servers.register({
      code: randomUUID(),
      name: 'World test',
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
  it('reuses the schema and incremental grants without world tables or pending migrations', async () => {
    expect(database.options.synchronize).toBe(false);
    expect(await database.showMigrations()).toBe(false);
    expect(
      (await database.driver.createSchemaBuilder().log()).upQueries,
    ).toEqual([]);
    expect(await database.query('SELECT * FROM permissions')).toHaveLength(36);
    expect(await database.query('SELECT * FROM role_permissions')).toHaveLength(
      93,
    );
    const rows = await database.query(
      'SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename',
      [schema],
    );
    expect(rows.map((r: { tablename: string }) => r.tablename)).toEqual([
      'audit_logs',
      'character_professions',
      'game_command_results',
      'game_commands',
      'game_connections',
      'game_servers',
      'migrations',
      'permissions',
      'player_character_link_challenges',
      'player_characters',
      'player_group_invites',
      'player_group_members',
      'player_groups',
      'player_guild_invites',
      'player_guild_members',
      'player_guilds',
      'player_identities',
      'player_sessions',
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
  it.each(WORLD_COMMAND_TYPES)(
    'deduplicates concurrent and repeated %s requests in PostgreSQL',
    async (type) => {
      const sample = cases().find((c) => c.type === type)!;
      const key = randomUUID();
      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          post(sample, key).send(sample.body).expect(202),
        ),
      );
      const first = responses[0].body;
      expect(new Set(responses.map((r) => r.body.commandId)).size).toBe(1);
      expect(new Set(responses.map((r) => r.body.correlationId)).size).toBe(1);
      expect(await commands().countBy({ gameServerId: server.id })).toBe(1);
      expect(await audits(first.commandId)).toHaveLength(sample.action ? 1 : 0);
      await connections.connect({
        gameServerId: server.id,
        externalConnectionId: randomUUID(),
      });
      const command = await dispatcher.dispatch(first.commandId);
      await receiver.result(message(command, sample.result));
      const replay = await post(sample, key).send(sample.body).expect(202);
      expect(replay.body).toMatchObject({
        commandId: command.id,
        correlationId: command.correlationId,
        status: S.SUCCEEDED,
      });
      expect(gateway.sends).toHaveLength(1);
      expect(await audits(command.id)).toHaveLength(sample.action ? 1 : 0);
    },
  );
  it.each(WORLD_COMMAND_TYPES.filter((type) => type !== 'WORLD_STATE_QUERY'))(
    'rolls back %s completely if Audit fails and permits a safe retry',
    async (type) => {
      const sample = cases().find((c) => c.type === type)!,
        key = randomUUID(),
        requestId = randomUUID();
      await database.query(
        `ALTER TABLE audit_logs ADD CONSTRAINT world_test_audit_failure CHECK (request_id <> '${requestId}')`,
      );
      try {
        await post(sample, key)
          .set('x-request-id', requestId)
          .send(sample.body)
          .expect(503);
        expect(await commands().countBy({ gameServerId: server.id })).toBe(0);
        expect(
          await database.query(
            'SELECT id FROM audit_logs WHERE request_id = $1',
            [requestId],
          ),
        ).toEqual([]);
        expect(gateway.sends).toHaveLength(0);
      } finally {
        await database.query(
          'ALTER TABLE audit_logs DROP CONSTRAINT world_test_audit_failure',
        );
      }
      const { body } = await post(sample, key).send(sample.body).expect(202);
      expect(await audits(body.commandId)).toHaveLength(1);
    },
  );
  it('rejects missing/disabled servers and accepts enabled offline/stale without execution success', async () => {
    const sample = cases()[1];
    await http()
      .post(path(sample, randomUUID()))
      .auth(tokens.get(R.COORDINATOR)!, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send(sample.body)
      .expect(404);
    await database
      .getRepository<GameServer>('GameServer')
      .update(server.id, { enabled: false });
    await post(sample).send(sample.body).expect(409);
    expect(await commands().countBy({ gameServerId: server.id })).toBe(0);
    await database
      .getRepository<GameServer>('GameServer')
      .update(server.id, { enabled: true });
    const key = randomUUID();
    const offline = await post(sample, key).send(sample.body).expect(202);
    expect(offline.body.status).toBe(S.PENDING);
    const conn = await connections.connect({
      gameServerId: server.id,
      externalConnectionId: randomUUID(),
    });
    await database.query(
      'UPDATE game_connections SET last_heartbeat_at = $1 WHERE id = $2',
      [new Date(clock.now().getTime() - 3600001), conn.id],
    );
    expect((await post(sample).send(sample.body).expect(202)).body.status).toBe(
      S.PENDING,
    );
    await database
      .getRepository<GameServer>('GameServer')
      .update(server.id, { enabled: false });
    await post(sample, key).send(sample.body).expect(409);
    expect(await commands().countBy({ gameServerId: server.id })).toBe(2);
    expect(await audits(offline.body.commandId)).toHaveLength(1);
    expect(gateway.sends).toHaveLength(0);
  });
  it.each(WORLD_COMMAND_TYPES)(
    'validates %s results against the stored request and protects generic metadata',
    async (type) => {
      const sample = cases().find((c) => c.type === type)!;
      const command = await dispatched(sample);
      const key = Object.keys(sample.result)[0];
      const original = (sample.result as unknown as Record<string, unknown>)[
        key
      ];
      for (const invalid of [
        { arbitrary: true },
        {
          ...sample.result,
          [key]: typeof original === 'boolean' ? !original : 'wrong-target',
        },
        { ...sample.result, reason: 'private' },
        { anything: 'x'.repeat(65536) },
      ]) {
        await expect(
          receiver.result(message(command, invalid)),
        ).rejects.toThrow();
        expect((await read(command.id)).status).toBe(S.DISPATCHED);
        expect(await results().countBy({ gameCommandId: command.id })).toBe(0);
      }
      await receiver.result(message(command, sample.result));
      await receiver.result(message(command, sample.result));
      expect(await results().countBy({ gameCommandId: command.id })).toBe(1);
      expect((await get(command.id).expect(200)).body.result.result).toEqual(
        sample.result,
      );
      for (const role of [R.SUPPORT, R.DEV]) {
        const response = await generic(command.id, role).expect(200);
        expect(response.body.result).toEqual({
          outcome: S.SUCCEEDED,
          errorCode: null,
          receivedAt: clock.now().toISOString(),
        });
        expect(response.body).not.toHaveProperty('payload');
        expect(response.text).not.toMatch(
          /gameHour|weatherId|baseFormId|quantity|Quantity|actorStaffId|opaque:|idempotencyKey|dispatchLease|dispatchedConnectionId|ownership/,
        );
      }
    },
  );
  it('commits command and Audit before send, releases locks and permits a result during gateway I/O', async () => {
    const sample = cases()[1];
    const accepted = (await post(sample).send(sample.body).expect(202)).body;
    await connections.connect({
      gameServerId: server.id,
      externalConnectionId: randomUUID(),
    });
    let verified = false;
    gateway.beforeSend = async () => {
      await database.transaction(async (manager) => {
        await manager.query(
          'SELECT id FROM game_servers WHERE id = $1 FOR UPDATE NOWAIT',
          [server.id],
        );
        expect(
          await manager.query(
            'SELECT id FROM game_commands WHERE id = $1 FOR UPDATE NOWAIT',
            [accepted.commandId],
          ),
        ).toHaveLength(1);
        expect(
          await manager.query(
            "SELECT id FROM audit_logs WHERE metadata->>'commandId' = $1",
            [accepted.commandId],
          ),
        ).toHaveLength(1);
      });
      expect(
        await database.query(
          "SELECT pid FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND state = 'idle in transaction' AND query LIKE '%game_commands%' AND query LIKE '%dispatch_lease%'",
        ),
      ).toEqual([]);
      const reserved = await read(accepted.commandId);
      const response = await generic(reserved.id).expect(200);
      expect(response.text).not.toContain(reserved.dispatchLeaseId!);
      expect(response.text).not.toContain(reserved.idempotencyKey);
      await receiver.result(message(reserved, sample.result));
      verified = true;
    };
    expect((await dispatcher.dispatch(accepted.commandId)).status).toBe(
      S.SUCCEEDED,
    );
    expect(verified).toBe(true);
    expect(await audits(accepted.commandId)).toHaveLength(1);
  });
  it('preserves accepted Audit when execution fails or times out and rejects another domain', async () => {
    const sample = cases()[1],
      failed = await dispatched(sample);
    await receiver.result({
      ...message(failed, sample.result),
      outcome: S.FAILED,
      errorCode: 'BRIDGE_ERROR',
    });
    expect((await get(failed.id).expect(200)).body.result).toMatchObject({
      outcome: S.FAILED,
      result: null,
      errorMessage: 'Bridge reported failure',
    });
    expect((await audits(failed.id))[0].outcome).toBe('SUCCESS');
    const late = await dispatched(sample);
    clock.advance(86400000);
    await receiver.expireCommands();
    expect((await read(late.id)).status).toBe(S.TIMEOUT);
    expect((await audits(late.id))[0].outcome).toBe('SUCCESS');
    await get(randomUUID()).expect(404);
    await get('invalid').expect(400);
    for (const input of [
      { type: 'PLAYER_BAN' as const, payload: { playerId: 'p' } },
      { type: 'BRIDGE_PING' as const, payload: { nonce: 'ping' } },
      {
        type: 'CHARACTER_INVENTORY_QUERY' as const,
        payload: { characterId: 'c' },
      },
    ]) {
      const other = await bus.submit({
        ...input,
        gameServerId: server.id,
        idempotencyKey: randomUUID(),
      });
      await get(other.id).expect(404);
    }
  });
  it('documents all four fixed routes, required key, 202 schema, Location and dynamic detail without an execution endpoint', async () => {
    const { body } = await http().get('/docs-json').expect(200);
    for (const sample of cases()) {
      const path = `/api/v1/game-servers/{serverId}/world/${sample.path}`;
      const route = body.paths[path];
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
      ).toContain('WorldOperationReferenceDto');
      expect(route.post.description).toContain(sample.permission);
    }
    expect(
      body.paths['/api/v1/world-operations/{commandId}'].get,
    ).toBeDefined();
    for (const dto of [
      'WorldTimeBodyDto',
      'WorldWeatherBodyDto',
      'WorldSpawnBodyDto',
      'EmptyWorldBodyDto',
    ]) {
      expect(body.components.schemas[dto].properties).not.toHaveProperty(
        'actorStaffId',
      );
      expect(body.components.schemas[dto].properties).not.toHaveProperty(
        'staffId',
      );
    }
    for (const suffix of ['execute', 'commands', 'console', 'script'])
      await http()
        .post(`/api/v1/game-servers/${server.id}/world/${suffix}`)
        .auth(tokens.get(R.COORDINATOR)!, { type: 'bearer' })
        .send({ command: 'x' })
        .expect(404);
  });
  it('reverses only the four permissions and nine grants and reapplies cleanly', async () => {
    await database.undoLastMigration(); // Etapa 10.9 Player Guilds
    await database.undoLastMigration(); // Etapa 10.8 Player Groups
    await database.undoLastMigration(); // Etapa 10.7 Professions
    await database.undoLastMigration(); // Etapa 10.4 Player Characters
    await database.undoLastMigration(); // Etapa 10.3 Player Sessions
    await database.undoLastMigration(); // Etapa 10.2 Generic Actor
    await database.undoLastMigration(); // Etapa 10.1 Player Accounts
    await database.undoLastMigration(); // Etapa 09 Server Control
    await database.undoLastMigration(); // Etapa 08 VIP Store
    await database.undoLastMigration();
    expect(await database.query('SELECT * FROM permissions')).toHaveLength(31);
    expect(await database.query('SELECT * FROM role_permissions')).toHaveLength(
      83,
    );
    expect(
      await database.query(
        "SELECT * FROM permissions WHERE name LIKE 'WORLD_%'",
      ),
    ).toEqual([]);
    expect(await database.runMigrations()).toHaveLength(10);
    expect(await database.runMigrations()).toHaveLength(0);
    expect(
      await database.query(
        "SELECT * FROM role_permissions WHERE permission_name LIKE 'WORLD_%' ORDER BY role_name, permission_name",
      ),
    ).toEqual([
      { role_name: 'ADMIN', permission_name: 'WORLD_READ' },
      ...['COORDINATOR', 'GENERAL_CHIEF'].flatMap((role_name) =>
        [
          'WORLD_ENTITY_SPAWN',
          'WORLD_READ',
          'WORLD_TIME_WRITE',
          'WORLD_WEATHER_WRITE',
        ].map((permission_name) => ({ role_name, permission_name })),
      ),
    ]);
  });
  it.each(WORLD_COMMAND_TYPES)(
    'accepts %s with typed payload, authenticated attribution and allowlisted Audit only for mutations',
    async (type) => {
      const sample = cases().find((c) => c.type === type)!;
      const requestId = randomUUID();
      const { body, headers, text } = await post(sample)
        .set('x-request-id', requestId)
        .send(sample.body)
        .expect(202);
      expect(headers.location).toBe(
        `/api/v1/world-operations/${body.commandId}`,
      );
      expect(body).toMatchObject({
        type,
        status: S.PENDING,
        requestId,
        gameServerId: server.id,
      });
      expect(text).not.toMatch(
        /payload|gameHour|weatherId|baseFormId|quantity|actorStaffId|idempotencyKey|dispatchLease/,
      );
      const command = await read(body.commandId);
      expect(command).toMatchObject({
        payload: sample.payload,
        requestedByStaffId: staffIds.get(R.COORDINATOR),
        dispatchAttempts: 0,
      });
      const entries = await audits(command.id);
      expect(entries).toHaveLength(sample.action ? 1 : 0);
      if (sample.action) {
        expect(entries[0]).toMatchObject({
          action: sample.action,
          outcome: 'SUCCESS',
          resource_type: 'WORLD',
          resource_id: command.id,
          status_code: 202,
          actor_staff_id: staffIds.get(R.COORDINATOR),
          request_id: requestId,
        });
        expect(entries[0].metadata).toEqual({
          gameServerId: server.id,
          commandId: command.id,
          correlationId: command.correlationId,
          ...sample.payload,
        });
        expect(JSON.stringify(entries[0].metadata)).not.toMatch(
          /payload|result|idempotency|lease|token/i,
        );
      }
      expect((await get(command.id).expect(200)).body.payload).toEqual(
        sample.payload,
      );
      expect(gateway.sends).toHaveLength(0);
    },
  );
  it.each(Object.values(R))(
    'enforces independent POST and detail matrix for %s',
    async (role) => {
      for (const sample of cases(role)) {
        const authorized =
          role === R.COORDINATOR ||
          role === R.GENERAL_CHIEF ||
          (role === R.ADMIN && sample.type === 'WORLD_STATE_QUERY');
        const response = await post(sample, randomUUID(), role)
          .send(sample.body)
          .expect(authorized ? 202 : 403);
        const id = authorized
          ? response.body.commandId
          : (await post(sample).send(sample.body).expect(202)).body.commandId;
        await get(id, role).expect(authorized ? 200 : 403);
        await generic(id, role).expect(200);
        if (authorized)
          expect((await read(id)).payload).toEqual(sample.payload);
        expect(await audits(id)).toHaveLength(sample.action ? 1 : 0);
      }
      expect(await commands().countBy({ gameServerId: server.id })).toBe(4);
    },
  );
  it('uses current grants and stored type for operation detail', async () => {
    const query = (await post(cases()[0]).send({}).expect(202)).body;
    const time = (await post(cases()[1]).send(cases()[1].body).expect(202))
      .body;
    await get(query.commandId, R.ADMIN).expect(200);
    await get(time.commandId, R.ADMIN).expect(403);
    await database.query(
      "DELETE FROM role_permissions WHERE role_name='ADMIN' AND permission_name='WORLD_READ'",
    );
    try {
      await get(query.commandId, R.ADMIN).expect(403);
      await post(cases()[0], randomUUID(), R.ADMIN).send({}).expect(403);
      await generic(query.commandId, R.ADMIN).expect(200);
    } finally {
      await database.query(
        "INSERT INTO role_permissions VALUES ('ADMIN', 'WORLD_READ')",
      );
    }
  });
  it('rejects anonymous calls, arbitrary identities, commands and targets without persistence', async () => {
    for (const sample of cases()) {
      await http().post(path(sample)).send(sample.body).expect(401);
      for (const extra of [
        { actorStaffId: staffIds.get(R.COORDINATOR) },
        { staffId: randomUUID() },
        { requestedByStaffId: randomUUID() },
        { type: 'WORLD_TIME_SET' },
        { rawCommand: 'x' },
        { consoleCommand: 'x' },
        { script: 'x' },
        { Papyrus: 'x' },
        { coordinates: { x: 1, y: 2, z: 3 } },
        { cell: 'x' },
        { worldspace: 'x' },
        { targetPlayerId: 'p' },
        { payload: {} },
        { requestId: 'forged' },
      ])
        await post(sample)
          .send({ ...sample.body, ...extra })
          .expect(400);
    }
    await http().get(`/api/v1/world-operations/${randomUUID()}`).expect(401);
    expect(await commands().countBy({ gameServerId: server.id })).toBe(0);
  });
  it('validates hour boundaries, finite numbers, opaque identifiers and conservative integer quantities', async () => {
    for (const value of [-1, 24, 25, '12', null])
      await post(cases()[1]).send({ gameHour: value }).expect(400);
    for (const gameHour of [0, 23.999]) {
      const { body } = await post(cases()[1]).send({ gameHour }).expect(202);
      expect((await read(body.commandId)).payload).toEqual({ gameHour });
    }
    for (const [sample, field] of [
      [cases()[2], 'weatherId'],
      [cases()[3], 'baseFormId'],
    ] as const) {
      for (const value of [
        '',
        ' ',
        'x'.repeat(129),
        'x\n',
        '\u0000',
        '\ud800',
        1,
        null,
      ])
        await post(sample)
          .send({ ...sample.body, [field]: value })
          .expect(400);
      const { body } = await post(sample)
        .send({ ...sample.body, [field]: `  ${'á'.repeat(128)}  ` })
        .expect(202);
      expect((await read(body.commandId)).payload).toMatchObject({
        [field]: 'á'.repeat(128),
      });
    }
    for (const quantity of [0, -1, 11, 1.5, '1', null])
      await post(cases()[3]).send({ baseFormId: 'b', quantity }).expect(400);
    for (const quantity of [1, 10])
      await post(cases()[3]).send({ baseFormId: 'b', quantity }).expect(202);
    for (const sample of cases().slice(1))
      await post(sample).send({}).expect(400);
    await post(cases()[1]).send({ increment: 1 }).expect(400);
    await post(cases()[1]).send({ toggle: true }).expect(400);
    // JSON numeric overflow must remain invalid after HTTP parsing.
    await post(cases()[1])
      .set('Content-Type', 'application/json')
      .send('{"gameHour":1e999}')
      .expect(400);
  });
  it('requires Idempotency-Key on every POST and validates routes', async () => {
    for (const sample of cases()) {
      await http()
        .post(path(sample))
        .auth(tokens.get(R.COORDINATOR)!, { type: 'bearer' })
        .send(sample.body)
        .expect(400);
      for (const key of ['', 'a b', 'a,b', 'x'.repeat(129)])
        await post(sample, key).send(sample.body).expect(400);
      await http()
        .post(path(sample, 'invalid'))
        .auth(tokens.get(R.COORDINATOR)!, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send(sample.body)
        .expect(400);
    }
    expect(await commands().countBy({ gameServerId: server.id })).toBe(0);
  });
  it('canonicalizes identifiers, preserves original attribution, scopes keys to server and rejects payload/type/self conflicts', async () => {
    const key = randomUUID(),
      weather = cases()[2],
      spawn = cases()[3];
    const first = (
      await post(weather, key).send({ weatherId: ' weather ' }).expect(202)
    ).body;
    expect(
      (
        await post(weather, key, R.GENERAL_CHIEF)
          .send({ weatherId: 'weather' })
          .expect(202)
      ).body,
    ).toEqual(first);
    expect((await read(first.commandId)).requestedByStaffId).toBe(
      staffIds.get(R.COORDINATOR),
    );
    await post(weather, key).send({ weatherId: 'other' }).expect(409);
    await post(cases()[1], key).send(cases()[1].body).expect(409);
    const selfKey = randomUUID();
    await post(spawn, selfKey).send(spawn.body).expect(202);
    await post(cases(R.GENERAL_CHIEF)[3], selfKey, R.GENERAL_CHIEF)
      .send(spawn.body)
      .expect(409);
    await post(spawn, selfKey)
      .send({ ...spawn.body, quantity: 4 })
      .expect(409);
    const other = await servers.register({ code: randomUUID(), name: 'Other' });
    await http()
      .post(path(weather, other.id))
      .auth(tokens.get(R.COORDINATOR)!, { type: 'bearer' })
      .set('Idempotency-Key', key)
      .send({ weatherId: 'other' })
      .expect(202);
    expect(await commands().countBy({ gameServerId: server.id })).toBe(2);
    expect(await audits(first.commandId)).toHaveLength(1);
    expect(gateway.sends).toHaveLength(0);
  });
  it('accepts exactly one concurrent conflicting mutation', async () => {
    const key = randomUUID(),
      sample = cases()[1];
    const responses = await Promise.all([
      post(sample, key).send({ gameHour: 1 }),
      post(sample, key).send({ gameHour: 2 }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([202, 409]);
    expect(await commands().countBy({ gameServerId: server.id })).toBe(1);
    expect(
      await audits(responses.find((r) => r.status === 202)!.body.commandId),
    ).toHaveLength(1);
  });
  it('can accept a query while Audit writes are unavailable', async () => {
    const requestId = randomUUID();
    await database.query(
      `ALTER TABLE audit_logs ADD CONSTRAINT world_query_audit_failure CHECK (request_id <> '${requestId}')`,
    );
    try {
      const { body } = await post(cases()[0])
        .set('x-request-id', requestId)
        .send({})
        .expect(202);
      expect(await audits(body.commandId)).toEqual([]);
    } finally {
      await database.query(
        'ALTER TABLE audit_logs DROP CONSTRAINT world_query_audit_failure',
      );
    }
  });
  it('rejects all spawn result mismatches and preserves partial and zero results', async () => {
    const sample = cases()[3];
    const command = await dispatched(sample);
    for (const extra of [
      { actorStaffId: randomUUID() },
      { baseFormId: 'other' },
      { requestedQuantity: 2 },
      { requestedQuantity: '3' },
      { spawnedQuantity: 4 },
      { spawnedQuantity: -1 },
      { spawnedQuantity: 1.5 },
      { spawnedQuantity: '2' },
    ]) {
      await expect(
        receiver.result(message(command, { ...sample.result, ...extra })),
      ).rejects.toThrow();
      expect((await read(command.id)).status).toBe(S.DISPATCHED);
      expect(await results().countBy({ gameCommandId: command.id })).toBe(0);
    }
    await receiver.result(message(command, sample.result));
    const zero = await dispatched(sample);
    await receiver.result(
      message(zero, { ...sample.result, spawnedQuantity: 0 }),
    );
    expect(
      (await get(zero.id).expect(200)).body.result.result.spawnedQuantity,
    ).toBe(0);
    const query = await dispatched(cases()[0]);
    await receiver.result(
      message(query, { gameHour: 23.9, weatherId: ' weather ' }),
    );
    expect((await get(query.id).expect(200)).body.result.result).toEqual({
      gameHour: 23.9,
      weatherId: 'weather',
    });
  });
});
