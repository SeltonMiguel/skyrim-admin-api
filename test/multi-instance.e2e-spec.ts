import type { INestApplication } from '@nestjs/common';
import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type pg from 'pg';
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
import {
  playerActor,
  systemActor,
  SystemSource,
} from '../src/actors/actor.contracts.js';
import { ClusterBus } from '../src/cluster/cluster-bus.js';
import { InstanceIdentity } from '../src/cluster/instance-identity.js';
import { RealtimeLeaseService } from '../src/cluster/realtime-leases.js';
import { RateLimiter } from '../src/common/rate-limit/rate-limiter.js';
import { EconomyService } from '../src/economy/economy.service.js';
import { AgentSessionRegistry } from '../src/game-agent/agent-session.registry.js';
import { AgentWorkNotifier } from '../src/game-agent/agent-work.notifier.js';
import { GameCommandBus } from '../src/game-bridge/game-command-bus.js';
import { GameCommandDispatcher } from '../src/game-bridge/game-command-dispatcher.js';
import { GameConnectionService } from '../src/game-bridge/game-connection.service.js';
import { GameServerService } from '../src/game-bridge/game-server.service.js';
import type { GameServer } from '../src/game-bridge/entities/game-server.entity.js';
import { LifecycleService } from '../src/lifecycle/lifecycle.service.js';
import { Metrics } from '../src/observability/metrics.js';
import { DiscordIdentityProvider } from '../src/player-auth/discord-identity.provider.js';
import { CharacterLinkService } from '../src/player-characters/character-link.service.js';
import { RealtimeEventBus } from '../src/realtime-events/realtime-event-bus.js';
import { Permission } from '../src/rbac/permissions.js';
import { ServerControlDispatcher } from '../src/server-control/server-control-dispatcher.js';
import { VipDeliveryService } from '../src/vip-entitlements/vip-delivery.service.js';
import { VipEntitlementService } from '../src/vip-entitlements/vip-entitlement.service.js';
import { VipEntitlementScope } from '../src/vip-store/vip-offer.contracts.js';
import { FakeDiscordProvider } from './support/fake-discord-provider.js';
import { FakeAgent } from './support/fake-agent.js';
import type { Frame } from './support/fake-agent.js';
import { RealtimeTestClient } from './support/realtime-client.js';

