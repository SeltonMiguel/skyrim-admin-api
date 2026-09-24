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
import { moderationCases } from './support/moderation-cases.js';
import type { ModerationCase } from './support/moderation-cases.js';
import { MODERATION_COMMAND_TYPES } from '../src/moderation/moderation-command.contracts.js';

const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;
describeDatabase('Moderation with real PostgreSQL', () => {
  let admin: DataSource, database: DataSource, app: INestApplication<App>;
  let bus: GameCommandBus,
    dispatcher: GameCommandDispatcher,
    receiver: GameCommandReceiver,
    servers: GameServerService,
    connections: GameConnectionService;
  let server: GameServer;
  const gateway = new MockGameGateway();
  const clock = new TestBridgeClock();
  const schema = `moderation_test_${randomUUID().replaceAll('-', '')}`;
  const tokens = new Map<R, string>(),
    staffIds = new Map<R, string>();
  const http = () => request(app.getHttpServer());
  const cases = (role = R.COORDINATOR) => moderationCases(staffIds.get(role)!);
  const path = (sample: ModerationCase, serverId = server.id) =>
    `/api/v1/game-servers/${serverId}/moderation/${sample.path}`;
  const post = (
    sample: ModerationCase,
    key: string = randomUUID(),
    role = R.COORDINATOR,
  ) =>
    http()
      .post(path(sample))
      .auth(tokens.get(role)!, { type: 'bearer' })
      .set('Idempotency-Key', key);
  const get = (id: string, role = R.COORDINATOR) =>
    http()
      .get(`/api/v1/moderation-operations/${id}`)
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
  async function dispatched(sample: ModerationCase) {
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
    expect(await database.runMigrations()).toHaveLength(17);
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
    const password = 'Moderation-Test-Password-42';
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
      name: 'Moderation test',
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
  it('reuses the schema and existing grants without moderation tables or pending migrations', async () => {
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
  it.each(MODERATION_COMMAND_TYPES)(
    'accepts %s with 202, Location, authenticated attribution and exactly one safe audit',
    async (type) => {
      const sample = cases().find((c) => c.type === type)!;
      const requestId = randomUUID();
      const { body, headers, text } = await post(sample)
        .set('x-request-id', requestId)
        .send(sample.body)
        .expect(202);
      expect(headers.location).toBe(
        `/api/v1/moderation-operations/${body.commandId}`,
      );
      expect(body).toMatchObject({
        type,
        status: S.PENDING,
        requestId,
        gameServerId: server.id,
      });
      expect(text).not.toMatch(
        /payload|reason|message|playerId|actorStaffId|targetPlayerId|idempotencyKey|dispatchLease/,
      );
      const command = await read(body.commandId);
      expect(command).toMatchObject({
        payload: sample.payload,
        requestedByStaffId: staffIds.get(R.COORDINATOR),
        dispatchAttempts: 0,
      });
      const entries = await audits(command.id);
      expect(entries).toHaveLength(1);
      const payload = sample.payload;
      expect(entries[0]).toMatchObject({
        action: sample.action,
        outcome: 'SUCCESS',
        resource_type: 'MODERATION',
        resource_id: command.id,
        status_code: 202,
        actor_staff_id: staffIds.get(R.COORDINATOR),
        request_id: requestId,
      });
      expect(entries[0].metadata).toEqual({
        gameServerId: server.id,
        commandId: command.id,
        correlationId: command.correlationId,
        ...('playerId' in payload ? { playerId: payload.playerId } : {}),
        ...('actorStaffId' in payload
          ? { actorStaffId: payload.actorStaffId }
          : {}),
        ...('targetPlayerId' in payload
          ? { targetPlayerId: payload.targetPlayerId }
          : {}),
        ...('enabled' in payload ? { enabled: payload.enabled } : {}),
      });
      expect(JSON.stringify(entries)).not.toMatch(
        /private ban reason|private announcement text|idempotencyKey|dispatchLease|Authorization|Bearer/,
      );
      expect((await get(command.id).expect(200)).body.payload).toEqual(
        sample.payload,
      );
      expect(gateway.sends).toHaveLength(0);
    },
  );
  it.each(Object.values(R))(
    'enforces the complete POST and operation detail permission matrix for %s',
    async (role) => {
      // Independent expected matrix, not derived from the production policy/grants.
      const allowed =
        role === R.DEV
          ? []
          : role === R.SUPPORT
            ? ['PLAYER_TELEPORT_TO_STAFF']
            : role === R.MODERATOR
              ? [
                  'STAFF_NOCLIP_SET',
                  'STAFF_INVISIBILITY_SET',
                  'ANNOUNCEMENT_SEND',
                  'STAFF_TELEPORT_TO_PLAYER',
                  'PLAYER_TELEPORT_TO_STAFF',
                ]
              : MODERATION_COMMAND_TYPES;
      for (const sample of cases(role)) {
        const authorized = allowed.includes(sample.type);
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
        expect(await audits(id)).toHaveLength(1);
      }
      expect(await commands().countBy({ gameServerId: server.id })).toBe(8);
    },
  );
  it('derives operation permission from current grants and stored command type', async () => {
    const ban = (await post(cases()[0]).send({}).expect(202)).body;
    const teleport = (
      await post(cases(R.SUPPORT)[7], randomUUID(), R.SUPPORT)
        .send({})
        .expect(202)
    ).body;
    await get(ban.commandId, R.SUPPORT).expect(403);
    await get(teleport.commandId, R.SUPPORT).expect(200);
    await database.query(
      "DELETE FROM role_permissions WHERE role_name = 'SUPPORT' AND permission_name = 'PLAYER_TELEPORT_TO_STAFF'",
    );
    try {
      await get(teleport.commandId, R.SUPPORT).expect(403);
      await generic(teleport.commandId).expect(200);
      await post(cases(R.SUPPORT)[7], randomUUID(), R.SUPPORT)
        .send({})
        .expect(403);
    } finally {
      await database.query(
        "INSERT INTO role_permissions VALUES ('SUPPORT', 'PLAYER_TELEPORT_TO_STAFF')",
      );
    }
  });
  it('rejects anonymous access and all attempts to choose staff, command type or attribution', async () => {
    for (const sample of cases()) {
      await http().post(path(sample)).send(sample.body).expect(401);
      for (const extra of [
        { actorStaffId: randomUUID() },
        { staffId: randomUUID() },
        { requestedByStaffId: randomUUID() },
        { type: 'PLAYER_BAN' },
        { rawCommand: 'x' },
        { script: 'x' },
        { payload: {} },
        { requestId: 'forged' },
      ])
        await post(sample)
          .send({ ...sample.body, ...extra })
          .expect(400);
    }
    await http()
      .get(`/api/v1/moderation-operations/${randomUUID()}`)
      .expect(401);
    expect(await commands().countBy({ gameServerId: server.id })).toBe(0);
  });
  it.each([true, false])(
    'accepts explicit enabled=%s and rejects toggle/coercion for all SET operations',
    async (enabled) => {
      for (const sample of cases().filter((c) => 'enabled' in c.payload)) {
        const { body } = await post(sample).send({ enabled }).expect(202);
        expect((await read(body.commandId)).payload).toEqual({
          ...sample.payload,
          enabled,
        });
        await connections.connect({
          gameServerId: server.id,
          externalConnectionId: randomUUID(),
        });
        const command = await dispatcher.dispatch(body.commandId);
        await expect(
          receiver.result(
            message(command, { ...sample.result, enabled: !enabled }),
          ),
        ).rejects.toThrow();
        await receiver.result(message(command, { ...sample.result, enabled }));
        expect(
          (await get(command.id).expect(200)).body.result.result.enabled,
        ).toBe(enabled);
        for (const invalid of ['true', 'false', 0, 1, null])
          await post(sample).send({ enabled: invalid }).expect(400);
        await post(sample).send({}).expect(400);
        await post(sample).send({ toggle: true }).expect(400);
      }
    },
  );
  it('validates optional reasons and literal announcements at 500 characters without leaking text into audits', async () => {
    for (const sample of [cases()[0], cases()[1], cases()[5]]) {
      const field = sample.type === 'ANNOUNCEMENT_SEND' ? 'message' : 'reason';
      const { body } = await post(sample)
        .send({ [field]: `  ${'á'.repeat(500)}  ` })
        .expect(202);
      expect((await read(body.commandId)).payload).toMatchObject({
        [field]: 'á'.repeat(500),
      });
      expect(JSON.stringify(await audits(body.commandId))).not.toContain(
        'á'.repeat(500),
      );
      for (const value of [
        '',
        ' ',
        'x'.repeat(501),
        'x\n',
        '\u0000',
        '\ud800',
        null,
        1,
      ])
        await post(sample)
          .send({ [field]: value })
          .expect(400);
    }
    await post(cases()[0]).send({}).expect(202);
    await post(cases()[5]).send({}).expect(400);
  });
  it('requires a safe idempotency key and rejects malformed routes', async () => {
    const sample = cases()[0];
    await http()
      .post(path(sample))
      .auth(tokens.get(R.COORDINATOR)!, { type: 'bearer' })
      .send({})
      .expect(400);
    for (const key of ['', 'a b', 'a,b', 'x'.repeat(129)])
      await post(sample, key).send({}).expect(400);
    for (const serverId of ['invalid', '0000'])
      await http()
        .post(path(sample, serverId))
        .auth(tokens.get(R.COORDINATOR)!, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({})
        .expect(400);
    for (const player of [' ', 'x'.repeat(129), 'x\n'])
      await http()
        .post(
          path(sample).replace('opaque:player-42', encodeURIComponent(player)),
        )
        .auth(tokens.get(R.COORDINATOR)!, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({})
        .expect(400);
    expect(await commands().countBy({ gameServerId: server.id })).toBe(0);
  });
  it.each(MODERATION_COMMAND_TYPES)(
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
      expect(await audits(first.commandId)).toHaveLength(1);
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
      expect(await audits(command.id)).toHaveLength(1);
    },
  );
  it('canonicalizes equivalent payloads and rejects conflicts in type, payload, player or authenticated self', async () => {
    const key = randomUUID(),
      ban = cases()[0];
    const first = (
      await post(ban, key)
        .set('x-request-id', 'original')
        .send({ reason: ' reason ' })
        .expect(202)
    ).body;
    const replay = await post(ban, key, R.ADMIN)
      .send({ reason: 'reason' })
      .expect(202);
    expect(replay.body).toEqual(first);
    expect((await read(first.commandId)).requestedByStaffId).toBe(
      staffIds.get(R.COORDINATOR),
    );
    await post(ban, key).send({ reason: 'different' }).expect(409);
    await post(cases()[1], key).send({ reason: 'reason' }).expect(409);
    await http()
      .post(path(ban).replace('opaque:player-42', 'other-player'))
      .auth(tokens.get(R.COORDINATOR)!, { type: 'bearer' })
      .set('Idempotency-Key', key)
      .send({ reason: 'reason' })
      .expect(409);
    const selfKey = randomUUID();
    await post(cases()[3], selfKey).send({ enabled: true }).expect(202);
    await post(cases(R.ADMIN)[3], selfKey, R.ADMIN)
      .send({ enabled: true })
      .expect(409);
    const entries = await audits(first.commandId);
    expect(entries).toHaveLength(1);
    expect(await commands().countBy({ gameServerId: server.id })).toBe(2);
    expect(gateway.sends).toHaveLength(0);
  });
  it('accepts one concurrent conflicting winner with exactly one audit', async () => {
    const key = randomUUID(),
      sample = cases()[0];
    const responses = await Promise.all([
      post(sample, key).send({ reason: 'a' }),
      post(sample, key).send({ reason: 'b' }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([202, 409]);
    const id = responses.find((r) => r.status === 202)!.body.commandId;
    expect(await audits(id)).toHaveLength(1);
    expect(await commands().countBy({ gameServerId: server.id })).toBe(1);
  });
  it.each(MODERATION_COMMAND_TYPES)(
    'rolls back %s completely if Audit fails and permits a safe retry',
    async (type) => {
      const sample = cases().find((c) => c.type === type)!,
        key = randomUUID(),
        requestId = randomUUID();
      await database.query(
        `ALTER TABLE audit_logs ADD CONSTRAINT moderation_test_audit_failure CHECK (request_id <> '${requestId}')`,
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
          'ALTER TABLE audit_logs DROP CONSTRAINT moderation_test_audit_failure',
        );
      }
      const { body } = await post(sample, key).send(sample.body).expect(202);
      expect(await audits(body.commandId)).toHaveLength(1);
    },
  );
  it('rejects missing/disabled servers and accepts enabled offline/stale without execution success', async () => {
    const sample = cases()[0];
    await http()
      .post(path(sample, randomUUID()))
      .auth(tokens.get(R.COORDINATOR)!, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(404);
    await database
      .getRepository<GameServer>('GameServer')
      .update(server.id, { enabled: false });
    await post(sample).send({}).expect(409);
    expect(await commands().countBy({ gameServerId: server.id })).toBe(0);
    await database
      .getRepository<GameServer>('GameServer')
      .update(server.id, { enabled: true });
    const key = randomUUID();
    const offline = await post(sample, key).send({}).expect(202);
    expect(offline.body.status).toBe(S.PENDING);
    const conn = await connections.connect({
      gameServerId: server.id,
      externalConnectionId: randomUUID(),
    });
    await database.query(
      'UPDATE game_connections SET last_heartbeat_at = $1 WHERE id = $2',
      [new Date(clock.now().getTime() - 3600001), conn.id],
    );
    expect((await post(sample).send({}).expect(202)).body.status).toBe(
      S.PENDING,
    );
    await database
      .getRepository<GameServer>('GameServer')
      .update(server.id, { enabled: false });
    await post(sample, key).send({}).expect(409);
    expect(await commands().countBy({ gameServerId: server.id })).toBe(2);
    expect(await audits(offline.body.commandId)).toHaveLength(1);
    expect(gateway.sends).toHaveLength(0);
  });
  it.each(MODERATION_COMMAND_TYPES)(
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
          /playerId|actorStaffId|targetPlayerId|reason|message|enabled|opaque:|private|idempotencyKey|dispatchLease|dispatchedConnectionId|ownership/,
        );
      }
    },
  );
  it('commits command and Audit before send, releases locks and permits a result during gateway I/O', async () => {
    const sample = cases()[0];
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
    const sample = cases()[0],
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
  it('documents all eight fixed routes, required key, 202 schema, Location and dynamic detail without an execution endpoint', async () => {
    const { body } = await http().get('/docs-json').expect(200);
    for (const sample of cases()) {
      const path = `/api/v1/game-servers/{serverId}/moderation/${sample.path.replace('opaque:player-42', '{playerId}')}`;
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
      ).toContain('ModerationOperationReferenceDto');
      expect(route.post.description).toContain(sample.permission);
    }
    expect(
      body.paths['/api/v1/moderation-operations/{commandId}'].get,
    ).toBeDefined();
    for (const dto of [
      'BanBodyDto',
      'ModeBodyDto',
      'AnnouncementBodyDto',
      'TeleportBodyDto',
      'EmptyModerationBodyDto',
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
        .post(`/api/v1/game-servers/${server.id}/moderation/${suffix}`)
        .auth(tokens.get(R.COORDINATOR)!, { type: 'bearer' })
        .send({ command: 'x' })
        .expect(404);
  });
});
