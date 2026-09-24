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
import { CHARACTER_CASES } from './support/character-cases.js';
import type { CharacterCase } from './support/character-cases.js';

const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;
describeDatabase('Character Management with real PostgreSQL', () => {
  let admin: DataSource, database: DataSource, app: INestApplication<App>;
  let bus: GameCommandBus,
    dispatcher: GameCommandDispatcher,
    receiver: GameCommandReceiver,
    servers: GameServerService,
    connections: GameConnectionService;
  let server: GameServer;
  const gateway = new MockGameGateway();
  const clock = new TestBridgeClock();
  const schema = `character_test_${randomUUID().replaceAll('-', '')}`;
  const tokens = new Map<R, string>(),
    staffIds = new Map<R, string>();
  const http = () => request(app.getHttpServer());
  const path = (
    sample: CharacterCase,
    serverId = server.id,
    characterId = 'opaque:character-42',
  ) =>
    `/api/v1/game-servers/${serverId}/characters/${encodeURIComponent(characterId)}/${sample.path}`;
  const post = (
    sample: CharacterCase,
    key: string = randomUUID(),
    role = R.COORDINATOR,
  ) =>
    http()
      .post(path(sample))
      .auth(tokens.get(role)!, { type: 'bearer' })
      .set('Idempotency-Key', key);
  const get = (id: string, role = R.COORDINATOR) =>
    http()
      .get(`/api/v1/character-operations/${id}`)
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
  const inventory = CHARACTER_CASES[0];
  const give = CHARACTER_CASES[2];
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
  async function dispatched(sample: CharacterCase) {
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
    expect(await database.runMigrations()).toHaveLength(12);
    expect(await database.runMigrations()).toHaveLength(0);
    await database.undoLastMigration(); // Etapa 10.3 Player Sessions
    await database.undoLastMigration(); // Etapa 10.2 Generic Actor
    await database.undoLastMigration(); // Etapa 10.1 Player Accounts
    await database.undoLastMigration(); // Etapa 09 Server Control
    await database.undoLastMigration(); // Etapa 08 VIP Store
    await database.undoLastMigration(); // Etapa 07 World permission grants
    await database.undoLastMigration();
    const resultConstraint = () =>
      database.query(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
         WHERE conrelid = 'game_command_results'::regclass
         AND conname = 'game_command_results_size_check'`,
      );
    expect((await resultConstraint())[0].definition).toContain('4096');
    expect(await database.runMigrations()).toHaveLength(7);
    expect((await resultConstraint())[0].definition).toContain('65536');
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
    const password = 'Character-Test-Password-42';
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
      name: 'Character test',
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
  it('keeps schema/entities aligned, original permissions intact and no character snapshot tables', async () => {
    expect(database.options.synchronize).toBe(false);
    expect(await database.showMigrations()).toBe(false);
    expect(
      (await database.driver.createSchemaBuilder().log()).upQueries,
    ).toEqual([]);
    expect(await database.query('SELECT * FROM permissions')).toHaveLength(36);
    expect(await database.query('SELECT * FROM role_permissions')).toHaveLength(
      93,
    );
    expect(
      await database.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename LIKE 'character%'",
        [schema],
      ),
    ).toEqual([]);
  });
  it.each(CHARACTER_CASES)(
    'creates $type with attribution, 202/Location and exactly the expected audit',
    async (sample) => {
      const requestId = randomUUID();
      const { body, headers, text } = await post(sample)
        .set('x-request-id', requestId)
        .send(sample.body)
        .expect(202);
      expect(headers.location).toBe(
        `/api/v1/character-operations/${body.commandId}`,
      );
      expect(headers['x-request-id']).toBe(requestId);
      expect(body).toEqual({
        commandId: expect.any(String),
        gameServerId: server.id,
        characterId: sample.payload.characterId,
        type: sample.type,
        status: S.PENDING,
        correlationId: expect.any(String),
        requestId,
        createdAt: clock.now().toISOString(),
      });
      const command = await read(body.commandId);
      expect(command).toMatchObject({
        payload: sample.payload,
        type: sample.type,
        requestedByStaffId: staffIds.get(R.COORDINATOR),
        requestId,
        dispatchAttempts: 0,
      });
      expect(gateway.sends).toHaveLength(0);
      expect(text).not.toMatch(
        /payload|idempotencyKey|dispatchLease|ownership/,
      );
      const entries = await audits(command.id);
      expect(entries).toHaveLength(sample.action ? 1 : 0);
      if (sample.action) {
        expect(entries[0]).toMatchObject({
          action: sample.action,
          outcome: 'SUCCESS',
          resource_type: 'CHARACTER',
          resource_id: sample.payload.characterId,
          actor_staff_id: staffIds.get(R.COORDINATOR),
          request_id: requestId,
          status_code: 202,
          metadata: {
            commandId: command.id,
            gameServerId: server.id,
            correlationId: command.correlationId,
            characterId: sample.payload.characterId,
            operation: sample.type,
            targetId: 'opaque:target-1',
          },
        });
        expect(Object.keys(entries[0].metadata).sort()).toEqual(
          [
            'commandId',
            'gameServerId',
            'correlationId',
            'characterId',
            'operation',
            'targetId',
            ...('quantity' in sample.payload ? ['quantity'] : []),
          ].sort(),
        );
        expect(JSON.stringify(entries[0].metadata)).not.toMatch(
          /idempotency|payload|result|token|headers|authorization|lease/i,
        );
      }
      expect((await get(command.id).expect(200)).body.payload).toEqual(
        sample.payload,
      );
    },
  );
  it.each(CHARACTER_CASES)(
    'allows General Chief to submit and read $type',
    async (sample) => {
      const { body } = await post(sample, randomUUID(), R.GENERAL_CHIEF)
        .send(sample.body)
        .expect(202);
      expect((await read(body.commandId)).requestedByStaffId).toBe(
        staffIds.get(R.GENERAL_CHIEF),
      );
      await get(body.commandId, R.GENERAL_CHIEF).expect(200);
    },
  );
  it.each([R.ADMIN, R.MODERATOR, R.SUPPORT, R.DEV])(
    'denies all Character POSTs/details for %s',
    async (role) => {
      for (const sample of CHARACTER_CASES) {
        const { body } = await post(sample).send(sample.body).expect(202);
        await post(sample, randomUUID(), role).send(sample.body).expect(403);
        await get(body.commandId, role).expect(403);
      }
      expect(await commands().countBy({ gameServerId: server.id })).toBe(17);
    },
  );
  it('rejects anonymous requests on all Character routes', async () => {
    for (const sample of CHARACTER_CASES)
      await http()
        .post(path(sample))
        .set('Idempotency-Key', randomUUID())
        .send(sample.body)
        .expect(401);
    await http()
      .get(`/api/v1/character-operations/${randomUUID()}`)
      .expect(401);
    expect(await commands().countBy({ gameServerId: server.id })).toBe(0);
  });
  it('enforces detail permission by type using live grants, not role or GAME_BRIDGE_READ', async () => {
    const query = (await post(inventory).send({}).expect(202)).body;
    const mutation = (await post(give).send(give.body).expect(202)).body;
    await database.query(
      "DELETE FROM role_permissions WHERE role_name = 'COORDINATOR' AND permission_name = 'CHARACTER_ITEM_GIVE'",
    );
    try {
      await get(query.commandId).expect(200);
      await get(mutation.commandId).expect(403);
      await generic(mutation.commandId, R.COORDINATOR).expect(200);
      await post(give).send(give.body).expect(403);
    } finally {
      await database.query(
        "INSERT INTO role_permissions VALUES ('COORDINATOR', 'CHARACTER_ITEM_GIVE')",
      );
    }
  });
  it('requires Idempotency-Key and rejects unsafe/oversized keys', async () => {
    await http()
      .post(path(give))
      .auth(tokens.get(R.COORDINATOR)!, { type: 'bearer' })
      .send(give.body)
      .expect(400);
    for (const key of ['', 'a b', 'a,b', 'x'.repeat(129)])
      await post(give, key).send(give.body).expect(400);
    expect(await commands().countBy({ gameServerId: server.id })).toBe(0);
  });
  it('replays canonically equivalent HTTP payloads without new audit, attribution or dispatch', async () => {
    const key = randomUUID();
    const first = await post(give, key)
      .set('x-request-id', 'original')
      .send(give.body)
      .expect(202);
    // Let the operational dispatcher attempt unavailable delivery once.
    await dispatcher.dispatch(first.body.commandId);
    const before = await read(first.body.commandId);
    const second = await post(give, key, R.GENERAL_CHIEF)
      .set('x-request-id', 'retry')
      .send({ quantity: 2, itemId: 'opaque:target-1' })
      .expect(202);
    expect(second.body).toEqual(first.body);
    expect(await read(first.body.commandId)).toEqual(before);
    expect(await audits(first.body.commandId)).toHaveLength(1);
    expect(await commands().countBy({ gameServerId: server.id })).toBe(1);
    expect(gateway.sends).toHaveLength(0);
  });
  it('returns existing terminal operation on retry without new transport/audit', async () => {
    const key = randomUUID();
    const accepted = (await post(give, key).send(give.body).expect(202)).body;
    await connections.connect({
      gameServerId: server.id,
      externalConnectionId: randomUUID(),
    });
    const dispatched = await dispatcher.dispatch(accepted.commandId);
    await receiver.result(message(dispatched, give.result));
    const replay = await post(give, key).send(give.body).expect(202);
    expect(replay.body).toMatchObject({
      commandId: dispatched.id,
      status: S.SUCCEEDED,
      correlationId: dispatched.correlationId,
    });
    expect(gateway.sends).toHaveLength(1);
    expect(await audits(dispatched.id)).toHaveLength(1);
  });
  it('commits Character command and audit before send, releases locks and permits an early RESULT', async () => {
    const { body } = await post(give).send(give.body).expect(202);
    await connections.connect({
      gameServerId: server.id,
      externalConnectionId: randomUUID(),
    });
    let checked = false;
    gateway.beforeSend = async () => {
      // Independent transaction proves creation and reservation released locks.
      await database.transaction(async (manager) => {
        await manager.query(
          'SELECT id FROM game_servers WHERE id = $1 FOR UPDATE NOWAIT',
          [server.id],
        );
        const rows = await manager.query(
          'SELECT id FROM game_commands WHERE id = $1 FOR UPDATE NOWAIT',
          [body.commandId],
        );
        expect(rows).toHaveLength(1);
        expect(
          await manager.query(
            "SELECT id FROM audit_logs WHERE metadata->>'commandId' = $1 AND outcome = 'SUCCESS'",
            [body.commandId],
          ),
        ).toHaveLength(1);
      });
      expect(
        await database.query(
          "SELECT pid FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND state = 'idle in transaction' AND query LIKE '%game_commands%' AND query LIKE '%dispatch_lease%'",
        ),
      ).toEqual([]);
      const reserved = await read(body.commandId);
      await receiver.result(message(reserved, give.result));
      checked = true;
    };
    const completed = await dispatcher.dispatch(body.commandId);
    // send catches transport errors, so assert the callback actually completed.
    expect(checked).toBe(true);
    expect(completed.status).toBe(S.SUCCEEDED);
    expect(completed.dispatchLeaseId).toBeNull();
    expect(await audits(completed.id)).toHaveLength(1);
  });
  it('rejects reused keys with different payload, type or character without another audit', async () => {
    const key = randomUUID();
    const original = (await post(give, key).send(give.body).expect(202)).body;
    await post(give, key)
      .send({ ...give.body, quantity: 3 })
      .expect(409);
    await post(inventory, key).send({}).expect(409);
    await http()
      .post(path(give, server.id, 'other-character'))
      .auth(tokens.get(R.COORDINATOR)!, { type: 'bearer' })
      .set('Idempotency-Key', key)
      .send(give.body)
      .expect(409);
    expect(await commands().countBy({ gameServerId: server.id })).toBe(1);
    expect(await audits(original.commandId)).toHaveLength(1);
  });
  it('serializes concurrent POSTs in PostgreSQL: one command and one atomic audit', async () => {
    const key = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        post(give, key)
          .set('x-request-id', `concurrent-${i}`)
          .send(give.body)
          .expect(202),
      ),
    );
    const ids = new Set(responses.map((r) => r.body.commandId));
    expect(ids.size).toBe(1);
    expect(new Set(responses.map((r) => r.body.correlationId)).size).toBe(1);
    const command = await read(responses[0].body.commandId);
    const entries = await audits(command.id);
    expect(entries).toHaveLength(1);
    expect(entries[0].request_id).toBe(command.requestId);
    expect(await commands().countBy({ gameServerId: server.id })).toBe(1);
    expect(gateway.sends).toHaveLength(0);
  });
  it('serializes conflicting concurrent POSTs with one accepted winner', async () => {
    const key = randomUUID();
    const responses = await Promise.all([
      post(give, key).send(give.body),
      post(give, key).send({ ...give.body, quantity: 3 }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([202, 409]);
    const winner = responses.find((r) => r.status === 202)!;
    expect(await audits(winner.body.commandId)).toHaveLength(1);
    expect(await commands().countBy({ gameServerId: server.id })).toBe(1);
  });
  it('rolls back command creation if Audit SUCCESS fails and permits a later safe retry', async () => {
    const key = randomUUID();
    const requestId = randomUUID();
    await database.query(
      `ALTER TABLE audit_logs ADD CONSTRAINT character_test_audit_failure CHECK (request_id <> '${requestId}')`,
    );
    try {
      await post(give, key)
        .set('x-request-id', requestId)
        .send(give.body)
        .expect(503);
      expect(await commands().countBy({ gameServerId: server.id })).toBe(0);
      expect(
        await database.query('SELECT * FROM audit_logs WHERE request_id = $1', [
          requestId,
        ]),
      ).toEqual([]);
      expect(gateway.sends).toHaveLength(0);
    } finally {
      await database.query(
        'ALTER TABLE audit_logs DROP CONSTRAINT character_test_audit_failure',
      );
    }
    const accepted = await post(give, key)
      .set('x-request-id', requestId)
      .send(give.body)
      .expect(202);
    expect(await audits(accepted.body.commandId)).toHaveLength(1);
  });
  it('rejects nonexistent/disabled servers and permits offline or stale enabled servers without execution success', async () => {
    await http()
      .post(path(give, randomUUID()))
      .auth(tokens.get(R.COORDINATOR)!, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send(give.body)
      .expect(404);
    await database
      .getRepository<GameServer>('GameServer')
      .update(server.id, { enabled: false });
    await post(give).send(give.body).expect(409);
    expect(await commands().countBy({ gameServerId: server.id })).toBe(0);
    await database
      .getRepository<GameServer>('GameServer')
      .update(server.id, { enabled: true });
    const offline = await post(give).send(give.body).expect(202);
    expect(offline.body.status).toBe(S.PENDING);
    const conn = await connections.connect({
      gameServerId: server.id,
      externalConnectionId: randomUUID(),
    });
    await database.query(
      'UPDATE game_connections SET last_heartbeat_at = $1 WHERE id = $2',
      [new Date(clock.now().getTime() - 3600001), conn.id],
    );
    expect((await post(inventory).send({}).expect(202)).body.status).toBe(
      S.PENDING,
    );
    expect(gateway.sends).toHaveLength(0);
  });
  it('normalizes opaque route/body identifiers and rejects route or attribution mass assignment', async () => {
    const response = await http()
      .post(path(give, server.id, '  personagem:á /42  '))
      .auth(tokens.get(R.COORDINATOR)!, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ itemId: '  plugin:esp/42  ', quantity: 1 })
      .expect(202);
    expect((await read(response.body.commandId)).payload).toEqual({
      characterId: 'personagem:á /42',
      itemId: 'plugin:esp/42',
      quantity: 1,
    });
    for (const extra of [
      { requestedByStaffId: randomUUID() },
      { requestId: 'forged' },
      { characterId: 'other' },
      { serverId: randomUUID() },
      { type: 'CHARACTER_ITEM_GIVE' },
      { command: 'raw' },
      { payload: {} },
      { script: 'x' },
      { args: [] },
    ])
      await post(give)
        .send({ ...give.body, ...extra })
        .expect(400);
    await post(inventory).send({ rawCommand: 'x' }).expect(400);
  });
  it.each([0, -1, 1.5, 10001, '1', null])(
    'rejects invalid quantity %s',
    async (quantity) => {
      await post(give).send({ itemId: 'i', quantity }).expect(400);
    },
  );
  it.each(['', ' ', 'x'.repeat(129), 'x\n', 'x\u0000'])(
    'rejects invalid external body identifier %#',
    async (itemId) => {
      await post(give).send({ itemId, quantity: 1 }).expect(400);
    },
  );
  it('validates route identifiers and returns 404 for missing/non-character operations', async () => {
    for (const serverId of ['not-uuid', '00000000'])
      await http()
        .post(path(give, serverId))
        .auth(tokens.get(R.COORDINATOR)!, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send(give.body)
        .expect(400);
    for (const char of [' ', 'x'.repeat(129), 'x\n'])
      await http()
        .post(path(give, server.id, char))
        .auth(tokens.get(R.COORDINATOR)!, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send(give.body)
        .expect(400);
    await get('invalid').expect(400);
    await get(randomUUID()).expect(404);
    const ping = await bus.submit({
      gameServerId: server.id,
      type: 'BRIDGE_PING',
      payload: { nonce: 'ping' },
      idempotencyKey: randomUUID(),
    });
    await get(ping.id).expect(404);
  });
  it.each(CHARACTER_CASES)(
    'validates, persists and exposes typed RESULT for $type',
    async (sample) => {
      const command = await dispatched(sample);
      expect(command.status).toBe(S.DISPATCHED);
      await receiver.result(message(command, sample.result));
      const response = await get(command.id).expect(200);
      expect(response.body).toMatchObject({
        status: S.SUCCEEDED,
        payload: sample.payload,
        result: { outcome: S.SUCCEEDED, result: sample.result },
      });
      expect(response.text).not.toMatch(
        /idempotencyKey|dispatchLease|ownership/,
      );
      await receiver.result(message(command, sample.result));
      expect(await results().countBy({ gameCommandId: command.id })).toBe(1);
      if (sample.type === 'CHARACTER_INVENTORY_QUERY')
        await expect(
          receiver.result(
            message(command, { characterId: 'opaque:character-42', items: [] }),
          ),
        ).rejects.toThrow('another result');
    },
  );
  it('rejects invalid, mismatched and oversized results without changing lifecycle or persisting arbitrary JSON', async () => {
    const command = await dispatched(inventory);
    for (const result of [
      { anything: [] },
      { characterId: 'other', items: [] },
      {
        characterId: 'opaque:character-42',
        items: [{ itemId: 'i', quantity: 0 }],
      },
      {
        characterId: 'opaque:character-42',
        items: Array.from({ length: 512 }, () => ({
          itemId: 'i'.repeat(128),
          quantity: 1,
          displayName: 'n'.repeat(128),
        })),
      },
    ]) {
      await expect(receiver.result(message(command, result))).rejects.toThrow();
      expect((await read(command.id)).status).toBe(S.DISPATCHED);
      expect(await results().countBy({ gameCommandId: command.id })).toBe(0);
    }
  });
  it('rejects query results for another type and mutation results for another target in PostgreSQL', async () => {
    for (const sample of CHARACTER_CASES) {
      const command = await dispatched(sample);
      const invalid = sample.action
        ? { ...sample.result, targetId: 'wrong-target' }
        : sample.type === 'CHARACTER_INVENTORY_QUERY'
          ? CHARACTER_CASES[3].result
          : inventory.result;
      await expect(
        receiver.result(message(command, invalid)),
      ).rejects.toThrow();
      expect((await read(command.id)).status).toBe(S.DISPATCHED);
      expect(await results().countBy({ gameCommandId: command.id })).toBe(0);
    }
  });
  it('accepts inventory above 4 KiB, preserves duplicate result semantics and enforces 64 KiB in PostgreSQL', async () => {
    const command = await dispatched(inventory);
    const result = {
      characterId: 'opaque:character-42',
      items: Array.from({ length: 80 }, (_, i) => ({
        itemId: String(i),
        quantity: 1,
        displayName: 'x'.repeat(128),
      })),
    };
    expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(4096);
    await receiver.result(message(command, result));
    await receiver.result(
      message(command, {
        items: result.items,
        characterId: result.characterId,
      }),
    );
    expect((await get(command.id).expect(200)).body.result.result).toEqual(
      result,
    );
    expect(await results().countBy({ gameCommandId: command.id })).toBe(1);
    await expect(
      database.query(
        'UPDATE game_command_results SET result = $1 WHERE game_command_id = $2',
        [{ tooLarge: 'x'.repeat(65536) }, command.id],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23514' } });
    // Downgrade refuses existing large results atomically, without deleting them.
    await database.undoLastMigration(); // Etapa 10.3 Player Sessions
    await database.undoLastMigration(); // Etapa 10.2 Generic Actor
    await database.undoLastMigration(); // Etapa 10.1 Player Accounts
    await database.undoLastMigration(); // Etapa 09 Server Control
    await database.undoLastMigration(); // Etapa 08 VIP Store
    await database.undoLastMigration(); // Etapa 07 before testing the Etapa 05 constraint
    await expect(database.undoLastMigration()).rejects.toThrow();
    expect(await database.runMigrations()).toHaveLength(6);
    expect(await database.showMigrations()).toBe(false);
    expect((await get(command.id).expect(200)).body.result.result).toEqual(
      result,
    );
    expect(
      (await database.driver.createSchemaBuilder().log()).upQueries,
    ).toEqual([]);
  });
  it('uses local bounded failure messages and preserves terminal timeout behavior', async () => {
    const command = await dispatched(give);
    const failure: ResultMessage = {
      ...message(command, give.result),
      outcome: S.FAILED,
      errorCode: 'BRIDGE_ERROR',
    };
    await receiver.result(failure);
    expect((await get(command.id).expect(200)).body.result).toMatchObject({
      outcome: S.FAILED,
      result: null,
      errorCode: 'BRIDGE_ERROR',
      errorMessage: 'Bridge reported failure',
    });
    expect((await audits(command.id))[0].outcome).toBe('SUCCESS');
    const late = await dispatched(inventory);
    clock.advance(86400000);
    await receiver.expireCommands();
    expect((await read(late.id)).status).toBe(S.TIMEOUT);
    await expect(
      receiver.result(message(late, inventory.result)),
    ).rejects.toThrow();
    expect((await read(late.id)).status).toBe(S.TIMEOUT);
  });
  it('allows consistent operation polling while RESULT commits', async () => {
    const command = await dispatched(inventory);
    const [response] = await Promise.all([
      get(command.id).expect(200),
      receiver.result(message(command, inventory.result)),
    ]);
    if (response.body.status === S.SUCCEEDED)
      expect(response.body.result.result).toEqual(inventory.result);
    else {
      expect(response.body.status).toBe(S.DISPATCHED);
      expect(response.body.result).toBeNull();
    }
    expect((await get(command.id).expect(200)).body.status).toBe(S.SUCCEEDED);
  });
  it('exposes only operational metadata to Support/DEV and denies Character content on the domain route', async () => {
    for (const sample of CHARACTER_CASES) {
      const command = await dispatched(sample);
      await receiver.result(message(command, sample.result));
      for (const role of [R.SUPPORT, R.DEV]) {
        const { body, text } = await generic(command.id, role).expect(200);
        expect(body).toMatchObject({
          id: command.id,
          type: sample.type,
          status: S.SUCCEEDED,
          result: { outcome: S.SUCCEEDED },
        });
        expect(body).not.toHaveProperty('payload');
        expect(body.result).not.toHaveProperty('result');
        expect(text).not.toMatch(
          /characterId|itemId|inventory|propertyId|holdId|horseId|factionId|titleId|spellId|targetId|items|properties|holds|horses|factions|opaque:|idempotencyKey|dispatchLease|dispatchedConnectionId|ownership/,
        );
        await get(command.id, role).expect(403);
      }
    }
  });
  it('keeps non-null lease fields hidden in both operation reference/detail and generic metadata', async () => {
    const accepted = (await post(inventory).send({}).expect(202)).body;
    const lease = randomUUID();
    await commands().update(accepted.commandId, {
      dispatchLeaseId: lease,
      dispatchLeaseExpiresAt: new Date(clock.now().getTime() + 2000),
    });
    for (const response of [
      await get(accepted.commandId).expect(200),
      await generic(accepted.commandId).expect(200),
    ]) {
      expect(response.text).not.toContain(lease);
      expect(response.text).not.toMatch(
        /dispatchLease|idempotencyKey|ownership/,
      );
    }
  });
  it('documents all typed async endpoints, header, Location and errors without generic execution', async () => {
    const { body } = await http().get('/docs-json').expect(200);
    for (const sample of CHARACTER_CASES) {
      const route =
        body.paths[
          `/api/v1/game-servers/{serverId}/characters/{characterId}/${sample.path}`
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
      for (const code of ['202', '400', '401', '403', '404', '409'])
        expect(route.post.responses).toHaveProperty(code);
      expect(route.post.responses['202'].headers).toHaveProperty('Location');
      expect(route.post.description).toContain(sample.permission);
    }
    expect(
      body.paths['/api/v1/character-operations/{commandId}'].get,
    ).toBeDefined();
    expect(
      body.components.schemas.CommandDetailDto.properties,
    ).not.toHaveProperty('payload');
    expect(
      body.components.schemas.CommandResultDto.properties,
    ).not.toHaveProperty('result');
    expect(
      JSON.stringify(body.components.schemas.CharacterOperationDetailDto),
    ).not.toMatch(/dispatchLease|idempotencyKey/);
    for (const route of [
      '/command',
      '/execute',
      '/console',
      '/game-command',
      '/game-commands',
      '/characters/execute',
    ])
      await http()
        .post(`/api/v1${route}`)
        .auth(tokens.get(R.COORDINATOR)!, { type: 'bearer' })
        .send({ command: 'raw' })
        .expect(404);
    await http()
      .get(path(inventory).replace('/query', ''))
      .auth(tokens.get(R.COORDINATOR)!, { type: 'bearer' })
      .expect(404);
  });
});