const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;
const CHANNEL = `bus_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
// One configuration for every replica of this suite (one module graph); each
// replica gets its own DataSource, InstanceIdentity, registries, workers and
// LISTEN connection. Short deadlines keep failover observable.
const ENV = {
  BACKEND_TOPOLOGY: 'MULTI',
  CLUSTER_BUS_CHANNEL: CHANNEL,
  STAFF_LOGIN_RATE_LIMIT_PER_USERNAME: '4',
  REALTIME_MAX_CONNECTIONS_PER_IDENTITY: '2',
  REALTIME_LEASE_TTL_MS: '10000',
  REALTIME_LEASE_RENEW_INTERVAL_MS: '2000',
  OPERATIONS_ACTION_RATE_LIMIT_PER_MINUTE: '4',
  AGENT_MAX_IN_FLIGHT_COMMANDS: '2',
  GAME_COMMAND_WORKER_INTERVAL_MS: '100',
  GAME_COMMAND_ACK_TIMEOUT_MS: '1000',
  SERVER_CONTROL_WORKER_INTERVAL_MS: '100',
  SERVER_CONTROL_PENDING_TIMEOUT_MS: '4000',
  SERVER_CONTROL_DELIVERY_WINDOW_MS: '1000',
  SERVER_CONTROL_RESULT_TIMEOUT_MS: '2500',
  VIP_DELIVERY_WORKER_INTERVAL_MS: '100',
  AGENT_WORK_PUSH_INTERVAL_MS: '150',
};
const PING_CAPS = ['GAME_COMMAND_V1', 'BRIDGE_PING'];
const GIVE_CAPS = [
  'GAME_COMMAND_V1',
  'COMMAND_DEDUP_V1',
  'CHARACTER_ITEM_GIVE',
  'CHARACTER_TITLE_GIVE',
];
const CONTROL_CAPS = [
  'SERVER_CONTROL_V1',
  'SERVER_START',
  'SERVER_PAUSE',
  'SERVER_RESTART',
];
const RUNNING = { gameProcessState: 'RUNNING', skseReady: true };
const STOPPED = { gameProcessState: 'STOPPED', skseReady: false };
type Session = {
  accessToken: string;
  refreshToken: string;
  player: { id: string };
};
type Node = {
  app: INestApplication<App>;
  database: DataSource;
  url: string;
  id: string;
};
type Key = { credentialId: string; credentialSecret: string };
async function eventually<T>(
  check: () => Promise<T | undefined | false> | T | undefined | false,
  timeoutMs = 8000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for state');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
jest.setTimeout(60000);

// Stage 12.5: two (or more) MULTI replicas on one PostgreSQL, with no mock of
// the coordination (bus, ownership, leases, shared rate limits). FakeAgent
// stands for the Host Agent executable, as in Stage 11.
describeDatabase('MULTI topology: replicas coordinated by PostgreSQL', () => {
  let admin: DataSource;
  let options: DataSourceOptions;
  let artifacts: Awaited<ReturnType<typeof compiledDatabaseArtifacts>>;
  let AppModule: unknown;
  // nodes[0] = A, nodes[1] = B; later tests add or replace replicas.
  const nodes: Node[] = [];
  const agents: FakeAgent[] = [];
  const sockets: RealtimeTestClient[] = [];
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const discord = new FakeDiscordProvider();
  const schema = `multi_test_${randomUUID().replaceAll('-', '')}`;
  const password = 'Multi-Instance-Password-42';
  const A = () => nodes[0];
  const B = () => nodes[1];
  const http = (node: Node) => request(node.app.getHttpServer());
  const get = <T>(node: Node, type: abstract new (...args: never[]) => T) =>
    node.app.get(type as never) as T;
  const one = async (sql: string, params: unknown[] = []) =>
    (await admin.query(sql, params))[0];

  const spawn = async (): Promise<Node> => {
    const database = new DataSource({
      ...options,
      schema,
      ...artifacts,
      extra: {
        ...(options as { extra?: object }).extra,
        options: `-c search_path=${schema},public`,
      },
    } as DataSourceOptions);
    await database.initialize();
    const module = await Test.createTestingModule({
      imports: [AppModule as never],
    })
      .overrideProvider(DataSource)
      .useValue(database)
      .overrideProvider(DiscordIdentityProvider)
      .useValue(discord)
      .compile();
    const app = module.createNestApplication(new AppExpressAdapter());
    app.useLogger(false);
    setupApp(app);
    await app.listen(0, '127.0.0.1');
    const address = (
      app.getHttpServer() as unknown as Server
    ).address() as AddressInfo;
    const node: Node = {
      app,
      database,
      url: `ws://127.0.0.1:${address.port}`,
      id: app.get(InstanceIdentity).id,
    };
    await eventually(() => app.get(ClusterBus).connected);
    return node;
  };
  const stop = async (node: Node) => {
    await node.app.close();
    if (node.database.isInitialized) await node.database.destroy();
  };
  // A graceful stop of A, replaced by a brand-new replica (new identity).
  const replaceA = async () => {
    await stop(A());
    nodes[0] = await spawn();
  };
  const listener = (node: Node) =>
    (get(node, ClusterBus) as unknown as { client: pg.Client }).client;
  // A lost NOTIFY, deterministically: this replica stops listening (the
  // publisher still commits and notifies; nobody hears it here).
  const mute = (node: Node) => listener(node).query(`UNLISTEN "${CHANNEL}"`);
  const unmute = (node: Node) => listener(node).query(`LISTEN "${CHANNEL}"`);

  const staffLogin = async (node: Node, username: string) =>
    (
      await http(node)
        .post('/api/v1/auth/login')
        .send({ username, password })
        .expect(200)
    ).body.accessToken as string;
  const login = async (node: Node): Promise<Session> => {
    const code = `code-${randomUUID()}`;
    discord.codes.set(code, {
      subject: `${Date.now()}${Math.floor(Math.random() * 1e9)}`,
      displayName: 'Player',
    });
    return (
      await http(node)
        .post('/api/v1/player/auth/discord/exchange')
        .send({ authorizationCode: code, redirectUri: 'http://127.0.0.1/cb' })
        .expect(200)
    ).body;
  };
  const socket = async (
    node: Node,
    surface: 'PLAYER' | 'STAFF',
    token: string,
  ) => {
    const client = new RealtimeTestClient(`${node.url}/api/v1/realtime`);
    sockets.push(client);
    const auth = (await client.authenticate(surface, token)) as {
      type?: string;
    };
    return { client, authenticated: auth.type === 'AUTHENTICATED' };
  };
  const register = (node: Node = B()) =>
    get(node, GameServerService).register({ code: randomUUID(), name: 'MI' });
  const credential = async (node: Node, serverId: string): Promise<Key> =>
    (
      await http(node)
        .post(`/api/v1/admin/game-servers/${serverId}/agent-credentials`)
        .auth(tokens.COORDINATOR, { type: 'bearer' })
        .expect(201)
    ).body;
  const agent = async (
    node: Node,
    server: GameServer,
    capabilities: string[],
    runtime = RUNNING,
    options: { key?: Key; journal?: FakeAgent } = {},
  ) => {
    const journal = options.journal;
    const created = new FakeAgent(
      node.url,
      server.id,
      journal?.journal,
      journal?.executions,
      journal?.operations,
      journal?.performed,
    );
    agents.push(created);
    await created.hello(
      options.key ?? (await credential(node, server.id)),
      capabilities,
      runtime,
    );
    return created;
  };
  const connection = (id: string) =>
    one(
      'SELECT id, status, disconnect_reason, owner_instance_id, game_process_state, disconnected_at FROM game_connections WHERE id = $1',
      [id],
    );
  const receipts = async (eventId: string) =>
    Number(
      (
        await one(
          'SELECT count(*)::int AS n FROM agent_domain_event_receipts WHERE event_id = $1',
          [eventId],
        )
      ).n,
    );
  const command = (id: string) =>
    one(
      'SELECT status, dispatch_attempts, dispatched_connection_id FROM game_commands WHERE id = $1',
      [id],
    );
  const results = async (id: string) =>
    Number(
      (
        await one(
          'SELECT count(*)::int AS n FROM game_command_results WHERE game_command_id = $1',
          [id],
        )
      ).n,
    );
  const ping = (node: Node, serverId: string) =>
    get(node, GameCommandBus).submit({
      gameServerId: serverId,
      type: 'BRIDGE_PING',
      payload: { nonce: randomUUID() },
      idempotencyKey: randomUUID(),
    });
  const control = (node: Node, serverId: string) =>
    http(node)
      .post(`/api/v1/game-servers/${serverId}/control/restart`)
      .auth(tokens.COORDINATOR, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(202);
  const operation = (id: string) =>
    one(
      'SELECT status, error_code, dispatch_connection_id, dispatch_claimed_at FROM server_control_operations WHERE id = $1',
      [id],
    );
  const metric = async (node: Node, pattern: RegExp) => {
    const match = pattern.exec(await get(node, Metrics).render());
    return match ? Number(match[1]) : null;
  };

  beforeAll(async () => {
    Object.assign(process.env, ENV);
    options = createDatabaseOptions(loadEnvironment());
    if (options.type !== 'postgres') throw new Error('PostgreSQL required');
    admin = new DataSource({
      ...options,
      extra: {
        ...(options as { extra?: object }).extra,
        options: `-c search_path=${schema},public`,
      },
    } as DataSourceOptions);
    await admin.initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    artifacts = await compiledDatabaseArtifacts();
    ({ AppModule } = await import('../src/app.module.js'));
    const migrator = new DataSource({
      ...options,
      schema,
      ...artifacts,
      extra: {
        ...(options as { extra?: object }).extra,
        options: `-c search_path=${schema},public`,
      },
    } as DataSourceOptions);
    await migrator.initialize();
    expect(await migrator.runMigrations()).toHaveLength(27);
    const hash = await new PasswordService().hash(password);
    for (const role of ['COORDINATOR', 'DEV']) {
      const [row] = await migrator.query(
        'INSERT INTO staff_users(username, display_name, password_hash, role_name) VALUES ($1, $1, $2, $3) RETURNING id',
        [role.toLowerCase(), hash, role],
      );
      staffIds[role] = row.id;
    }
    await migrator.destroy();
    nodes.push(await spawn(), await spawn());
    tokens.COORDINATOR = await staffLogin(B(), 'coordinator');
  }, 120000);
  afterEach(async () => {
    jest.restoreAllMocks();
    for (const client of sockets.splice(0))
      if (!client.closed) await client.close();
    for (const created of agents.splice(0)) await created.close();
    await eventually(() =>
      nodes.every((node) => get(node, AgentSessionRegistry).count() === 0),
    );
  });
  afterAll(async () => {
    for (const node of nodes.splice(0)) await stop(node).catch(() => undefined);
    for (const name of Object.keys(ENV)) delete process.env[name];
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  it('runs replicas side by side; a new replica never closes an Agent it does not own', async () => {
    expect(A().id).not.toBe(B().id);
    for (const node of nodes)
      expect((await http(node).get('/api/v1/ready').expect(200)).body).toEqual({
        status: 'ready',
      });
    const server = await register();
    const host = await agent(A(), server, PING_CAPS);
    // C starts on the same database while A owns a live session.
    nodes.push(await spawn());
    expect(nodes[2].id).not.toBe(A().id);
    await http(nodes[2]).get('/api/v1/ready').expect(200);
    expect(await connection(host.connectionId!)).toMatchObject({
      status: 'CONNECTED',
      owner_instance_id: A().id,
    });
    expect(host.client.closed).toBeNull();
    expect((await host.heartbeat('RUNNING', true)).type).toBe('HEARTBEAT_ACK');
    // Local ownership gauges: 1 on A, 0 elsewhere (no instance label).
    expect(await metric(A(), /skyrim_admin_agent_sessions_active (\d+)/)).toBe(
      1,
    );
    expect(await metric(B(), /skyrim_admin_agent_sessions_active (\d+)/)).toBe(
      0,
    );
  });

  it('wakes a Player socket on A for a mutation on B; HTTP holds the state', async () => {
    const session = await login(A());
    const { client } = await socket(A(), 'PLAYER', session.accessToken);
    await http(B())
      .patch('/api/v1/player/settings')
      .auth(session.accessToken, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ locale: 'en-US' })
      .expect(200);
    await client.event('PLAYER_SETTINGS_UPDATED', 8000);
    // Best effort, not exactly-once by contract; here it arrived once.
    expect(
      client.events().filter((e) => e.type === 'PLAYER_SETTINGS_UPDATED'),
    ).toHaveLength(1);
    expect(
      (
        await http(A())
          .get('/api/v1/player/settings')
          .auth(session.accessToken, { type: 'bearer' })
          .expect(200)
      ).body.locale,
    ).toBe('en-US');
  });

  it('closes the socket on A when the session is logged out on B', async () => {
    const session = await login(A());
    const { client } = await socket(A(), 'PLAYER', session.accessToken);
    await http(B())
      .post('/api/v1/player/auth/logout')
      .auth(session.accessToken, { type: 'bearer' })
      .expect((r) => expect([200, 204]).toContain(r.status));
    expect(await client.closedWith(8000)).toEqual({
      code: 4001,
      reason: 'SESSION_REVOKED',
    });
  });

  it('never delivers private data after a lost revocation signal (logout and ban)', async () => {
    const privateEvent = (playerId: string) =>
      get(B(), RealtimeEventBus).publish(
        'PLAYER_SETTINGS_UPDATED',
        { locale: 'secret' },
        { playerIds: [playerId] },
      );
    for (const revoke of ['logout', 'ban'] as const) {
      const session = await login(A());
      const { client } = await socket(A(), 'PLAYER', session.accessToken);
      await mute(A());
      try {
        if (revoke === 'logout')
          await http(B())
            .post('/api/v1/player/auth/logout')
            .auth(session.accessToken, { type: 'bearer' })
            .expect((r) => expect([200, 204]).toContain(r.status));
        else
          await http(B())
            .post(`/api/v1/operations/players/${session.player.id}/status`)
            .auth(tokens.COORDINATOR, { type: 'bearer' })
            .set('Idempotency-Key', randomUUID())
            .send({ status: 'BANNED', reason: 'Lost-signal test' })
            .expect(200);
        // The close signal never reached A: the socket is still open.
        await pause(300);
        expect(client.closed).toBeNull();
      } finally {
        await unmute(A());
      }
      // A private event now reaches A: the database refuses the session.
      privateEvent(session.player.id);
      expect(await client.closedWith(8000)).toEqual({
        code: 4001,
        reason: 'SESSION_REVOKED',
      });
      expect(
        client.events().filter((e) => e.type === 'PLAYER_SETTINGS_UPDATED'),
      ).toEqual([]);
    }
  });

  it('re-authorizes Staff on A against the database after a role change on B', async () => {
    const username = `dev-${randomUUID().slice(0, 8)}`;
    const [row] = await admin.query(
      "INSERT INTO staff_users(username, display_name, password_hash, role_name) VALUES ($1, $1, $2, 'DEV') RETURNING id",
      [username, await new PasswordService().hash(password)],
    );
    const dev = await socket(A(), 'STAFF', await staffLogin(A(), username));
    const chief = await socket(A(), 'STAFF', tokens.COORDINATOR);
    const wake = (n: number) =>
      get(B(), RealtimeEventBus).publish(
        'STAFF_OPERATIONS_UPDATED',
        { operatorActionId: `wake-${n}` },
        { staffPermission: Permission.PLAYER_TRADE_RECOVER },
      );
    const seen = (client: RealtimeTestClient) =>
      client.events().filter((e) => e.type === 'STAFF_OPERATIONS_UPDATED');
    wake(1);
    await eventually(() => seen(dev.client).length === 1);
    await eventually(() => seen(chief.client).length === 1);
    await http(B())
      .patch(`/api/v1/staff/${row.id}/role`)
      .auth(tokens.COORDINATOR, { type: 'bearer' })
      .send({ role: 'SUPPORT' })
      .expect(200);
    wake(2);
    await eventually(() => seen(chief.client).length === 2);
    await pause(200);
    expect(seen(dev.client)).toHaveLength(1);
  });

  it('creates a GameCommand on B that only the owner A delivers, once', async () => {
    const server = await register();
    const host = await agent(A(), server, PING_CAPS);
    const created = await ping(B(), server.id);
    // B never crosses the delivery boundary, even when asked directly.
    await get(B(), GameCommandDispatcher).dispatch(created.id);
    expect(
      get(B(), AgentSessionRegistry).getSession(server.id),
    ).toBeUndefined();
    const frame = await host.command(created.id);
    host.ack(frame);
    await host.reply(
      host.result(frame.payload!, {
        outcome: 'SUCCEEDED',
        result: { nonce: (created.payload as { nonce: string }).nonce },
      }),
    );
    await eventually(
      async () => (await command(created.id)).status === 'SUCCEEDED',
    );
    expect(await command(created.id)).toMatchObject({
      dispatch_attempts: 1,
      dispatched_connection_id: host.connectionId,
    });
    expect(host.commands(created.id)).toHaveLength(1);
    expect(await results(created.id)).toBe(1);
  });

  it('never exceeds the in-flight budget under concurrent dispatch from both replicas', async () => {
    const server = await register();
    const host = await agent(A(), server, PING_CAPS);
    const commands = [];
    for (let i = 0; i < 6; i++) commands.push(await ping(B(), server.id));
    const inFlight = async () =>
      Number(
        (
          await one(
            `SELECT count(*)::int AS n FROM game_commands WHERE game_server_id = $1
             AND (status IN ('DISPATCHED', 'ACKNOWLEDGED') OR (status = 'PENDING' AND dispatch_lease_id IS NOT NULL))`,
            [server.id],
          )
        ).n,
      );
    await Promise.all(
      commands.flatMap((c) => [
        get(A(), GameCommandDispatcher).dispatch(c.id),
        get(A(), GameCommandDispatcher).dispatch(c.id),
        get(B(), GameCommandDispatcher).dispatch(c.id),
      ]),
    );
    expect(await inFlight()).toBe(2);
    let max = 0;
    const done = new Set<string>();
    while (done.size < commands.length) {
      max = Math.max(max, await inFlight());
      for (const frame of host.commands())
        if (!done.has(frame.payload!.commandId as string)) {
          const id = frame.payload!.commandId as string;
          done.add(id);
          host.ack(frame);
          await host.reply(
            host.result(frame.payload!, {
              outcome: 'SUCCEEDED',
              result: {
                nonce: (
                  commands.find((c) => c.id === id)!.payload as {
                    nonce: string;
                  }
                ).nonce,
              },
            }),
          );
        }
      await pause(50);
    }
    expect(max).toBeLessThanOrEqual(2);
    for (const c of commands)
      expect(await command(c.id)).toMatchObject({
        status: 'SUCCEEDED',
        dispatch_attempts: 1,
      });
  });

  it('closes a superseded Agent on A and fences it when the signal is lost', async () => {
    // Signal delivered: the old socket on A closes.
    const s1 = await register();
    const old1 = await agent(A(), s1, PING_CAPS);
    await agent(B(), s1, PING_CAPS);
    expect(await old1.client.closedWith(8000)).toMatchObject({
      reason: 'SUPERSEDED',
    });
    // Signal lost: the old socket stays open but the database fences it.
    for (const frame of ['HEARTBEAT', 'DOMAIN_EVENT'] as const) {
      const server = await register();
      const old = await agent(A(), server, PING_CAPS);
      await mute(A());
      let fresh: FakeAgent;
      try {
        fresh = await agent(B(), server, PING_CAPS);
        await pause(200);
        expect(old.client.closed).toBeNull();
      } finally {
        await unmute(A());
      }
      const eventId = randomUUID();
      const reply =
        frame === 'HEARTBEAT'
          ? old.reply(old.send('HEARTBEAT', STOPPED))
          : old.reply(
              old.event(
                'TRADE_SETTLEMENT',
                { workId: randomUUID(), outcome: 'SETTLED' },
                eventId,
              ),
            );
      await reply.catch(() => undefined);
      expect(await old.client.closedWith()).toMatchObject({
        reason: 'SESSION_CLOSED',
      });
      expect(await receipts(eventId)).toBe(0);
      // The new owner on B is untouched (runtime not overwritten).
      expect(await connection(fresh!.connectionId!)).toMatchObject({
        status: 'CONNECTED',
        owner_instance_id: B().id,
        game_process_state: 'RUNNING',
      });
      expect((await fresh!.heartbeat('RUNNING', true)).type).toBe(
        'HEARTBEAT_ACK',
      );
    }
  });

  it('closes an Agent on A revoked on B and fences it when the signal is lost', async () => {
    const revoke = (serverId: string, key: Key) =>
      http(B())
        .post(
          `/api/v1/admin/game-servers/${serverId}/agent-credentials/${key.credentialId}/revoke`,
        )
        .auth(tokens.COORDINATOR, { type: 'bearer' })
        .expect(200);
    const s1 = await register();
    const k1 = await credential(B(), s1.id);
    const host1 = await agent(A(), s1, PING_CAPS, RUNNING, { key: k1 });
    await revoke(s1.id, k1);
    expect(await host1.client.closedWith(8000)).toMatchObject({
      reason: 'CREDENTIAL_REVOKED',
    });
    const s2 = await register();
    const k2 = await credential(B(), s2.id);
    const host2 = await agent(A(), s2, PING_CAPS, RUNNING, { key: k2 });
    const pending = await ping(B(), s2.id);
    const frame = await host2.command(pending.id);
    host2.ack(frame);
    await mute(A());
    try {
      await revoke(s2.id, k2);
      await pause(200);
      expect(host2.client.closed).toBeNull();
    } finally {
      await unmute(A());
    }
    // A RESULT from the revoked session changes nothing.
    await host2
      .reply(
        host2.result(frame.payload!, {
          outcome: 'SUCCEEDED',
          result: { nonce: (pending.payload as { nonce: string }).nonce },
        }),
      )
      .catch(() => undefined);
    expect(await host2.client.closedWith()).toMatchObject({
      reason: 'SESSION_CLOSED',
    });
    expect(await results(pending.id)).toBe(0);
    expect((await command(pending.id)).status).not.toBe('SUCCEEDED');
  });

  it('recovers a PENDING command on B after A stops before any send', async () => {
    const server = await register();
    const key = await credential(B(), server.id);
    const stopped = await agent(A(), server, PING_CAPS, STOPPED, { key });
    const created = await ping(B(), server.id);
    await pause(400);
    expect(await command(created.id)).toMatchObject({
      status: 'PENDING',
      dispatch_attempts: 0,
    });
    await replaceA();
    await stopped.client.closedWith();
    const host = await agent(B(), server, PING_CAPS, RUNNING, { key });
    const frame = await host.command(created.id);
    expect(frame.payload!.attempt).toBe(1);
    host.ack(frame);
    await host.reply(
      host.result(frame.payload!, {
        outcome: 'SUCCEEDED',
        result: { nonce: (created.payload as { nonce: string }).nonce },
      }),
    );
    await eventually(
      async () => (await command(created.id)).status === 'SUCCEEDED',
    );
    expect(await command(created.id)).toMatchObject({
      dispatch_attempts: 1,
      dispatched_connection_id: host.connectionId,
    });
  });

  it('never re-executes a command delivered by A when its RESULT arrives through B', async () => {
    const server = await register();
    const key = await credential(B(), server.id);
    const first = await agent(A(), server, GIVE_CAPS, RUNNING, { key });
    const created = await get(B(), GameCommandBus).submit({
      gameServerId: server.id,
      type: 'CHARACTER_ITEM_GIVE',
      payload: { characterId: 'opaque:c', itemId: 'opaque:i', quantity: 1 },
      idempotencyKey: randomUUID(),
    });
    const delivered = await first.command(created.id);
    // Executed and journaled on the Agent; A goes away before any ACK/RESULT.
    first.journal.set(created.id, {
      state: 'COMPLETED',
      result: { characterId: 'opaque:c', applied: true, targetId: 'opaque:i' },
    } as never);
    first.executions.set(created.id, 1);
    await replaceA();
    await first.client.closedWith();
    const second = await agent(B(), server, GIVE_CAPS, RUNNING, {
      key,
      journal: first,
    });
    // Same commandId, next attempt; the journal answers without re-executing.
    const redelivered = await second.command(created.id, 2, 8000);
    expect(redelivered.payload!.commandId).toBe(delivered.payload!.commandId);
    expect(redelivered.payload!.correlationId).toBe(
      delivered.payload!.correlationId,
    );
    await second.reply(second.execute(redelivered, () => ({})));
    await eventually(
      async () => (await command(created.id)).status === 'SUCCEEDED',
    );
    expect(second.executions.get(created.id)).toBe(1);
    expect(await results(created.id)).toBe(1);
    expect((await command(created.id)).dispatch_attempts).toBe(2);
  });

  it('claims Server Control only on the owner and delivers it once', async () => {
    const server = await register();
    const host = await agent(A(), server, CONTROL_CAPS, STOPPED);
    const { operationId } = (await control(B(), server.id)).body;
    expect(
      await get(B(), ServerControlDispatcher).dispatch(operationId),
    ).not.toBe('SENT');
    const frame = await host.control(operationId);
    await host.reply(host.perform(frame)!);
    await eventually(
      async () => (await operation(operationId)).status === 'SUCCEEDED',
    );
    expect((await operation(operationId)).dispatch_connection_id).toBe(
      host.connectionId,
    );
    expect(host.controls(operationId)).toHaveLength(1);
    expect(host.performed.get(operationId)).toBe(1);
  });

  it('never resends Server Control after A crossed the claim, whatever comes after', async () => {
    const late = await register();
    const silent = await register();
    const lateKey = await credential(B(), late.id);
    const silentKey = await credential(B(), silent.id);
    const onA = [
      await agent(A(), late, CONTROL_CAPS, STOPPED, { key: lateKey }),
      await agent(A(), silent, CONTROL_CAPS, STOPPED, { key: silentKey }),
    ];
    const ops = [
      (await control(B(), late.id)).body.operationId as string,
      (await control(B(), silent.id)).body.operationId as string,
    ];
    const frames: Frame[] = [];
    for (let i = 0; i < 2; i++) {
      frames.push(await onA[i].control(ops[i]));
      // Acted on, then A goes away before any RESULT.
      onA[i].perform(frames[i], { outcome: 'SUCCEEDED' }, false);
    }
    await replaceA();
    const onB = [
      await agent(B(), late, CONTROL_CAPS, STOPPED, {
        key: lateKey,
        journal: onA[0],
      }),
      await agent(B(), silent, CONTROL_CAPS, STOPPED, {
        key: silentKey,
        journal: onA[1],
      }),
    ];
    // (A) the late RESULT arrives through B and is accepted.
    await onB[0].reply(onB[0].replay(frames[0]));
    await eventually(
      async () => (await operation(ops[0])).status === 'SUCCEEDED',
    );
    // (B) no RESULT: UNCERTAIN at the deadline, never resent.
    await eventually(
      async () => (await operation(ops[1])).status === 'UNCERTAIN',
      10000,
    );
    for (let i = 0; i < 2; i++) {
      expect(onB[i].controls(ops[i])).toEqual([]);
      expect(onA[i].performed.get(ops[i])).toBe(1);
    }
  });

  it('settles Trade work created on B through the Agent on A exactly once', async () => {
    const links = get(B(), CharacterLinkService);
    const economy = get(B(), EconomyService);
    const server = await register();
    const party = async (gold: number) => {
      const session = await login(B());
      const char = `char:${randomUUID()}`;
      const requested = await links.request(playerActor(session.player.id), {
        gameServerId: server.id,
        characterExternalId: char,
      });
      await links.confirmFromAgent({
        challenge: requested.challenge,
        gameServerId: server.id,
        characterExternalId: char,
      });
      if (gold)
        await economy.creditFromSystem({
          gameServerId: server.id,
          characterExternalId: char,
          amount: gold,
          idempotencyKey: randomUUID(),
          source: SystemSource.AGENT,
        });
      return { session, link: requested.link.id, char };
    };
    const player = (
      s: Session,
      method: 'post' | 'get',
      path: string,
      body?: object,
    ) => {
      const call = http(B())
        [method](`/api/v1/player/${path}`)
        .auth(s.accessToken, { type: 'bearer' });
      return method === 'get'
        ? call
        : call.set('Idempotency-Key', randomUUID()).send(body ?? {});
    };
    const a = await party(1000);
    const b = await party(0);
    const opened = (
      await player(a.session, 'post', 'trades', {
        actorCharacterLinkId: a.link,
        targetCharacterId: b.char,
        offer: { gold: 300, items: [{ itemId: 'item:sword', quantity: 1 }] },
      }).expect(201)
    ).body;
    const view = (
      await player(
        a.session,
        'get',
        `trades/${opened.tradeId}?characterLinkId=${a.link}`,
      ).expect(200)
    ).body;
    for (const [p, version] of [
      [a, view.target.offer.version],
      [b, view.initiator.offer.version],
    ] as const)
      await player(p.session, 'post', `trades/${opened.tradeId}/accept`, {
        characterLinkId: p.link,
        counterpartyOfferVersion: version,
      }).expect(200);
    const host = await agent(A(), server, PING_CAPS);
    // A pushes it (or the Agent syncs); B, without the socket, never does.
    await get(B(), AgentWorkNotifier).tick();
    const workIds = async () =>
      (await host.syncAll())
        .flatMap((p) => p.payload!.items as { workId: string }[])
        .map((i) => i.workId);
    expect(await workIds()).toEqual([opened.tradeId]);
    const eventId = randomUUID();
    const settle = () =>
      host.reply(
        host.event(
          'TRADE_SETTLEMENT',
          { workId: opened.tradeId, outcome: 'SETTLED' },
          eventId,
        ),
      );
    expect((await settle()).type).toBe('DOMAIN_EVENT_ACK');
    // Notifiers of both replicas run; the retry is a duplicate, not an effect.
    await Promise.all([
      get(A(), AgentWorkNotifier).tick(),
      get(B(), AgentWorkNotifier).tick(),
    ]);
    expect((await settle()).payload).toMatchObject({ duplicate: true });
    expect(await workIds()).toEqual([]);
    const balance = async (char: string) =>
      Number(
        (
          await one(
            "SELECT balance FROM economy_accounts WHERE game_server_id = $1 AND owner_type = 'CHARACTER' AND character_external_id = $2",
            [server.id, char],
          )
        )?.balance ?? 0,
      );
    expect([await balance(a.char), await balance(b.char)]).toEqual([700, 300]);
    expect(await receipts(eventId)).toBe(1);
  });

  it('creates one VIP delivery command whatever replicas tick', async () => {
    const server = await register();
    const host = await agent(A(), server, GIVE_CAPS);
    const offer = (
      await http(B())
        .post('/api/v1/admin/vip-store/offers')
        .auth(tokens.COORDINATOR, { type: 'bearer' })
        .send({
          code: `vip_${randomUUID().slice(0, 8)}`,
          name: 'VIP',
          description: 'Benefit',
          priceMinor: 990,
          currency: 'BRL',
          rewards: [{ type: 'TITLE', titleId: 'title:multi' }],
          entitlementScope: 'CHARACTER',
          active: true,
        })
        .expect(201)
    ).body as { id: string };
    const granted = (await get(B(), VipEntitlementService).grant({
      offerId: offer.id,
      target: {
        scope: VipEntitlementScope.CHARACTER,
        gameServerId: server.id,
        characterExternalId: 'char:vip',
      },
      actor: systemActor(SystemSource.VIP_DELIVERY),
      idempotencyKey: randomUUID(),
    })) as { entitlementId: string };
    for (let i = 0; i < 5; i++)
      await Promise.all(
        nodes.map((node) => get(node, VipDeliveryService).tick()),
      );
    const delivery = await eventually(async () => {
      const row = await one(
        'SELECT id, status, game_command_id FROM vip_reward_deliveries WHERE entitlement_id = $1',
        [granted.entitlementId],
      );
      return row?.game_command_id && row;
    });
    expect(
      Number(
        (
          await one(
            "SELECT count(*)::int AS n FROM game_commands WHERE idempotency_key LIKE 'vip-delivery:' || $1 || '%'",
            [delivery.id],
          )
        ).n,
      ),
    ).toBe(1);
    const frame = await host.command(delivery.game_command_id);
    host.ack(frame);
    await host.reply(
      host.execute(frame, () => ({
        characterId: 'char:vip',
        applied: true,
        targetId: 'title:multi',
      })),
    );
    await eventually(
      async () =>
        (
          await one('SELECT status FROM vip_reward_deliveries WHERE id = $1', [
            delivery.id,
          ])
        ).status === 'SUCCEEDED',
    );
    expect(host.commands(delivery.game_command_id)).toHaveLength(1);
  });

  it('marks a dead owner STALE once, and never a live one', async () => {
    const server = await register();
    const host = await agent(A(), server, PING_CAPS);
    const connections = nodes.map((node) => get(node, GameConnectionService));
    // Fresh lease on A: no replica closes it.
    expect(
      (
        await Promise.all(connections.map((c) => c.markStaleConnections()))
      ).every((n) => n === 0),
    ).toBe(true);
    expect(await get(B(), GameConnectionService).endExpired()).toBe(0);
    expect((await connection(host.connectionId!)).status).toBe('CONNECTED');
    // The owner stops renewing: every sweeper races, one transition wins.
    await admin.query(
      "UPDATE game_connections SET last_heartbeat_at = now() - interval '1 hour' WHERE id = $1",
      [host.connectionId],
    );
    const closed = await Promise.all(
      connections.map((c) => c.markStaleConnections()),
    );
    expect(closed.reduce((sum, n) => sum + n, 0)).toBe(1);
    const row = await connection(host.connectionId!);
    expect(row).toMatchObject({
      status: 'DISCONNECTED',
      disconnect_reason: 'STALE',
    });
    expect(
      (
        await Promise.all(connections.map((c) => c.markStaleConnections()))
      ).every((n) => n === 0),
    ).toBe(true);
    expect((await connection(host.connectionId!)).disconnected_at).toEqual(
      row.disconnected_at,
    );
    // The Agent learns it at its next heartbeat.
    await host.reply(host.send('HEARTBEAT', RUNNING)).catch(() => undefined);
    expect(await host.client.closedWith()).toMatchObject({
      reason: 'SESSION_CLOSED',
    });
  });

  it('refuses Agent state changes on an owner that cannot reach the database', async () => {
    const server = await register();
    const host = await agent(A(), server, PING_CAPS);
    const down = () => Promise.reject(new Error('database unreachable'));
    jest.spyOn(A().database, 'query').mockImplementation(down as never);
    jest.spyOn(A().database.manager, 'query').mockImplementation(down as never);
    jest.spyOn(A().database, 'transaction').mockImplementation(down as never);
    const eventId = randomUUID();
    const answer = await host.reply(
      host.event(
        'TRADE_SETTLEMENT',
        { workId: randomUUID(), outcome: 'SETTLED' },
        eventId,
      ),
    );
    expect(answer.payload).toMatchObject({ code: 'TEMPORARILY_UNAVAILABLE' });
    await http(A()).get('/api/v1/ready').expect(503);
    await http(B()).get('/api/v1/ready').expect(200);
    // No renewal without the database: the session is dropped.
    host.send('HEARTBEAT', RUNNING);
    await host.client.closedWith();
    jest.restoreAllMocks();
    expect(await receipts(eventId)).toBe(0);
    await http(A()).get('/api/v1/ready').expect(200);
  });

  it('keeps committing while A lost LISTEN, then A reconnects and hears B again', async () => {
    const before =
      (await metric(A(), /skyrim_admin_cluster_bus_reconnects_total (\d+)/)) ??
      0;
    const pid = get(A(), ClusterBus).listenerPid;
    expect(pid).toBeDefined();
    await admin.query('SELECT pg_terminate_backend($1)', [pid]);
    const session = await login(B());
    // Mutation on B commits whether or not A listens; HTTP shows the truth.
    await http(B())
      .patch('/api/v1/player/settings')
      .auth(session.accessToken, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ locale: 'fr-FR' })
      .expect(200);
    expect(
      (
        await http(A())
          .get('/api/v1/player/settings')
          .auth(session.accessToken, { type: 'bearer' })
          .expect(200)
      ).body.locale,
    ).toBe('fr-FR');
    await eventually(
      async () =>
        get(A(), ClusterBus).connected &&
        ((await metric(
          A(),
          /skyrim_admin_cluster_bus_reconnects_total (\d+)/,
        )) ?? 0) > before,
    );
    expect(await metric(A(), /skyrim_admin_cluster_bus_connected (\d+)/)).toBe(
      1,
    );
    const { client } = await socket(A(), 'PLAYER', session.accessToken);
    await http(B())
      .patch('/api/v1/player/settings')
      .auth(session.accessToken, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ locale: 'pt-BR' })
      .expect(200);
    await client.event('PLAYER_SETTINGS_UPDATED', 8000);
  });

  it('shares rate limits across replicas, with hashed keys, reset and expiry', async () => {
    const username = `nobody-${randomUUID().slice(0, 8)}`;
    const attempt = (node: Node) =>
      http(node)
        .post('/api/v1/auth/login')
        .send({ username, password: 'Wrong-Password-42' });
    for (const node of [A(), B(), A(), B()]) await attempt(node).expect(401);
    expect(
      Number((await attempt(A()).expect(429)).headers['retry-after']),
    ).toBeGreaterThan(0);
    await attempt(B()).expect(429);
    // Operator actions: one Staff quota split over both replicas.
    const requeue = (node: Node) =>
      http(node)
        .post(`/api/v1/operations/trades/${randomUUID()}/requeue`)
        .auth(tokens.COORDINATOR, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({ reason: 'quota test' });
    // Earlier tests of this minute already used this Staff quota (it is
    // shared): start from an empty window.
    await get(B(), RateLimiter).reset('operator-action');
    for (const node of [A(), B(), A(), B()]) await requeue(node).expect(404);
    await requeue(A()).expect(429);
    await requeue(B()).expect(429);
    await get(A(), RateLimiter).reset('operator-action');
    await requeue(B()).expect(404);
    // Window expiry through the shared store.
    const limiter = get(B(), RateLimiter);
    const rule = { limit: 1, windowMs: 1000 };
    const key = randomUUID();
    expect((await limiter.consume('expiry-test', key, rule)).allowed).toBe(
      true,
    );
    expect(
      (await get(A(), RateLimiter).consume('expiry-test', key, rule)).allowed,
    ).toBe(false);
    await pause(1100);
    expect(
      (await get(A(), RateLimiter).consume('expiry-test', key, rule)).allowed,
    ).toBe(true);
    const stored = JSON.stringify(
      await admin.query('SELECT scope, key_hash FROM rate_limit_buckets'),
    );
    expect(stored).not.toContain(username);
    expect(stored).not.toContain(key);
    expect(stored).not.toContain('127.0.0.1');
  });

  it('fails closed on a rate-limit store failure, open on a bus failure', async () => {
    const fail = () => Promise.reject(new Error('store down'));
    jest.spyOn(A().database, 'query').mockImplementation(fail as never);
    expect(
      await get(A(), RateLimiter).consume('fail-test', 'k', {
        limit: 100,
        windowMs: 60000,
      }),
    ).toEqual({ allowed: false, retryAfterSeconds: 1 });
    await http(A())
      .post('/api/v1/auth/login')
      .send({ username: 'coordinator', password })
      .expect(429);
    // The bus only loses a wake-up: publish never throws.
    await expect(
      get(A(), ClusterBus).publish('REALTIME', {}),
    ).resolves.toBeUndefined();
    jest.restoreAllMocks();
    expect(
      (await metric(
        A(),
        /skyrim_admin_rate_limit_backend_errors_total (\d+)/,
      )) ?? 0,
    ).toBeGreaterThan(0);
    await staffLogin(A(), 'coordinator');
  });

  it('counts leases of a crashed replica until they expire, then admits again', async () => {
    const session = await login(B());
    const c = nodes[2];
    await socket(c, 'PLAYER', session.accessToken);
    await socket(c, 'PLAYER', session.accessToken);
    const leases = get(c, RealtimeLeaseService);
    // C "crashes": no renewal, no release, no shutdown cleanup.
    clearInterval(
      (leases as unknown as { renewTimer: NodeJS.Timeout }).renewTimer,
    );
    jest.spyOn(leases, 'release').mockResolvedValue();
    jest.spyOn(leases, 'beforeApplicationShutdown').mockResolvedValue();
    await stop(c);
    nodes.splice(2, 1);
    const rows = Number(
      (
        await one(
          'SELECT count(*)::int AS n FROM realtime_connection_leases WHERE principal_id = $1 AND expires_at > now()',
          [session.player.id],
        )
      ).n,
    );
    expect(rows).toBe(2);
    const refused = await socket(B(), 'PLAYER', session.accessToken);
    expect(refused.authenticated).toBe(false);
    expect(await refused.client.closedWith()).toMatchObject({
      reason: 'CONNECTION_LIMIT',
    });
    // No manual cleanup: the leases simply expire.
    await eventually(
      async () =>
        (await socket(B(), 'PLAYER', session.accessToken)).authenticated,
      15000,
    );
  }, 30000);

  it('shuts one replica down without touching the others', async () => {
    const d = await spawn();
    nodes.push(d);
    const mine = await register();
    const theirs = await register();
    const onD = await agent(d, mine, PING_CAPS);
    const onA = await agent(A(), theirs, PING_CAPS);
    const session = await login(d);
    await socket(d, 'PLAYER', session.accessToken);
    get(d, LifecycleService).beginShutdown();
    await http(d).get('/api/v1/ready').expect(503);
    await stop(d);
    nodes.splice(nodes.indexOf(d), 1);
    expect(await onD.client.closedWith()).toMatchObject({ reason: 'SHUTDOWN' });
    expect(await connection(onD.connectionId!)).toMatchObject({
      status: 'DISCONNECTED',
      disconnect_reason: 'SHUTDOWN',
    });
    expect(await connection(onA.connectionId!)).toMatchObject({
      status: 'CONNECTED',
      owner_instance_id: A().id,
    });
    expect((await onA.heartbeat('RUNNING', true)).type).toBe('HEARTBEAT_ACK');
    expect(
      Number(
        (
          await one(
            'SELECT count(*)::int AS n FROM realtime_connection_leases WHERE instance_id = $1',
            [d.id],
          )
        ).n,
      ),
    ).toBe(0);
    expect(
      Number(
        (
          await one(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'skyrim-admin-api:bus' AND datname = current_database()",
          )
        ).n,
      ),
    ).toBeGreaterThanOrEqual(2);
    for (const node of nodes) await http(node).get('/api/v1/ready').expect(200);
  });

  it('exposes no instance, connection or session identifier as a metric label', async () => {
    const server = await register();
    const host = await agent(A(), server, PING_CAPS);
    const session = await login(A());
    await socket(A(), 'PLAYER', session.accessToken);
    for (const node of nodes) {
      const text = await get(node, Metrics).render();
      for (const id of [
        node.id,
        A().id,
        host.connectionId!,
        session.player.id,
        server.id,
      ])
        expect(text).not.toContain(id);
      expect(text).not.toMatch(/instance_?id|connection_?id|session_?id/i);
      expect(text).toMatch(/skyrim_admin_cluster_bus_connected 1/);
    }
  });

  it('upgrades a 26-migration database to 27 preserving data, with no drift', async () => {
    const upgrade = `multi_upgrade_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA "${upgrade}"`);
    const database = new DataSource({
      ...options,
      schema: upgrade,
      ...artifacts,
      extra: {
        ...(options as { extra?: object }).extra,
        options: `-c search_path=${upgrade},public`,
      },
    } as DataSourceOptions);
    await database.initialize();
    try {
      expect(await database.runMigrations()).toHaveLength(27);
      await database.undoLastMigration();
      expect(
        (await database.query('SELECT count(*)::int AS n FROM migrations'))[0]
          .n,
      ).toBe(26);
      // A session persisted before 12.5 (no owner).
      const [server] = await database.query(
        "INSERT INTO game_servers(code, name) VALUES ($1, 'Legacy') RETURNING id",
        [randomUUID()],
      );
      const [legacy] = await database.query(
        "INSERT INTO game_connections(game_server_id, external_connection_id, status, connected_at, last_heartbeat_at) VALUES ($1, 'legacy', 'CONNECTED', now(), now()) RETURNING id",
        [server.id],
      );
      expect(await database.runMigrations()).toHaveLength(1);
      expect(
        (
          await database.query(
            'SELECT status, owner_instance_id FROM game_connections WHERE id = $1',
            [legacy.id],
          )
        )[0],
      ).toEqual({ status: 'CONNECTED', owner_instance_id: null });
      expect(await database.showMigrations()).toBe(false);
      expect(database.options.synchronize).toBe(false);
      expect(
        (await database.driver.createSchemaBuilder().log()).upQueries,
      ).toEqual([]);
    } finally {
      await database.destroy();
      await admin.query(`DROP SCHEMA IF EXISTS "${upgrade}" CASCADE`);
    }
  });
});
