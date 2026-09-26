import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
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
import { RoleName as R } from '../src/rbac/roles.js';
import { GameServerService } from '../src/game-bridge/game-server.service.js';
import { GameConnectionService } from '../src/game-bridge/game-connection.service.js';
import type { GameServer } from '../src/game-bridge/entities/game-server.entity.js';
import type { GameConnection } from '../src/game-bridge/entities/game-connection.entity.js';
import { DiscordIdentityProvider } from '../src/player-auth/discord-identity.provider.js';
import { PlayerAuthRateLimiter } from '../src/player-auth/player-auth-rate-limit.js';
import { AgentSessionRegistry } from '../src/game-agent/agent-session.registry.js';
import { agentSecretHash } from '../src/game-agent/agent-credential.contracts.js';
import { FakeDiscordProvider } from './support/fake-discord-provider.js';
import { RealtimeTestClient } from './support/realtime-client.js';

const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;
interface Credential {
  credentialId: string;
  credentialSecret: string;
  gameServerId: string;
  status: string;
  createdAt: string;
}
type Frame = Record<string, unknown> & { payload?: Record<string, unknown> };
const AUTHORIZED = [R.COORDINATOR, R.DEV];
// Polls asynchronous (database) state; the client's until() is synchronous.
async function eventually<T>(
  check: () => Promise<T | undefined | false>,
  timeoutMs = 3000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for state');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
describeDatabase('Host Agent transport with real PostgreSQL', () => {
  let admin: DataSource, database: DataSource, app: INestApplication<App>;
  let registry: AgentSessionRegistry, connections: GameConnectionService;
  let servers: GameServerService, server: GameServer, url: string;
  const clients: RealtimeTestClient[] = [];
  const discord = new FakeDiscordProvider();
  const tokens = new Map<R, string>();
  const schema = `game_agent_test_${randomUUID().replaceAll('-', '')}`;
  const http = () => request(app.getHttpServer());
  const base = (serverId = server.id) =>
    `/api/v1/admin/game-servers/${serverId}/agent-credentials`;
  const create = (serverId = server.id, role = R.COORDINATOR) =>
    http().post(base(serverId)).auth(tokens.get(role)!, { type: 'bearer' });
  const revoke = (credentialId: string, serverId = server.id) =>
    http()
      .post(`${base(serverId)}/${credentialId}/revoke`)
      .auth(tokens.get(R.COORDINATOR)!, { type: 'bearer' });
  const credential = async (serverId = server.id): Promise<Credential> =>
    (await create(serverId).expect(201)).body;
  const rows = (serverId = server.id) =>
    database
      .getRepository<GameConnection>('GameConnection')
      .find({ where: { gameServerId: serverId }, order: { createdAt: 'ASC' } });
  const row = (id: string) =>
    database
      .getRepository<GameConnection>('GameConnection')
      .findOneByOrFail({ id });
  const audits = (credentialId: string) =>
    database.query(
      "SELECT * FROM audit_logs WHERE resource_type = 'GAME_AGENT_CREDENTIAL' AND resource_id = $1 ORDER BY created_at",
      [credentialId],
    );
  const client = (path = '/api/v1/agent', target = url) => {
    const created = new RealtimeTestClient(`${target}${path}`);
    clients.push(created);
    return created;
  };
  const envelope = (
    type: string,
    payload: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
  ): Frame => ({
    protocolVersion: '1',
    type,
    messageId: randomUUID(),
    gameServerId: server.id,
    occurredAt: new Date().toISOString(),
    payload,
    ...overrides,
  });
  const hello = (
    key: Pick<Credential, 'credentialId' | 'credentialSecret'>,
    payload: Record<string, unknown> = {},
    overrides: Record<string, unknown> = {},
  ) =>
    envelope(
      'HELLO',
      {
        credentialId: key.credentialId,
        credentialSecret: key.credentialSecret,
        agentVersion: '1.0.0',
        capabilities: ['BRIDGE_PING', 'SERVER_START'],
        gameProcessState: 'STOPPED',
        skseReady: false,
        ...payload,
      },
      overrides,
    );
  const outcome = (socket: RealtimeTestClient) =>
    socket.until(
      () =>
        (socket.messages.find((m) => m.type === 'AUTHENTICATED') as Frame) ??
        (socket.closed ? { closed: socket.closed } : undefined),
    );
  const connect = async (
    key: Pick<Credential, 'credentialId' | 'credentialSecret'>,
    payload: Record<string, unknown> = {},
    overrides: Record<string, unknown> = {},
    target = url,
  ) => {
    const socket = client('/api/v1/agent', target);
    await socket.open();
    socket.send(hello(key, payload, overrides));
    return { socket, result: await outcome(socket) };
  };
  const authenticated = async (key: Credential) => {
    const { socket, result } = await connect(key);
    expect(result).toMatchObject({ type: 'AUTHENTICATED' });
    return {
      socket,
      connectionId: (result as Frame).payload!.connectionId as string,
    };
  };
  const reply = (socket: RealtimeTestClient, messageId: string) =>
    socket.until(
      () =>
        socket.messages.find(
          (m) => (m.payload as Frame | undefined)?.inReplyTo === messageId,
        ) as Frame | undefined,
    );
  const setEnabled = (serverId: string, enabled: boolean) =>
    database.query('UPDATE game_servers SET enabled = $2 WHERE id = $1', [
      serverId,
      enabled,
    ]);
  const bootApp = async (dataSource: DataSource) => {
    const { AppModule } = await import('../src/app.module.js');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DataSource)
      .useValue(dataSource)
      .overrideProvider(DiscordIdentityProvider)
      .useValue(discord)
      .compile();
    const created = module.createNestApplication(new AppExpressAdapter());
    created.useLogger(false);
    setupApp(created);
    await created.listen(0, '127.0.0.1');
    const address = (
      created.getHttpServer() as unknown as Server
    ).address() as AddressInfo;
    return { created, url: `ws://127.0.0.1:${address.port}` };
  };
  const schemaSource = async (
    options: ReturnType<typeof createDatabaseOptions>,
  ) =>
    new DataSource({
      ...options,
      schema,
      ...(await compiledDatabaseArtifacts()),
      extra: { ...options.extra, options: `-c search_path=${schema},public` },
    } as ConstructorParameters<typeof DataSource>[0]);

  beforeAll(async () => {
    // Short windows for the timeout tests; read when the app config loads.
    process.env.AGENT_AUTH_TIMEOUT_MS = '300';
    process.env.AGENT_HEARTBEAT_INTERVAL = '1s';
    process.env.AGENT_HEARTBEAT_TIMEOUT = '3s';
    const options = createDatabaseOptions(loadEnvironment());
    if (options.type !== 'postgres') throw new Error('PostgreSQL required');
    admin = new DataSource(options);
    await admin.initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    database = await schemaSource(options);
    await database.initialize();
    expect(await database.runMigrations()).toHaveLength(27);
    expect(await database.runMigrations()).toHaveLength(0);
    ({ created: app, url } = await bootApp(database));
    registry = app.get(AgentSessionRegistry);
    connections = app.get(GameConnectionService);
    servers = app.get(GameServerService);
    const password = 'Game-Agent-Test-Password-42';
    const hash = await new PasswordService().hash(password);
    for (const role of Object.values(R)) {
      await database.query(
        'INSERT INTO staff_users(username, display_name, password_hash, role_name) VALUES ($1,$2,$3,$4)',
        [role.toLowerCase(), role, hash, role],
      );
      const { body } = await http()
        .post('/api/v1/auth/login')
        .send({ username: role.toLowerCase(), password })
        .expect(200);
      tokens.set(role, body.accessToken);
    }
  }, 60000);
  beforeEach(async () => {
    app.get(PlayerAuthRateLimiter).reset();
    server = await servers.register({ code: randomUUID(), name: 'Agent' });
  });
  afterEach(async () => {
    const open = clients.splice(0);
    for (const socket of open) if (!socket.closed) await socket.close();
    if (open.length)
      await open[0].until(() => registry.count() === 0 || undefined);
  });
  afterAll(async () => {
    delete process.env.AGENT_AUTH_TIMEOUT_MS;
    delete process.env.AGENT_HEARTBEAT_INTERVAL;
    delete process.env.AGENT_HEARTBEAT_TIMEOUT;
    await app?.close();
    if (database?.isInitialized) await database.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  it('adds one migration: credentials, session columns and a COORDINATOR/DEV permission; reverts and reapplies', async () => {
    expect(database.options.synchronize).toBe(false);
    expect(await database.showMigrations()).toBe(false);
    expect(
      (await database.driver.createSchemaBuilder().log()).upQueries,
    ).toEqual([]);
    expect(await database.query('SELECT * FROM migrations')).toHaveLength(27);
    expect(await database.query('SELECT * FROM permissions')).toHaveLength(45);
    expect(await database.query('SELECT * FROM role_permissions')).toHaveLength(
      116,
    );
    expect(
      await database.query(
        "SELECT role_name FROM role_permissions WHERE permission_name = 'GAME_AGENT_CREDENTIAL_MANAGE' ORDER BY role_name",
      ),
    ).toEqual([{ role_name: 'COORDINATOR' }, { role_name: 'DEV' }]);
    const columns = () =>
      database.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'game_connections' AND column_name IN ('credential_id', 'capabilities', 'game_process_state', 'skse_ready') ORDER BY column_name",
        [schema],
      );
    expect(await columns()).toHaveLength(4);
    await database.undoLastMigration(); // Etapa 12.5 Multi-instance
    await database.undoLastMigration(); // Etapa 12.4 Operational Recovery
    await database.undoLastMigration(); // Etapa 11.4 Agent Domain Events
    await database.undoLastMigration(); // Etapa 11.3 Server Control Transport
    await database.undoLastMigration();
    expect(
      await database.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename = 'game_agent_credentials'",
        [schema],
      ),
    ).toEqual([]);
    expect(await columns()).toEqual([]);
    expect(await database.query('SELECT * FROM permissions')).toHaveLength(36);
    expect(await database.query('SELECT * FROM role_permissions')).toHaveLength(
      93,
    );
    expect(await database.runMigrations()).toHaveLength(5);
    expect(await database.runMigrations()).toHaveLength(0);
    expect(
      (await database.driver.createSchemaBuilder().log()).upQueries,
    ).toEqual([]);
  });

  describe('Staff credential API', () => {
    it('is limited to COORDINATOR and DEV; anonymous, Player and Agent credentials are rejected', async () => {
      for (const role of Object.values(R))
        await http()
          .get(base())
          .auth(tokens.get(role)!, { type: 'bearer' })
          .expect(AUTHORIZED.includes(role) ? 200 : 403);
      for (const role of Object.values(R).filter(
        (r) => !AUTHORIZED.includes(r),
      )) {
        await create(server.id, role).expect(403);
        await http()
          .post(`${base()}/${randomUUID()}/revoke`)
          .auth(tokens.get(role)!, { type: 'bearer' })
          .expect(403);
      }
      await http().get(base()).expect(401);
      const code = `code-${randomUUID()}`;
      discord.codes.set(code, { subject: `${Date.now()}`, displayName: 'P' });
      const player = (
        await http()
          .post('/api/v1/player/auth/discord/exchange')
          .send({ authorizationCode: code, redirectUri: 'http://127.0.0.1/cb' })
          .expect(200)
      ).body;
      await http()
        .get(base())
        .auth(player.accessToken, { type: 'bearer' })
        .expect(401);
      // An Agent secret is not an HTTP credential on either surface.
      const key = await credential();
      for (const path of [base(), '/api/v1/player/me', '/api/v1/auth/me'])
        await http()
          .get(path)
          .auth(key.credentialSecret, { type: 'bearer' })
          .expect(401);
      expect(await audits(key.credentialId)).toHaveLength(1);
    });
    it('creates one ACTIVE credential, shows the secret once and stores only its SHA-256', async () => {
      const response = await create(server.id, R.DEV).expect(201);
      expect(response.headers['cache-control']).toBe('no-store');
      const created = response.body as Credential;
      expect(Object.keys(created).sort()).toEqual([
        'createdAt',
        'credentialId',
        'credentialSecret',
        'gameServerId',
        'status',
      ]);
      expect(created).toMatchObject({
        gameServerId: server.id,
        status: 'ACTIVE',
      });
      expect(created.credentialSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const [stored] = await database.query(
        'SELECT * FROM game_agent_credentials WHERE id = $1',
        [created.credentialId],
      );
      expect(stored.secret_hash).toBe(
        agentSecretHash(created.credentialSecret),
      );
      expect(JSON.stringify(stored)).not.toContain(created.credentialSecret);
      expect(stored).toMatchObject({
        game_server_id: server.id,
        status: 'ACTIVE',
        last_used_at: null,
        revoked_at: null,
      });
      const list = await http()
        .get(base())
        .auth(tokens.get(R.COORDINATOR)!, { type: 'bearer' })
        .expect(200);
      expect(list.body.items).toEqual([
        {
          credentialId: created.credentialId,
          gameServerId: server.id,
          status: 'ACTIVE',
          createdAt: created.createdAt,
          lastUsedAt: null,
          revokedAt: null,
        },
      ]);
      expect(JSON.stringify(list.body)).not.toMatch(
        new RegExp(`${created.credentialSecret}|${stored.secret_hash}`),
      );
      const [audit] = await audits(created.credentialId);
      expect(audit).toMatchObject({
        action: 'GAME_AGENT_CREDENTIAL_CREATED',
        actor_type: 'STAFF',
        actor_role: 'DEV',
        outcome: 'SUCCESS',
        status_code: 201,
      });
      expect(audit.resource_id).toBe(created.credentialId);
      expect(audit.metadata).toEqual({
        gameServerId: server.id,
        status: 'ACTIVE',
      });
      expect(JSON.stringify(audit)).not.toMatch(
        new RegExp(`${created.credentialSecret}|${stored.secret_hash}`),
      );
    });
    it('validates the route and body and scopes credentials to their server', async () => {
      await create().send({ secret: 'mine' }).expect(400);
      await create('not-a-uuid').expect(400);
      await create(randomUUID()).expect(404);
      await http()
        .get(base(randomUUID()))
        .auth(tokens.get(R.COORDINATOR)!, { type: 'bearer' })
        .expect(404);
      const key = await credential();
      const other = await servers.register({ code: randomUUID(), name: 'B' });
      await revoke(key.credentialId, other.id).expect(404);
      await revoke(randomUUID()).expect(404);
      const list = await http()
        .get(base(other.id))
        .auth(tokens.get(R.COORDINATOR)!, { type: 'bearer' })
        .expect(200);
      expect(list.body.items).toEqual([]);
    });
    it('keeps at most two ACTIVE credentials and allows rotation', async () => {
      const a = await credential();
      const b = await credential();
      const refused = await create().expect(409);
      expect(refused.body.message).toMatch(/maximum/);
      await revoke(a.credentialId).expect(200);
      const c = await credential();
      const statuses = await database.query(
        'SELECT id, status FROM game_agent_credentials WHERE game_server_id = $1',
        [server.id],
      );
      expect(
        Object.fromEntries(
          statuses.map((s: { id: string; status: string }) => [s.id, s.status]),
        ),
      ).toEqual({
        [a.credentialId]: 'REVOKED',
        [b.credentialId]: 'ACTIVE',
        [c.credentialId]: 'ACTIVE',
      });
    });
    it('revokes once: repeating is a no-op without a second Audit; history is immutable', async () => {
      const key = await credential();
      const first = await revoke(key.credentialId).expect(200);
      expect(first.headers['cache-control']).toBe('no-store');
      expect(first.body).toMatchObject({
        credentialId: key.credentialId,
        status: 'REVOKED',
      });
      expect(first.body.revokedAt).toEqual(expect.any(String));
      const again = await revoke(key.credentialId).expect(200);
      expect(again.body).toEqual(first.body);
      const trail = await audits(key.credentialId);
      expect(trail.map((a: { action: string }) => a.action)).toEqual([
        'GAME_AGENT_CREDENTIAL_CREATED',
        'GAME_AGENT_CREDENTIAL_REVOKED',
      ]);
      expect(trail[1].resource_id).toBe(key.credentialId);
      expect(trail[1].metadata).toEqual({
        gameServerId: server.id,
        status: 'REVOKED',
      });
      for (const sql of [
        "UPDATE game_agent_credentials SET status = 'ACTIVE', revoked_at = NULL WHERE id = $1",
        "UPDATE game_agent_credentials SET secret_hash = repeat('a', 64) WHERE id = $1",
        'DELETE FROM game_agent_credentials WHERE id = $1',
      ])
        await expect(
          database.query(sql, [key.credentialId]),
        ).rejects.toMatchObject({ driverError: { code: '55000' } });
      await expect(
        database.query(
          "INSERT INTO game_agent_credentials(game_server_id, secret_hash) VALUES ($1, 'plaintext')",
          [server.id],
        ),
      ).rejects.toMatchObject({ driverError: { code: '23514' } });
    });
    it('never exceeds two ACTIVE under concurrent creates, also against a concurrent revoke', async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => create()),
      );
      expect(results.map((r) => r.status).sort()).toEqual([
        201, 201, 409, 409, 409, 409, 409, 409,
      ]);
      const active = () =>
        database
          .query(
            "SELECT count(*)::int AS n FROM game_agent_credentials WHERE game_server_id = $1 AND status = 'ACTIVE'",
            [server.id],
          )
          .then(([r]: { n: number }[]) => r.n);
      expect(await active()).toBe(2);
      const victim = results.find((r) => r.status === 201)!.body as Credential;
      const [revoked, ...creates] = await Promise.all([
        revoke(victim.credentialId),
        create(),
        create(),
        create(),
      ]);
      expect(revoked.status).toBe(200);
      // Either the revoke committed first (one create wins) or none did.
      expect(
        creates.filter((r) => r.status === 201).length,
      ).toBeLessThanOrEqual(1);
      expect(creates.every((r) => [201, 409].includes(r.status))).toBe(true);
      expect(await active()).toBeLessThanOrEqual(2);
      expect(await active()).toBe(
        1 + creates.filter((r) => r.status === 201).length,
      );
    });
  });

  describe('Agent WebSocket', () => {
    it('authenticates HELLO, answers with safe session data and records the session', async () => {
      const key = await credential();
      const { socket, result } = await connect(key, {
        agentVersion: '2.3.4',
        capabilities: ['BRIDGE_PING'],
      });
      const authenticatedFrame = result as Frame;
      expect(Object.keys(authenticatedFrame).sort()).toEqual([
        'gameServerId',
        'messageId',
        'occurredAt',
        'payload',
        'protocolVersion',
        'type',
      ]);
      expect(authenticatedFrame).toMatchObject({
        protocolVersion: '1',
        type: 'AUTHENTICATED',
        gameServerId: server.id,
        payload: {
          connectionId: expect.any(String),
          heartbeatIntervalMs: 1000,
          heartbeatTimeoutMs: 3000,
          maxFrameBytes: 131072,
          serverTime: expect.any(String),
        },
      });
      expect(JSON.stringify(socket.messages)).not.toContain(
        key.credentialSecret,
      );
      const connectionId = authenticatedFrame.payload!.connectionId as string;
      expect(registry.getSession(server.id)).toMatchObject({
        connectionId,
        credentialId: key.credentialId,
        agentVersion: '2.3.4',
        capabilities: ['BRIDGE_PING'],
        runtime: { gameProcessState: 'STOPPED', skseReady: false },
      });
      // Connected is not game ready.
      expect(registry.isConnected(server.id)).toBe(true);
      expect(registry.isRuntimeReady(server.id)).toBe(false);
      expect(await row(connectionId)).toMatchObject({
        status: 'CONNECTED',
        credentialId: key.credentialId,
        bridgeVersion: '2.3.4',
        protocolVersion: '1',
        capabilities: ['BRIDGE_PING'],
        gameProcessState: 'STOPPED',
        skseReady: false,
      });
      expect(await connections.isConnectionHealthy(server.id)).toBe(true);
      const [stored] = await database.query(
        'SELECT last_used_at FROM game_agent_credentials WHERE id = $1',
        [key.credentialId],
      );
      expect(stored.last_used_at).toBeInstanceOf(Date);
      // Graceful close by the Agent.
      await socket.close();
      await socket.until(() => !registry.isConnected(server.id) || undefined);
      await eventually(
        async () => (await row(connectionId)).status === 'DISCONNECTED',
      );
      expect(await row(connectionId)).toMatchObject({
        disconnectReason: 'REQUESTED',
      });
    });
    it('rejects unknown, wrong, revoked, foreign and disabled-server credentials without a session', async () => {
      const key = await credential();
      const revokedKey = await credential();
      await revoke(revokedKey.credentialId).expect(200);
      const other = await servers.register({ code: randomUUID(), name: 'X' });
      const foreign = await credential(other.id);
      const cases: [Record<string, unknown>, Record<string, unknown>][] = [
        [{ credentialId: randomUUID() }, {}],
        [{ credentialSecret: foreign.credentialSecret }, {}],
        [
          {
            credentialId: revokedKey.credentialId,
            credentialSecret: revokedKey.credentialSecret,
          },
          {},
        ],
        [
          {
            credentialId: foreign.credentialId,
            credentialSecret: foreign.credentialSecret,
          },
          {},
        ],
        [{}, { gameServerId: randomUUID() }],
      ];
      for (const [payload, overrides] of cases) {
        const { socket, result } = await connect(key, payload, overrides);
        expect(result).toEqual({
          closed: { code: 4001, reason: 'UNAUTHORIZED' },
        });
        expect(socket.messages).toEqual([]);
      }
      await setEnabled(server.id, false);
      try {
        expect((await connect(key)).result).toEqual({
          closed: { code: 4001, reason: 'UNAUTHORIZED' },
        });
      } finally {
        await setEnabled(server.id, true);
      }
      expect(await rows()).toEqual([]);
      expect(await rows(other.id)).toEqual([]);
      expect(registry.count()).toBe(0);
      const [stored] = await database.query(
        'SELECT last_used_at FROM game_agent_credentials WHERE id = $1',
        [key.credentialId],
      );
      expect(stored.last_used_at).toBeNull();
    });
    it('rejects an unsupported protocol version without a session and without fallback', async () => {
      const key = await credential();
      for (const protocolVersion of ['2', '0'])
        expect((await connect(key, {}, { protocolVersion })).result).toEqual({
          closed: { code: 4005, reason: 'PROTOCOL_UNSUPPORTED' },
        });
      expect(await rows()).toEqual([]);
    });
    it('closes sockets that skip, delay or break HELLO', async () => {
      const key = await credential();
      const silent = client();
      await silent.open();
      expect(await silent.closedWith(2000)).toEqual({
        code: 4000,
        reason: 'AUTH_TIMEOUT',
      });
      const frames: unknown[] = [
        'not json',
        envelope('HEARTBEAT', { gameProcessState: 'RUNNING', skseReady: true }),
        { ...hello(key), extra: true },
        hello(key, { credentialSecret: tokens.get(R.COORDINATOR) }),
        hello(key, { gameProcessState: 'CRASHED' }),
        // The realtime AUTH frame means nothing here.
        { type: 'AUTH', surface: 'STAFF', token: tokens.get(R.COORDINATOR) },
      ];
      for (const frame of frames) {
        const socket = client();
        await socket.open();
        socket.send(frame);
        expect(await socket.closedWith()).toEqual({
          code: 4003,
          reason: 'PROTOCOL_ERROR',
        });
      }
      const binary = client();
      await binary.open();
      binary.sendBinary(JSON.stringify(hello(key)));
      expect(await binary.closedWith()).toEqual({
        code: 4003,
        reason: 'PROTOCOL_ERROR',
      });
      // Nothing may follow HELLO before AUTHENTICATED.
      const eager = client();
      await eager.open();
      eager.send(hello(key));
      eager.send(
        envelope('HEARTBEAT', { gameProcessState: 'RUNNING', skseReady: true }),
      );
      expect(await eager.closedWith()).toEqual({
        code: 4003,
        reason: 'PROTOCOL_ERROR',
      });
      await eager.until(() => registry.count() === 0 || undefined);
    });
    it('closes oversized frames before parsing, before and after auth', async () => {
      const key = await credential();
      const big = 'x'.repeat(128 * 1024 + 1);
      const early = client();
      await early.open();
      early.send(big);
      expect((await early.closedWith()).code).toBe(1009);
      const { socket, connectionId } = await authenticated(key);
      socket.send(envelope('DOMAIN_EVENT', { blob: 'y'.repeat(128 * 1024) }));
      expect((await socket.closedWith()).code).toBe(1009);
      await eventually(
        async () => (await row(connectionId)).status === 'DISCONNECTED',
      );
      // A maximal command result (64 KiB) plus envelope still fits.
      const second = await authenticated(key);
      const message = envelope('DOMAIN_EVENT', { blob: 'z'.repeat(65536) });
      second.socket.send(message);
      // Parsed (not closed as oversized), then refused by the typed contract.
      expect(
        (await reply(second.socket, message.messageId as string)).payload,
      ).toMatchObject({ code: 'INVALID_MESSAGE' });
    });
    it('updates the runtime snapshot on HEARTBEAT: connected, then game ready', async () => {
      const key = await credential();
      const { socket, connectionId } = await authenticated(key);
      const before = (await row(connectionId)).lastHeartbeatAt;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const beat = envelope('HEARTBEAT', {
        gameProcessState: 'RUNNING',
        skseReady: true,
        capabilities: ['BRIDGE_PING', 'CHARACTER_PROFILE_QUERY'],
      });
      socket.send(beat);
      const ack = await reply(socket, beat.messageId as string);
      expect(ack).toMatchObject({
        type: 'HEARTBEAT_ACK',
        gameServerId: server.id,
        payload: { serverTime: expect.any(String) },
      });
      expect(registry.isRuntimeReady(server.id)).toBe(true);
      expect(registry.supports(server.id, 'CHARACTER_PROFILE_QUERY')).toBe(
        true,
      );
      const updated = await row(connectionId);
      expect(updated).toMatchObject({
        gameProcessState: 'RUNNING',
        skseReady: true,
        capabilities: ['BRIDGE_PING', 'CHARACTER_PROFILE_QUERY'],
      });
      expect(updated.lastHeartbeatAt.getTime()).toBeGreaterThan(
        before.getTime(),
      );
      // SKSE drops while the process keeps running: not ready any more.
      const drop = envelope('HEARTBEAT', {
        gameProcessState: 'RUNNING',
        skseReady: false,
      });
      socket.send(drop);
      await reply(socket, drop.messageId as string);
      expect(registry.isConnected(server.id)).toBe(true);
      expect(registry.isRuntimeReady(server.id)).toBe(false);
      // Omitted capabilities keep the announced ones.
      expect((await row(connectionId)).capabilities).toEqual([
        'BRIDGE_PING',
        'CHARACTER_PROFILE_QUERY',
      ]);
    });
    it('closes a silent session after the heartbeat timeout as STALE', async () => {
      const key = await credential();
      const { socket, connectionId } = await authenticated(key);
      expect(await socket.closedWith(6000)).toEqual({
        code: 4008,
        reason: 'HEARTBEAT_TIMEOUT',
      });
      expect(registry.isConnected(server.id)).toBe(false);
      expect(await row(connectionId)).toMatchObject({
        status: 'DISCONNECTED',
        disconnectReason: 'STALE',
      });
    }, 10000);
    it('lets the newest connection win: the old one is SUPERSEDED and closed; reconnect gets a new session', async () => {
      const key = await credential();
      const first = await authenticated(key);
      const second = await authenticated(key);
      expect(await first.socket.closedWith()).toEqual({
        code: 4006,
        reason: 'SUPERSEDED',
      });
      expect(registry.getSession(server.id)?.connectionId).toBe(
        second.connectionId,
      );
      expect(await row(first.connectionId)).toMatchObject({
        status: 'DISCONNECTED',
        disconnectReason: 'SUPERSEDED',
      });
      expect(await row(second.connectionId)).toMatchObject({
        status: 'CONNECTED',
      });
      // Messages of the superseded session never reach the new one.
      await second.socket.close();
      await eventually(
        async () =>
          (await row(second.connectionId)).status === 'DISCONNECTED' ||
          undefined,
      );
      const third = await authenticated(key);
      expect(third.connectionId).not.toBe(second.connectionId);
      expect(
        (await rows()).map((r) => [r.id, r.status, r.disconnectReason]),
      ).toEqual([
        [first.connectionId, 'DISCONNECTED', 'SUPERSEDED'],
        [second.connectionId, 'DISCONNECTED', 'REQUESTED'],
        [third.connectionId, 'CONNECTED', null],
      ]);
    });
    it('keeps the ACTIVE session when a newer HELLO fails or rolls back', async () => {
      const key = await credential();
      const other = await credential();
      const a = await authenticated(key);
      // Rejected before any write.
      expect(
        (await connect(other, { credentialSecret: key.credentialSecret }))
          .result,
      ).toEqual({ closed: { code: 4001, reason: 'UNAUTHORIZED' } });
      // A real rollback after the new row and the supersede were written in
      // the transaction: the last_used_at stamp fails (test-only trigger).
      await database.query(`
        CREATE FUNCTION fail_agent_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'forced rollback'; END; $$;
        CREATE TRIGGER fail_agent_stamp BEFORE UPDATE OF last_used_at ON game_agent_credentials
          FOR EACH ROW WHEN (NEW.id = '${other.credentialId}') EXECUTE FUNCTION fail_agent_stamp();
      `);
      try {
        const { socket, result } = await connect(other);
        expect(result).toEqual({
          closed: { code: 4001, reason: 'UNAUTHORIZED' },
        });
        expect(socket.messages).toEqual([]);
      } finally {
        await database.query(
          'DROP TRIGGER fail_agent_stamp ON game_agent_credentials; DROP FUNCTION fail_agent_stamp();',
        );
      }
      expect(a.socket.closed).toBeNull();
      expect(registry.getSession(server.id)?.connectionId).toBe(a.connectionId);
      expect(
        (await rows()).map((r) => [r.id, r.status, r.disconnectReason]),
      ).toEqual([[a.connectionId, 'CONNECTED', null]]);
      // A keeps working.
      const beat = envelope('HEARTBEAT', {
        gameProcessState: 'STOPPED',
        skseReady: false,
      });
      a.socket.send(beat);
      await reply(a.socket, beat.messageId as string);
      // A successful HELLO then wins, and only then is A superseded.
      const b = await authenticated(other);
      expect(await a.socket.closedWith()).toEqual({
        code: 4006,
        reason: 'SUPERSEDED',
      });
      expect(registry.getSession(server.id)?.connectionId).toBe(b.connectionId);
    });
    it('keeps exactly one session when two Agents authenticate at the same time', async () => {
      const key = await credential();
      const results = await Promise.all([connect(key), connect(key)]);
      const winner = await results[0].socket.until(() => {
        const current = registry.getSession(server.id);
        return (
          current &&
          results.some((r) => r.socket.closed?.reason === 'SUPERSEDED') &&
          current
        );
      });
      const live = await rows().then((all) =>
        all.filter((r) => r.status === 'CONNECTED'),
      );
      expect(live.map((r) => r.id)).toEqual([winner.connectionId]);
      expect(results.filter((r) => !r.socket.closed)).toHaveLength(1);
    });
    it('closes the session of a revoked credential immediately, leaving other credentials alone', async () => {
      const keep = await credential();
      const drop = await credential();
      const other = await servers.register({ code: randomUUID(), name: 'Y' });
      const otherKey = await credential(other.id);
      const target = await authenticated(drop);
      const { socket: bystander, result } = await connect(
        otherKey,
        {},
        { gameServerId: other.id },
      );
      expect(result).toMatchObject({ type: 'AUTHENTICATED' });
      await revoke(drop.credentialId).expect(200);
      // Closed by the revocation itself, well before any heartbeat.
      expect(await target.socket.closedWith(500)).toEqual({
        code: 4009,
        reason: 'CREDENTIAL_REVOKED',
      });
      expect(await row(target.connectionId)).toMatchObject({
        status: 'DISCONNECTED',
        disconnectReason: 'CREDENTIAL_REVOKED',
      });
      expect(bystander.closed).toBeNull();
      expect(registry.isConnected(other.id)).toBe(true);
      // The server's other credential still authenticates.
      await authenticated(keep);
      expect((await connect(drop)).result).toEqual({
        closed: { code: 4001, reason: 'UNAUTHORIZED' },
      });
    });
    it('never leaves a live session for a credential revoked concurrently with HELLO', async () => {
      for (let i = 0; i < 5; i++) {
        const key = await credential();
        const [{ socket }] = await Promise.all([
          connect(key),
          revoke(key.credentialId).expect(200),
        ]);
        await socket.closedWith();
        expect([4001, 4009]).toContain(socket.closed!.code);
        await socket.until(
          () =>
            registry.byCredential(key.credentialId).length === 0 || undefined,
        );
        const live = await database.query(
          "SELECT id FROM game_connections WHERE credential_id = $1 AND status = 'CONNECTED'",
          [key.credentialId],
        );
        expect(live).toEqual([]);
      }
    });
    it('closes cross-server frames and protocol violations after auth', async () => {
      const key = await credential();
      const cross = await authenticated(key);
      cross.socket.send(
        envelope(
          'HEARTBEAT',
          { gameProcessState: 'RUNNING', skseReady: true },
          { gameServerId: randomUUID() },
        ),
      );
      expect(await cross.socket.closedWith()).toEqual({
        code: 4010,
        reason: 'SERVER_MISMATCH',
      });
      await eventually(
        async () =>
          (await row(cross.connectionId)).status === 'DISCONNECTED' ||
          undefined,
      );
      expect(await row(cross.connectionId)).toMatchObject({
        disconnectReason: 'CLOSED',
      });
      const frames: unknown[] = [
        'not json',
        envelope('HEARTBEAT', { skseReady: true }),
        hello(key),
        envelope('WORK_ITEMS', {}),
        envelope('COMMAND', {}),
        { ...envelope('ERROR', {}), protocolVersion: '2' },
      ];
      for (const frame of frames) {
        const { socket } = await authenticated(key);
        socket.send(frame);
        expect((await socket.closedWith()).code).toBe(
          (frame as Frame).protocolVersion === '2' ? 4005 : 4003,
        );
      }
    });
    it('refuses malformed typed messages without touching the domain', async () => {
      const key = await credential();
      const { socket } = await authenticated(key);
      const before = await database.query(
        'SELECT (SELECT count(*) FROM game_commands) AS commands, (SELECT count(*) FROM game_command_results) AS results, (SELECT count(*) FROM server_control_operations) AS operations',
      );
      // A malformed COMMAND_RESULT (11.2) is refused and persists nothing.
      const result = envelope('COMMAND_RESULT', {
        commandId: randomUUID(),
        outcome: 'SUCCEEDED',
      });
      socket.send(result);
      expect(await reply(socket, result.messageId as string)).toMatchObject({
        type: 'ERROR',
        payload: { code: 'INVALID_MESSAGE', retryable: false },
      });
      // So is a malformed SERVER_CONTROL_RESULT (11.3).
      const control = envelope('SERVER_CONTROL_RESULT', {
        commandId: randomUUID(),
        outcome: 'SUCCEEDED',
      });
      socket.send(control);
      expect(await reply(socket, control.messageId as string)).toMatchObject({
        type: 'ERROR',
        payload: { code: 'INVALID_MESSAGE', retryable: false },
      });
      // And so is a DOMAIN_EVENT outside the closed catalog (11.4).
      const event = envelope('DOMAIN_EVENT', {
        commandId: randomUUID(),
        outcome: 'SUCCEEDED',
      });
      socket.send(event);
      expect(await reply(socket, event.messageId as string)).toMatchObject({
        type: 'ERROR',
        payload: { code: 'INVALID_MESSAGE', retryable: false },
      });
      socket.send(envelope('ERROR', { code: 'LOCAL_FAILURE' }));
      const beat = envelope('HEARTBEAT', {
        gameProcessState: 'STOPPED',
        skseReady: false,
      });
      socket.send(beat);
      await reply(socket, beat.messageId as string);
      expect(socket.closed).toBeNull();
      expect(
        await database.query(
          'SELECT (SELECT count(*) FROM game_commands) AS commands, (SELECT count(*) FROM game_command_results) AS results, (SELECT count(*) FROM server_control_operations) AS operations',
        ),
      ).toEqual(before);
    });
    it('keeps the realtime surface intact and refuses unknown paths or URL credentials', async () => {
      const staff = client('/api/v1/realtime');
      expect(
        await staff.authenticate('STAFF', tokens.get(R.COORDINATOR)!),
      ).toMatchObject({ type: 'AUTHENTICATED', surface: 'STAFF' });
      // An Agent secret is not a realtime token.
      const key = await credential();
      const wrong = client('/api/v1/realtime');
      expect(await wrong.authenticate('STAFF', key.credentialSecret)).toEqual({
        closed: { code: 4001, reason: 'UNAUTHORIZED' },
      });
      for (const path of [
        `/api/v1/agent?credentialSecret=${key.credentialSecret}`,
        '/api/v1/agent/',
        '/api/v1/agents',
        '/api/v1/unknown',
      ]) {
        const socket = client(path);
        const closed = await socket.closedWith();
        expect(socket.opened).toBe(false);
        expect(closed.code).toBe(1006);
      }
      await staff.close();
    });
    it('reconciles persisted sessions on startup and closes live ones on shutdown', async () => {
      const options = createDatabaseOptions(loadEnvironment());
      // Its own DataSource: closing an app destroys the one it was given.
      const secondSource = await schemaSource(options);
      await secondSource.initialize();
      // A session left CONNECTED by a previous process.
      const orphan = await connections.connect({
        gameServerId: server.id,
        externalConnectionId: randomUUID(),
      });
      const second = await bootApp(secondSource);
      try {
        expect(await row(orphan.id)).toMatchObject({
          status: 'DISCONNECTED',
          disconnectReason: 'BACKEND_RESTART',
        });
        const key = await credential();
        const { socket, result } = await connect(key, {}, {}, second.url);
        expect(result).toMatchObject({ type: 'AUTHENTICATED' });
        const connectionId = (result as Frame).payload!.connectionId as string;
        // The other instance's registry is its own (single-instance model).
        expect(registry.isConnected(server.id)).toBe(false);
        await second.created.close();
        expect(await socket.closedWith()).toEqual({
          code: 1001,
          reason: 'SHUTDOWN',
        });
        expect(await row(connectionId)).toMatchObject({
          status: 'DISCONNECTED',
          disconnectReason: 'SHUTDOWN',
        });
      } finally {
        await second.created.close().catch(() => undefined);
        if (secondSource.isInitialized) await secondSource.destroy();
      }
    });
  });

  it('refuses to revert while credentials exist', async () => {
    await database.undoLastMigration(); // Etapa 12.5 Multi-instance
    await database.undoLastMigration(); // Etapa 12.4 Operational Recovery
    await database.undoLastMigration(); // Etapa 11.4 Agent Domain Events
    await database.undoLastMigration(); // Etapa 11.3 Server Control Transport
    await expect(database.undoLastMigration()).rejects.toThrow(
      'Game Agent credentials exist',
    );
    expect(await database.query('SELECT * FROM migrations')).toHaveLength(23);
    expect(await database.runMigrations()).toHaveLength(4);
    expect(await database.showMigrations()).toBe(false);
    expect(await database.query('SELECT * FROM migrations')).toHaveLength(27);
  });
});
