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
import {
  playerActor,
  systemActor,
  SystemSource,
} from '../src/actors/actor.contracts.js';
import { EconomyService } from '../src/economy/economy.service.js';
import { GameServerService } from '../src/game-bridge/game-server.service.js';
import type { GameServer } from '../src/game-bridge/entities/game-server.entity.js';
import { AgentSessionRegistry } from '../src/game-agent/agent-session.registry.js';
import { AgentWorkNotifier } from '../src/game-agent/agent-work.notifier.js';
import { DiscordIdentityProvider } from '../src/player-auth/discord-identity.provider.js';
import { PlayerAuthRateLimiter } from '../src/player-auth/player-auth-rate-limit.js';
import { CharacterLinkService } from '../src/player-characters/character-link.service.js';
import { VipEntitlementService } from '../src/vip-entitlements/vip-entitlement.service.js';
import { VipDeliveryService } from '../src/vip-entitlements/vip-delivery.service.js';
import { VipEntitlementScope } from '../src/vip-store/vip-offer.contracts.js';
import { BacklogCollector } from '../src/observability/backlog.collector.js';
import { Metrics } from '../src/observability/metrics.js';
import { RateLimiter } from '../src/common/rate-limit/rate-limiter.js';
import { FakeDiscordProvider } from './support/fake-discord-provider.js';
import { FakeAgent } from './support/fake-agent.js';
import type { Frame } from './support/fake-agent.js';
import { RealtimeTestClient } from './support/realtime-client.js';

const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;
const ENV = {
  AGENT_WORK_PUSH_INTERVAL_MS: '150',
  VIP_DELIVERY_WORKER_INTERVAL_MS: '100',
  GAME_COMMAND_WORKER_INTERVAL_MS: '100',
  METRICS_COLLECTION_INTERVAL_MS: '300000',
};
const GIVE_CAPS = [
  'GAME_COMMAND_V1',
  'COMMAND_DEDUP_V1',
  'CHARACTER_ITEM_GIVE',
  'CHARACTER_TITLE_GIVE',
];
type Session = {
  accessToken: string;
  refreshToken: string;
  player: { id: string };
};
type Party = { session: Session; link: string; char: string };
async function eventually<T>(
  check: () => Promise<T | undefined | false>,
  timeoutMs = 6000,
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

describeDatabase('Operational recovery (12.4) with real PostgreSQL', () => {
  let admin: DataSource, database: DataSource, app: INestApplication<App>;
  let servers: GameServerService, registry: AgentSessionRegistry;
  let links: CharacterLinkService, economy: EconomyService;
  let server: GameServer, url: string;
  const tokens = new Map<string, string>();
  const staffIds = new Map<string, string>();
  const agents: FakeAgent[] = [];
  const sockets: RealtimeTestClient[] = [];
  const discord = new FakeDiscordProvider();
  const schema = `ops_recovery_test_${randomUUID().replaceAll('-', '')}`;
  const http = () => request(app.getHttpServer());
  const staff = (role = 'COORDINATOR') => tokens.get(role)!;
  const ops = (
    method: 'get' | 'post',
    path: string,
    body?: object,
    options: { role?: string; key?: string | null; token?: string } = {},
  ) => {
    const call = http()
      [method](`/api/v1/operations/${path}`)
      .auth(options.token ?? staff(options.role), { type: 'bearer' });
    if (method === 'get') return call;
    const key = options.key === undefined ? randomUUID() : options.key;
    return (key === null ? call : call.set('Idempotency-Key', key)).send(
      body ?? {},
    );
  };
  const one = async (sql: string, params: unknown[] = []) =>
    (await database.query(sql, params))[0];
  const count = async (sql: string, params: unknown[] = []) =>
    Number((await one(`SELECT count(*)::int AS n FROM ${sql}`, params)).n);
  const credential = async (serverId: string) =>
    (
      await http()
        .post(`/api/v1/admin/game-servers/${serverId}/agent-credentials`)
        .auth(staff(), { type: 'bearer' })
        .expect(201)
    ).body as { credentialId: string; credentialSecret: string };
  const agent = async (capabilities: string[] = []) => {
    const created = new FakeAgent(url, server.id);
    agents.push(created);
    await created.hello(await credential(server.id), capabilities, {
      gameProcessState: 'RUNNING',
      skseReady: true,
    });
    return created;
  };
  const login = async (): Promise<Session> => {
    const code = `code-${randomUUID()}`;
    discord.codes.set(code, {
      subject: `${Date.now()}${Math.floor(Math.random() * 1e9)}`,
      displayName: 'Player',
    });
    return (
      await http()
        .post('/api/v1/player/auth/discord/exchange')
        .send({ authorizationCode: code, redirectUri: 'http://127.0.0.1/cb' })
        .expect(200)
    ).body;
  };
  const party = async (gold = 0): Promise<Party> => {
    const session = await login();
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
    method: 'post' | 'put' | 'get',
    session: Session,
    path: string,
    body?: object,
  ) => {
    const call = http()
      [method](`/api/v1/player/${path}`)
      .auth(session.accessToken, { type: 'bearer' });
    return method === 'get'
      ? call
      : call.set('Idempotency-Key', randomUUID()).send(body ?? {});
  };
  const balance = async (char: string) => {
    const row = await one(
      "SELECT balance FROM economy_accounts WHERE game_server_id = $1 AND owner_type = 'CHARACTER' AND character_external_id = $2",
      [server.id, char],
    );
    return row ? Number(row.balance) : 0;
  };
  const ack = (frame: Frame) =>
    expect.objectContaining({
      type: 'DOMAIN_EVENT_ACK',
      payload: expect.objectContaining({ eventId: frame.payload!.eventId }),
    });
  const audits = (action: string, resourceId: string) =>
    database.query(
      'SELECT actor_type, actor_staff_id, outcome, metadata FROM audit_logs WHERE action = $1 AND resource_id = $2 ORDER BY created_at',
      [action, resourceId],
    );
  // An UNCERTAIN Server Control operation, as the result deadline leaves it.
  const uncertain = async () => {
    const id = randomUUID();
    await database.query(
      `INSERT INTO server_control_operations(id, game_server_id, type, status, idempotency_key, correlation_id,
         requested_by_staff_id, dispatch_claimed_at, not_after, result_deadline_at, dispatched_at, completed_at, error_code)
       VALUES ($1, $2, 'SERVER_RESTART', 'UNCERTAIN', $3, $4, $5, now(), now(), now(), now(), now(), 'RESULT_TIMEOUT')`,
      [id, server.id, randomUUID(), randomUUID(), staffIds.get('COORDINATOR')],
    );
    return id;
  };
  // A trade locked AWAITING_GAME_CONFIRMATION with 300 GOLD in escrow.
  const awaitingTrade = async () => {
    const a = await party(1000);
    const b = await party(500);
    const opened = (
      await player('post', a.session, 'trades', {
        actorCharacterLinkId: a.link,
        targetCharacterId: b.char,
        offer: { gold: 300, items: [{ itemId: 'item:sword', quantity: 1 }] },
      }).expect(201)
    ).body;
    const view = (
      await player(
        'get',
        a.session,
        `trades/${opened.tradeId}?characterLinkId=${a.link}`,
      ).expect(200)
    ).body;
    await player('post', a.session, `trades/${opened.tradeId}/accept`, {
      characterLinkId: a.link,
      counterpartyOfferVersion: view.target.offer.version,
    }).expect(200);
    await player('post', b.session, `trades/${opened.tradeId}/accept`, {
      characterLinkId: b.link,
      counterpartyOfferVersion: view.initiator.offer.version,
    }).expect(200);
    return { a, b, tradeId: opened.tradeId as string };
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
    // Upgrade path: 25 migrations, then 12.4 alone.
    expect(await database.runMigrations()).toHaveLength(26);
    await database.undoLastMigration();
    expect(await database.runMigrations()).toHaveLength(1);
    const { AppModule } = await import('../src/app.module.js');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DataSource)
      .useValue(database)
      .overrideProvider(DiscordIdentityProvider)
      .useValue(discord)
      .compile();
    app = module.createNestApplication(new AppExpressAdapter());
    app.useLogger(false);
    setupApp(app);
    await app.listen(0, '127.0.0.1');
    const address = (
      app.getHttpServer() as unknown as Server
    ).address() as AddressInfo;
    url = `ws://127.0.0.1:${address.port}`;
    servers = app.get(GameServerService);
    registry = app.get(AgentSessionRegistry);
    links = app.get(CharacterLinkService);
    economy = app.get(EconomyService);
    const password = 'Operations-Password-42';
    const hash = await new PasswordService().hash(password);
    for (const role of [
      'COORDINATOR',
      'GENERAL_CHIEF',
      'ADMIN',
      'MODERATOR',
      'SUPPORT',
      'DEV',
    ]) {
      const [row] = await database.query(
        'INSERT INTO staff_users(username, display_name, password_hash, role_name) VALUES ($1, $1, $2, $3) RETURNING id',
        [role.toLowerCase(), hash, role],
      );
      staffIds.set(role, row.id);
      tokens.set(
        role,
        (
          await http()
            .post('/api/v1/auth/login')
            .send({ username: role.toLowerCase(), password })
            .expect(200)
        ).body.accessToken,
      );
    }
  }, 90000);
  beforeEach(async () => {
    app.get(PlayerAuthRateLimiter).reset();
    server = await servers.register({ code: randomUUID(), name: 'Home' });
  });
  afterEach(async () => {
    for (const socket of sockets.splice(0))
      if (!socket.closed) await socket.close();
    for (const created of agents.splice(0)) await created.close();
    await eventually(async () => registry.count() === 0);
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

  it('migrates forward to one schema: no pending migration, no drift, narrow grants', async () => {
    expect(await database.showMigrations()).toBe(false);
    expect(database.options.synchronize).toBe(false);
    expect(
      (await database.driver.createSchemaBuilder().log()).upQueries,
    ).toEqual([]);
    const grants = await database.query(
      `SELECT permission_name, array_agg(role_name ORDER BY role_name) AS roles FROM role_permissions
       WHERE permission_name IN ('OPERATIONS_READ', 'SERVER_CONTROL_RESOLVE', 'PLAYER_TRADE_RECOVER', 'PLAYER_MARKETPLACE_RECOVER', 'VIP_DELIVERY_RECOVER', 'PLAYER_ACCOUNT_MODERATE', 'PLAYER_ECONOMY_ADJUST', 'PLAYER_CHAT_MODERATE')
       GROUP BY permission_name ORDER BY permission_name`,
    );
    expect(
      Object.fromEntries(
        grants.map((g: { permission_name: string; roles: string[] }) => [
          g.permission_name,
          g.roles,
        ]),
      ),
    ).toEqual({
      OPERATIONS_READ: ['COORDINATOR', 'DEV', 'GENERAL_CHIEF'],
      PLAYER_ACCOUNT_MODERATE: ['ADMIN', 'COORDINATOR', 'GENERAL_CHIEF'],
      PLAYER_CHAT_MODERATE: [
        'ADMIN',
        'COORDINATOR',
        'GENERAL_CHIEF',
        'MODERATOR',
      ],
      PLAYER_ECONOMY_ADJUST: ['COORDINATOR'],
      PLAYER_MARKETPLACE_RECOVER: ['COORDINATOR', 'DEV', 'GENERAL_CHIEF'],
      PLAYER_TRADE_RECOVER: ['COORDINATOR', 'DEV', 'GENERAL_CHIEF'],
      SERVER_CONTROL_RESOLVE: ['COORDINATOR', 'DEV'],
      VIP_DELIVERY_RECOVER: ['COORDINATOR', 'GENERAL_CHIEF'],
    });
  });

  it('is Staff-only, fail-closed per domain, strict and idempotent by key', async () => {
    const id = randomUUID();
    const routes: ['get' | 'post', string, string, object?][] = [
      ['get', 'summary', 'OPERATIONS_READ'],
      ['get', 'domain-event-receipts', 'OPERATIONS_READ'],
      ['get', 'server-control/uncertain', 'SERVER_CONTROL_RESOLVE'],
      [
        'post',
        `server-control/${id}/resolve`,
        'SERVER_CONTROL_RESOLVE',
        { resolution: 'RESOLVED_FAILED', reason: 'x' },
      ],
      ['get', 'trades/awaiting', 'PLAYER_TRADE_RECOVER'],
      ['post', `trades/${id}/requeue`, 'PLAYER_TRADE_RECOVER', { reason: 'x' }],
      ['get', 'marketplace/releases', 'PLAYER_MARKETPLACE_RECOVER'],
      [
        'post',
        `marketplace/releases/${id}/resolve`,
        'PLAYER_MARKETPLACE_RECOVER',
        { resolution: 'RESOLVED_FAILED', reason: 'x' },
      ],
      ['get', 'vip-deliveries', 'VIP_DELIVERY_RECOVER'],
      [
        'post',
        `vip-deliveries/${id}/retry`,
        'VIP_DELIVERY_RECOVER',
        { reason: 'x' },
      ],
      [
        'post',
        `players/${id}/status`,
        'PLAYER_ACCOUNT_MODERATE',
        { status: 'BANNED', reason: 'x' },
      ],
      [
        'post',
        'economy/adjustments',
        'PLAYER_ECONOMY_ADJUST',
        {
          gameServerId: id,
          characterExternalId: 'c',
          direction: 'CREDIT',
          amount: 1,
          externalReference: 'T-1',
          reason: 'x',
        },
      ],
      [
        'post',
        `chat/messages/${id}/hide`,
        'PLAYER_CHAT_MODERATE',
        { reason: 'x' },
      ],
    ];
    // SUPPORT holds none of them; nothing is revealed about existence.
    for (const [method, path, , body] of routes)
      await ops(method, path, body, { role: 'SUPPORT' }).expect(403);
    // Roles outside a domain are refused too (least privilege).
    await ops('post', 'economy/adjustments', routes[11][3], {
      role: 'DEV',
    }).expect(403);
    await ops('get', 'vip-deliveries', undefined, { role: 'DEV' }).expect(403);
    await ops('get', 'server-control/uncertain', undefined, {
      role: 'GENERAL_CHIEF',
    }).expect(403);
    await ops('get', 'players/' + id, undefined, { role: 'MODERATOR' }).expect(
      403,
    );
    // No token, a Player token or an Agent secret: 401.
    await http().get('/api/v1/operations/summary').expect(401);
    const session = await login();
    await ops('get', 'summary', undefined, {
      token: session.accessToken,
    }).expect(401);
    const key = await credential(server.id);
    await ops('get', 'summary', undefined, {
      token: key.credentialSecret,
    }).expect(401);
    // Strict input: Idempotency-Key, bounded one-line reason, no extras.
    const operation = await uncertain();
    const path = `server-control/${operation}/resolve`;
    await ops(
      'post',
      path,
      { resolution: 'RESOLVED_FAILED', reason: 'ok' },
      { key: null },
    ).expect(400);
    await ops(
      'post',
      path,
      { resolution: 'RESOLVED_FAILED', reason: 'ok' },
      { key: 'bad key!' },
    ).expect(400);
    for (const reason of ['', '   ', 'a\nb', 'x'.repeat(501)])
      await ops('post', path, { resolution: 'RESOLVED_FAILED', reason }).expect(
        400,
      );
    await ops('post', path, { resolution: 'RETRY', reason: 'ok' }).expect(400);
    await ops('post', path, {
      resolution: 'RESOLVED_FAILED',
      reason: 'ok',
      status: 'SUCCEEDED',
    }).expect(400);
    await ops('post', 'server-control/not-a-uuid/resolve', {
      resolution: 'RESOLVED_FAILED',
      reason: 'ok',
    }).expect(400);
    expect(await count('operator_actions')).toBe(0);
    // Rate limited per Staff user.
    const limiter = app.get(RateLimiter);
    for (let i = 0; i < 1000; i++)
      limiter.consume('operator-action', staffIds.get('DEV')!, {
        limit: 1000,
        windowMs: 60_000,
      });
    const limited = await ops(
      'post',
      path,
      { resolution: 'RESOLVED_FAILED', reason: 'ok' },
      { role: 'DEV' },
    ).expect(429);
    expect(limited.headers['retry-after']).toBeDefined();
    limiter.reset('operator-action');
  });

  it('resolves Server Control UNCERTAIN once, never retries, keeps the original outcome and the history', async () => {
    const id = await uncertain();
    const listed = (
      await ops(
        'get',
        `server-control/uncertain?gameServerId=${server.id}&resolved=false`,
      ).expect(200)
    ).body;
    expect(listed.items).toMatchObject([
      {
        operationId: id,
        status: 'UNCERTAIN',
        errorCode: 'RESULT_TIMEOUT',
        resolution: null,
        stale: false,
      },
    ]);
    const collector = app.get(BacklogCollector);
    const metrics = app.get(Metrics);
    const gauge = async () => {
      expect(await collector.collect()).toBe(true);
      const text = await metrics.render();
      return {
        uncertain: Number(
          /skyrim_admin_server_control_operations\{status="UNCERTAIN"\} (\d+)/.exec(
            text,
          )![1],
        ),
        unresolved: Number(
          /skyrim_admin_recovery_unresolved\{domain="server_control"\} (\d+)/.exec(
            text,
          )![1],
        ),
      };
    };
    const initial = await gauge();
    expect(initial.uncertain).toBeGreaterThanOrEqual(1);
    expect(initial.unresolved).toBe(initial.uncertain);
    // Staff realtime wake-up to the domain permission.
    const watcher = new RealtimeTestClient(`${url}/api/v1/realtime`);
    sockets.push(watcher);
    await watcher.authenticate('STAFF', staff('DEV'));
    const key = randomUUID();
    const body = {
      resolution: 'RESOLVED_FAILED',
      reason: 'Server found stopped after the restart window',
    };
    // Two operators at once: exactly one resolution.
    const [first, second] = await Promise.all([
      ops('post', `server-control/${id}/resolve`, body, { key }),
      ops(
        'post',
        `server-control/${id}/resolve`,
        { ...body, resolution: 'RESOLVED_SUCCEEDED' },
        { role: 'DEV' },
      ),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const winner = first.status === 200 ? first.body : second.body;
    expect(winner).toMatchObject({
      domain: 'SERVER_CONTROL',
      resourceId: id,
      status: 'UNCERTAIN',
      errorCode: 'RESULT_TIMEOUT',
      replayed: false,
    });
    // Replay of the same request: same result, nothing new.
    if (first.status === 200) {
      const again = (
        await ops('post', `server-control/${id}/resolve`, body, { key }).expect(
          200,
        )
      ).body;
      expect(again).toEqual({ ...first.body, replayed: true });
      // Same key, another request: refused.
      await ops(
        'post',
        `server-control/${id}/resolve`,
        { ...body, reason: 'other' },
        { key },
      ).expect(409);
    }
    const row = await one(
      'SELECT status, error_code, resolution, resolved_by_staff_id, resolution_reason FROM server_control_operations WHERE id = $1',
      [id],
    );
    expect(row).toMatchObject({
      status: 'UNCERTAIN',
      error_code: 'RESULT_TIMEOUT',
      resolution: winner.resolution,
    });
    expect(
      await count('server_control_operations WHERE game_server_id = $1', [
        server.id,
      ]),
    ).toBe(1);
    expect(await count('operator_actions WHERE resource_id = $1', [id])).toBe(
      1,
    );
    // Read API shows the resolution; the status is still the original.
    expect(
      (
        await http()
          .get(`/api/v1/server-control-operations/${id}`)
          .auth(staff(), { type: 'bearer' })
          .expect(200)
      ).body,
    ).toMatchObject({
      status: 'UNCERTAIN',
      resolution: winner.resolution,
    });
    expect(await audits('SERVER_CONTROL_UNCERTAIN_RESOLVED', id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actor_type: 'STAFF', outcome: 'SUCCESS' }),
        expect.objectContaining({ outcome: 'FAILURE' }),
      ]),
    );
    const event = (await watcher.event('STAFF_OPERATIONS_UPDATED')) as {
      data: Record<string, unknown>;
    };
    expect(event.data).toMatchObject({
      domain: 'SERVER_CONTROL',
      resourceId: id,
    });
    // Unresolved gauge drops; the historical counter is untouched.
    expect(await gauge()).toEqual({
      uncertain: initial.uncertain - 1,
      unresolved: initial.unresolved - 1,
    });
    const text = await metrics.render();
    expect(text).toMatch(
      /skyrim_admin_recovery_resolved\{domain="server_control"\} [1-9]/,
    );
    expect(text).toMatch(
      /skyrim_admin_operator_actions_total\{domain="server_control",action="resolve_(failed|succeeded)",outcome="applied"\} 1/,
    );
    expect(text).toMatch(
      /operator_actions_total\{domain="server_control",action="[a-z_]+",outcome="rejected"\} [1-9]/,
    );
    expect(text).not.toContain(id);
    // Not UNCERTAIN: nothing to resolve. There is no retry route at all.
    const done = { id: await uncertain() };
    await database.query(
      `UPDATE server_control_operations SET status = 'FAILED', error_code = 'DELIVERY_EXPIRED' WHERE id = $1`,
      [done.id],
    );
    await ops('post', `server-control/${done.id}/resolve`, body).expect(409);
    await ops('post', `server-control/${id}/retry`, { reason: 'x' }).expect(
      404,
    );
  });

  it('requeues an AWAITING trade as the same work: no new trade, settlement or GOLD', async () => {
    const { a, b, tradeId } = await awaitingTrade();
    const host = await agent();
    await eventually(async () =>
      host
        .pushes()
        .some((p) =>
          (p.payload!.items as { workId: string }[]).some(
            (i) => i.workId === tradeId,
          ),
        ),
    );
    const listed = (
      await ops('get', `trades/awaiting?gameServerId=${server.id}`).expect(200)
    ).body;
    expect(listed.items).toMatchObject([
      {
        tradeId,
        workId: tradeId,
        agentConnected: true,
        reservedGold: 300,
        itemLines: 1,
        lastRejection: null,
      },
    ]);
    const before = {
      trades: await count('player_trades'),
      transactions: await count('economy_transactions'),
      a: await balance(a.char),
      b: await balance(b.char),
      pushed: host.pushes().length,
    };
    const requeued = (
      await ops(
        'post',
        `trades/${tradeId}/requeue`,
        { reason: 'Agent restarted mid-trade' },
        { role: 'DEV' },
      ).expect(200)
    ).body;
    expect(requeued).toMatchObject({
      action: 'REQUEUE_SAME_WORK',
      outcome: 'REQUEUED',
      workId: tradeId,
      agentConnected: true,
    });
    // Pushed again, same workId.
    await eventually(async () => host.pushes().length > before.pushed);
    expect(
      host
        .pushes()
        .slice(before.pushed)
        .flatMap((p) =>
          (p.payload!.items as { workId: string }[]).map((i) => i.workId),
        ),
    ).toEqual([tradeId]);
    expect({
      trades: await count('player_trades'),
      transactions: await count('economy_transactions'),
      a: await balance(a.char),
      b: await balance(b.char),
    }).toEqual({
      trades: before.trades,
      transactions: before.transactions,
      a: before.a,
      b: before.b,
    });
    // The Agent settles it once; a late duplicate is noted, never applied.
    const settled = host.event('TRADE_SETTLEMENT', {
      workId: tradeId,
      outcome: 'SETTLED',
    });
    expect(await host.reply(settled)).toEqual(ack(settled));
    expect(await balance(b.char)).toBe(800);
    const late = host.event('TRADE_SETTLEMENT', {
      workId: tradeId,
      outcome: 'SETTLED',
    });
    await host.reply(late);
    expect(
      await one(
        'SELECT reason, rejection_count FROM agent_work_rejections WHERE work_id = $1',
        [tradeId],
      ),
    ).toEqual({
      reason: 'TRADE_NOT_AWAITING',
      rejection_count: 1,
    });
    expect(await balance(b.char)).toBe(800);
    await ops('post', `trades/${tradeId}/requeue`, { reason: 'again' }).expect(
      409,
    );
    await ops('post', `trades/${randomUUID()}/requeue`, {
      reason: 'unknown',
    }).expect(404);
    expect((await audits('AGENT_WORK_REQUEUED', tradeId))[0]).toMatchObject({
      actor_type: 'STAFF',
      actor_staff_id: staffIds.get('DEV'),
      outcome: 'SUCCESS',
    });
    // No auto-fail by age: an old AWAITING trade is only flagged stale.
    const old = await awaitingTrade();
    // (Fixture only: the lifecycle trigger forbids rewriting locked_at.)
    await database.query(
      'ALTER TABLE player_trades DISABLE TRIGGER player_trades_guard',
    );
    try {
      await database.query(
        "UPDATE player_trades SET locked_at = now() - interval '2 days' WHERE id = $1",
        [old.tradeId],
      );
    } finally {
      await database.query(
        'ALTER TABLE player_trades ENABLE TRIGGER player_trades_guard',
      );
    }
    const aged = (
      await ops('get', `trades/awaiting?gameServerId=${server.id}`).expect(200)
    ).body;
    expect(aged.items).toMatchObject([{ tradeId: old.tradeId, stale: true }]);
    await pause(300);
    expect(
      (
        await one('SELECT status FROM player_trades WHERE id = $1', [
          old.tradeId,
        ])
      ).status,
    ).toBe('AWAITING_GAME_CONFIRMATION');
  });

  it('marketplace: requeues custody as the same work, never retries a FAILED release, acknowledges and resolves it once', async () => {
    const seller = await party();
    const listed = (
      await player('post', seller.session, 'marketplace/listings', {
        characterLinkId: seller.link,
        itemId: 'item:bow',
        quantity: 1,
        priceGold: 100,
      }).expect(201)
    ).body;
    const custody = (
      await ops('get', `marketplace/custody?gameServerId=${server.id}`).expect(
        200,
      )
    ).body;
    expect(custody.items).toMatchObject([
      { listingId: listed.listingId, agentConnected: false },
    ]);
    expect(
      (
        await ops('post', `marketplace/custody/${listed.listingId}/requeue`, {
          reason: 'Agent was offline',
        }).expect(200)
      ).body,
    ).toMatchObject({
      outcome: 'REQUEUED',
      agentConnected: false,
    });
    const host = await agent();
    const custodied = host.event('MARKETPLACE_CUSTODY', {
      workId: listed.listingId,
      outcome: 'CUSTODIED',
    });
    expect(await host.reply(custodied)).toEqual(ack(custodied));
    await ops('post', `marketplace/custody/${listed.listingId}/requeue`, {
      reason: 'late',
    }).expect(409);
    await http()
      .post(`/api/v1/player/marketplace/listings/${listed.listingId}/cancel`)
      .auth(seller.session.accessToken, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ characterLinkId: seller.link })
      .expect(200);
    const release = await one(
      'SELECT id, status FROM player_marketplace_item_releases WHERE listing_id = $1',
      [listed.listingId],
    );
    expect(release.status).toBe('PENDING');
    await ops('post', `marketplace/releases/${release.id}/requeue`, {
      reason: 'push again',
    }).expect(200);
    await ops('post', `marketplace/releases/${release.id}/resolve`, {
      resolution: 'RESOLVED_SUCCEEDED',
      reason: 'too early',
    }).expect(409);
    const failed = host.event('MARKETPLACE_RELEASE', {
      workId: release.id,
      outcome: 'FAILED',
    });
    expect(await host.reply(failed)).toEqual(ack(failed));
    // FAILED: no requeue, no retry route; acknowledge changes nothing.
    await ops('post', `marketplace/releases/${release.id}/requeue`, {
      reason: 'retry?',
    }).expect(409);
    await ops('post', `marketplace/releases/${release.id}/retry`, {
      reason: 'retry?',
    }).expect(404);
    expect(
      (
        await ops('post', `marketplace/releases/${release.id}/acknowledge`, {
          reason: 'Ticket 881 opened',
        }).expect(200)
      ).body,
    ).toMatchObject({
      outcome: 'ACKNOWLEDGED',
      status: 'FAILED',
    });
    const queue = (
      await ops(
        'get',
        `marketplace/releases?gameServerId=${server.id}&status=FAILED&resolved=false`,
      ).expect(200)
    ).body;
    expect(queue.items).toMatchObject([
      {
        releaseId: release.id,
        status: 'FAILED',
        errorCode: 'RELEASE_FAILED',
        resolution: null,
      },
    ]);
    const summary = (
      await ops('get', 'summary', undefined, { role: 'DEV' }).expect(200)
    ).body;
    expect(
      summary.queues.find(
        (q: { queue: string }) => q.queue === 'marketplace_release_failed',
      ).count,
    ).toBeGreaterThanOrEqual(1);
    const resolved = (
      await ops('post', `marketplace/releases/${release.id}/resolve`, {
        resolution: 'RESOLVED_SUCCEEDED',
        reason: 'Item found with the seller',
      }).expect(200)
    ).body;
    expect(resolved).toMatchObject({
      outcome: 'RESOLVED_SUCCEEDED',
      status: 'FAILED',
    });
    await ops('post', `marketplace/releases/${release.id}/resolve`, {
      resolution: 'RESOLVED_FAILED',
      reason: 'twice',
    }).expect(409);
    expect(
      await one(
        'SELECT status, release_event_id IS NOT NULL AS evented, resolution FROM player_marketplace_item_releases WHERE id = $1',
        [release.id],
      ),
    ).toEqual({
      status: 'FAILED',
      evented: true,
      resolution: 'RESOLVED_SUCCEEDED',
    });
    expect(
      await count('player_marketplace_item_releases WHERE listing_id = $1', [
        listed.listingId,
      ]),
    ).toBe(1);
    expect(
      (
        await ops(
          'get',
          `marketplace/releases?gameServerId=${server.id}&resolved=false&status=FAILED`,
        ).expect(200)
      ).body.items,
    ).toEqual([]);
  });

  describe('VIP deliveries', () => {
    const offer = async () =>
      (
        await http()
          .post('/api/v1/admin/vip-store/offers')
          .auth(staff(), { type: 'bearer' })
          .send({
            code: `vip_${randomUUID().slice(0, 8)}`,
            name: 'VIP',
            description: 'Benefit',
            priceMinor: 990,
            currency: 'BRL',
            rewards: [{ type: 'TITLE', titleId: 'title:hero' }],
            entitlementScope: 'CHARACTER',
            active: true,
          })
          .expect(201)
      ).body as { id: string };
    const grant = async (char: string) => {
      const result = await app.get(VipEntitlementService).grant({
        offerId: (await offer()).id,
        target: {
          scope: VipEntitlementScope.CHARACTER,
          gameServerId: server.id,
          characterExternalId: char,
        },
        actor: systemActor(SystemSource.VIP_DELIVERY),
        idempotencyKey: randomUUID(),
      });
      return (result as { entitlementId: string }).entitlementId;
    };
    const delivery = async (entitlementId: string) =>
      one('SELECT * FROM vip_reward_deliveries WHERE entitlement_id = $1', [
        entitlementId,
      ]);
    const commanded = (entitlementId: string, attempt = 1) =>
      eventually(async () => {
        const row = await delivery(entitlementId);
        return (
          row.status === 'COMMAND_CREATED' && row.attempt === attempt && row
        );
      });

    it('retries only a proven pre-effect failure, with a new command and the history kept', async () => {
      const host = await agent(GIVE_CAPS);
      const entitlement = await grant(`char:${randomUUID()}`);
      const first = await commanded(entitlement);
      // The command expired without ever being delivered (the dispatcher's
      // DISPATCH_EXPIRED path, which only exists while PENDING).
      await host.close();
      // The dispatcher's store.finish for this path, as SQL, atomically
      // and only while the command is still open.
      await database.transaction(async (manager) => {
        const [locked] = await manager.query(
          "SELECT id FROM game_commands WHERE id = $1 AND status IN ('PENDING', 'DISPATCHED') FOR UPDATE",
          [first.game_command_id],
        );
        expect(locked).toBeDefined();
        await manager.query(
          "UPDATE game_commands SET status = 'FAILED', completed_at = now(), dispatch_lease_id = NULL, dispatch_lease_expires_at = NULL WHERE id = $1",
          [first.game_command_id],
        );
        await manager.query(
          "INSERT INTO game_command_results(game_command_id, outcome, error_code, error_message, received_at) VALUES ($1, 'FAILED', 'DISPATCH_EXPIRED', 'No eligible Agent before the dispatch deadline', now())",
          [first.game_command_id],
        );
      });
      await app.get(VipDeliveryService).reconcile();
      expect(await delivery(entitlement)).toMatchObject({
        status: 'FAILED',
        error_code: 'DISPATCH_EXPIRED',
      });
      const queue = (
        await ops(
          'get',
          `vip-deliveries?gameServerId=${server.id}`,
          undefined,
          { role: 'GENERAL_CHIEF' },
        ).expect(200)
      ).body;
      expect(queue.items).toMatchObject([
        {
          deliveryId: first.id,
          status: 'FAILED',
          evidence: 'PRE_EFFECT_FAILURE',
          retryable: true,
          attempt: 1,
        },
      ]);
      // "Confirmed delivered" is impossible for a proven non-delivery.
      await ops('post', `vip-deliveries/${first.id}/resolve`, {
        resolution: 'CONFIRMED_DELIVERED',
        reason: 'x',
      }).expect(409);
      const key = randomUUID();
      const [one1, two1] = await Promise.all([
        ops(
          'post',
          `vip-deliveries/${first.id}/retry`,
          { reason: 'Agent offline during event' },
          { key },
        ),
        ops(
          'post',
          `vip-deliveries/${first.id}/retry`,
          { reason: 'Agent offline during event' },
          { key },
        ),
      ]);
      // Same key, concurrent: one effect, one replay.
      expect([one1.status, two1.status]).toEqual([200, 200]);
      expect([one1.body.replayed, two1.body.replayed].sort()).toEqual([
        false,
        true,
      ]);
      expect(one1.body).toMatchObject({
        outcome: 'RETRY_SCHEDULED',
        attempt: 2,
        previousErrorCode: 'DISPATCH_EXPIRED',
      });
      expect(
        await count('vip_reward_delivery_attempts WHERE delivery_id = $1', [
          first.id,
        ]),
      ).toBe(1);
      const next = await agent(GIVE_CAPS);
      const second = await commanded(entitlement, 2);
      expect(second.game_command_id).not.toBe(first.game_command_id);
      expect(
        (
          await one('SELECT idempotency_key FROM game_commands WHERE id = $1', [
            second.game_command_id,
          ])
        ).idempotency_key,
      ).toBe(`vip-delivery:${first.id}:2`);
      // Never two live commands: the new attempt is the only open one.
      await ops('post', `vip-deliveries/${first.id}/retry`, {
        reason: 'double',
      }).expect(409);
      const sent = await next.command(second.game_command_id);
      next.ack(sent);
      await next.reply(
        next.result(sent.payload!, {
          outcome: 'SUCCEEDED',
          result: {
            characterId: first.character_external_id,
            applied: true,
            targetId: 'title:hero',
          },
        }),
      );
      await eventually(
        async () => (await delivery(entitlement)).status === 'SUCCEEDED',
      );
      const detail = (
        await ops('get', `vip-deliveries/${first.id}`).expect(200)
      ).body;
      expect(detail).toMatchObject({
        status: 'SUCCEEDED',
        attempt: 2,
        previousAttempts: [
          {
            attempt: 1,
            gameCommandId: first.game_command_id,
            status: 'FAILED',
            errorCode: 'DISPATCH_EXPIRED',
            retriedByStaffId: staffIds.get('COORDINATOR'),
          },
        ],
      });
      // One accepted retry; the refused one is audited as FAILURE.
      expect(
        (await audits('VIP_DELIVERY_RETRIED', first.id)).map(
          (a: { outcome: string }) => a.outcome,
        ),
      ).toEqual(['SUCCESS', 'FAILURE']);
    });

    it('never retries a possibly executed attempt before an operator confirms it was not delivered', async () => {
      const host = await agent(GIVE_CAPS);
      const entitlement = await grant(`char:${randomUUID()}`);
      const first = await commanded(entitlement);
      const sent = await host.command(first.game_command_id);
      host.ack(sent);
      await host.reply(host.result(sent.payload!, { outcome: 'UNCERTAIN' }));
      await eventually(
        async () => (await delivery(entitlement)).status === 'UNCERTAIN',
      );
      await ops('post', `vip-deliveries/${first.id}/retry`, {
        reason: 'blind',
      }).expect(409);
      expect((await delivery(entitlement)).status).toBe('UNCERTAIN');
      const listed = (
        await ops(
          'get',
          `vip-deliveries?gameServerId=${server.id}&status=UNCERTAIN`,
        ).expect(200)
      ).body;
      expect(listed.items).toMatchObject([
        { evidence: 'POSSIBLY_EXECUTED', retryable: false },
      ]);
      await ops('post', `vip-deliveries/${first.id}/resolve`, {
        resolution: 'CONFIRMED_NOT_DELIVERED',
        reason: 'Title absent in game',
      }).expect(200);
      await ops('post', `vip-deliveries/${first.id}/resolve`, {
        resolution: 'CONFIRMED_DELIVERED',
        reason: 'twice',
      }).expect(409);
      expect(
        (
          await ops('post', `vip-deliveries/${first.id}/retry`, {
            reason: 'Confirmed absent',
          }).expect(200)
        ).body,
      ).toMatchObject({ attempt: 2, evidence: 'POSSIBLY_EXECUTED' });
      expect(
        await one(
          'SELECT status, resolution FROM vip_reward_delivery_attempts WHERE delivery_id = $1',
          [first.id],
        ),
      ).toEqual({
        status: 'UNCERTAIN',
        resolution: 'CONFIRMED_NOT_DELIVERED',
      });
      // A delivery confirmed as delivered is closed for good.
      const other = await grant(`char:${randomUUID()}`);
      const row = await commanded(other);
      const frame = await host.command(row.game_command_id);
      host.ack(frame);
      await host.reply(
        host.result(frame.payload!, {
          outcome: 'FAILED',
          errorCode: 'EXECUTION_FAILED',
        }),
      );
      await eventually(async () => (await delivery(other)).status === 'FAILED');
      await ops('post', `vip-deliveries/${row.id}/retry`, {
        reason: 'after a remote failure',
      }).expect(409);
      await ops('post', `vip-deliveries/${row.id}/resolve`, {
        resolution: 'CONFIRMED_DELIVERED',
        reason: 'Title present',
      }).expect(200);
      await ops('post', `vip-deliveries/${row.id}/retry`, {
        reason: 'no',
      }).expect(409);
      expect(
        await count("game_commands WHERE payload->>'characterId' = $1", [
          row.character_external_id,
        ]),
      ).toBe(1);
    });
  });

  it('suspends and bans accounts: every session revoked, realtime closed, ACTIVE revives nothing', async () => {
    const session = await login();
    const second = await login();
    expect(second.player.id).not.toBe(session.player.id);
    const socket = new RealtimeTestClient(`${url}/api/v1/realtime`);
    sockets.push(socket);
    await socket.authenticate('PLAYER', session.accessToken);
    const other = new RealtimeTestClient(`${url}/api/v1/realtime`);
    sockets.push(other);
    await other.authenticate('PLAYER', second.accessToken);
    const playerId = session.player.id;
    expect(
      (
        await ops('get', `players/${playerId}`, undefined, {
          role: 'ADMIN',
        }).expect(200)
      ).body,
    ).toMatchObject({ status: 'ACTIVE', activeSessions: 1 });
    const suspended = (
      await ops(
        'post',
        `players/${playerId}/status`,
        { status: 'SUSPENDED', reason: 'Chargeback investigation' },
        { role: 'ADMIN' },
      ).expect(200)
    ).body;
    expect(suspended).toMatchObject({
      previousStatus: 'ACTIVE',
      status: 'SUSPENDED',
      revokedSessions: 1,
      outcome: 'CHANGED',
    });
    expect(await socket.closedWith()).toEqual({
      code: 4001,
      reason: 'ACCOUNT_DISABLED',
    });
    // Another account is untouched.
    await pause(100);
    expect(other.closed).toBeNull();
    await http()
      .get('/api/v1/player/me')
      .auth(session.accessToken, { type: 'bearer' })
      .expect((r) => expect([401, 403]).toContain(r.status));
    await http()
      .post('/api/v1/player/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect((r) => expect([401, 403]).toContain(r.status));
    const banned = (
      await ops('post', `players/${playerId}/status`, {
        status: 'BANNED',
        reason: 'Confirmed fraud',
      }).expect(200)
    ).body;
    expect(banned).toMatchObject({
      previousStatus: 'SUSPENDED',
      status: 'BANNED',
      revokedSessions: 0,
    });
    await ops('post', `players/${playerId}/status`, {
      status: 'ACTIVE',
      reason: 'Appeal accepted',
    }).expect(200);
    // No resurrection: the old refresh token stays dead; a new login works.
    await http()
      .post('/api/v1/player/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(401);
    expect(
      (
        await one(
          'SELECT count(*)::int AS n FROM player_sessions WHERE player_id = $1 AND revoked_at IS NULL',
          [playerId],
        )
      ).n,
    ).toBe(0);
    expect(
      (await audits('PLAYER_ACCOUNT_STATUS_CHANGED', playerId)).map(
        (a: { metadata: { status: string } }) => a.metadata.status,
      ),
    ).toEqual(['SUSPENDED', 'BANNED', 'ACTIVE']);
    await ops('post', `players/${randomUUID()}/status`, {
      status: 'BANNED',
      reason: 'x',
    }).expect(404);
  });

  it('adjusts wallets only through balanced ledger postings, idempotently and within invariants', async () => {
    const p = await party(100);
    const body = {
      gameServerId: server.id,
      characterExternalId: p.char,
      direction: 'CREDIT',
      amount: 250,
      externalReference: 'TICKET-42',
      reason: 'Compensation for lost trade',
    };
    const key = randomUUID();
    const credited = (
      await ops('post', 'economy/adjustments', body, { key }).expect(200)
    ).body;
    expect(credited).toMatchObject({
      outcome: 'POSTED',
      balance: 350,
      amount: 250,
      direction: 'CREDIT',
    });
    expect(
      (await ops('post', 'economy/adjustments', body, { key }).expect(200))
        .body,
    ).toEqual({ ...credited, replayed: true });
    expect(await balance(p.char)).toBe(350);
    const tx = await one(
      'SELECT type, actor_type, actor_staff_id, reference_type, reference_id FROM economy_transactions WHERE id = $1',
      [credited.transactionId],
    );
    expect(tx).toEqual({
      type: 'STAFF_ADJUSTMENT',
      actor_type: 'STAFF',
      actor_staff_id: staffIds.get('COORDINATOR'),
      reference_type: 'STAFF_ADJUSTMENT',
      reference_id: 'TICKET-42',
    });
    expect(
      await count('economy_transactions WHERE type = $1', ['STAFF_ADJUSTMENT']),
    ).toBe(1);
    // Never below zero; nothing posted, audited as a failure.
    await ops('post', 'economy/adjustments', {
      ...body,
      direction: 'DEBIT',
      amount: 351,
    }).expect(409);
    expect(await balance(p.char)).toBe(350);
    await ops('post', 'economy/adjustments', {
      ...body,
      direction: 'DEBIT',
      amount: 50,
    }).expect(200);
    expect(await balance(p.char)).toBe(300);
    // No set-balance, no zero/negative/fractional amounts, no unknown wallet.
    for (const bad of [
      { amount: 0 },
      { amount: -5 },
      { amount: 1.5 },
      { amount: 1e13 },
      { direction: 'SET' },
      { balance: 10 },
      { externalReference: 'has space' },
    ])
      await ops('post', 'economy/adjustments', { ...body, ...bad }).expect(400);
    await ops('post', 'economy/adjustments', {
      ...body,
      characterExternalId: 'char:typo',
    }).expect(404);
    expect(
      await count('economy_accounts WHERE character_external_id = $1', [
        'char:typo',
      ]),
    ).toBe(0);
    // The ledger stays balanced; the Player sees the posting in history.
    expect(
      await database.query(
        'SELECT transaction_id FROM economy_entries GROUP BY transaction_id HAVING sum(amount) <> 0',
      ),
    ).toEqual([]);
    const history = (
      await player(
        'get',
        p.session,
        `me/characters/${p.link}/wallet/transactions`,
      ).expect(200)
    ).body;
    expect(history.items.map((i: { type: string }) => i.type)).toContain(
      'STAFF_ADJUSTMENT',
    );
    expect(
      (
        await ops(
          'get',
          `economy/${server.id}/wallets/${encodeURIComponent(p.char)}`,
        ).expect(200)
      ).body.balance,
    ).toBe(300);
    expect(
      (await audits('ECONOMY_STAFF_ADJUSTED', credited.transactionId))[0],
    ).toMatchObject({ actor_type: 'STAFF', outcome: 'SUCCESS' });
    // Ledger rows remain append-only.
    await expect(
      database.query(
        'UPDATE economy_transactions SET reference_id = NULL WHERE id = $1',
        [credited.transactionId],
      ),
    ).rejects.toThrow();
  });

  it('hides a chat message from every Player read without deleting it', async () => {
    const p = await party();
    const sent = (
      await http()
        .post('/api/v1/player/chat/global')
        .auth(p.session.accessToken, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({ characterLinkId: p.link, message: 'offensive text' })
        .expect(201)
    ).body;
    const history = () =>
      player('get', p.session, `me/characters/${p.link}/chat/global`).expect(
        200,
      );
    expect((await history()).body.items).toHaveLength(1);
    const listed = (
      await ops('get', `chat/messages?gameServerId=${server.id}`, undefined, {
        role: 'MODERATOR',
      }).expect(200)
    ).body;
    expect(listed.items).toMatchObject([
      {
        messageId: sent.messageId,
        message: 'offensive text',
        moderatedAt: null,
      },
    ]);
    await ops(
      'post',
      `chat/messages/${sent.messageId}/hide`,
      { reason: 'Harassment report 17' },
      { role: 'MODERATOR' },
    ).expect(200);
    await ops(
      'post',
      `chat/messages/${sent.messageId}/hide`,
      { reason: 'twice' },
      { role: 'MODERATOR' },
    ).expect(409);
    expect((await history()).body.items).toEqual([]);
    expect(
      await one(
        'SELECT content, moderated_by_staff_id FROM player_chat_messages WHERE id = $1',
        [sent.messageId],
      ),
    ).toEqual({
      content: 'offensive text',
      moderated_by_staff_id: staffIds.get('MODERATOR'),
    });
    // Still append-only: content cannot change, the hide cannot be undone,
    // a live message cannot be deleted.
    await expect(
      database.query(
        "UPDATE player_chat_messages SET content = 'x' WHERE id = $1",
        [sent.messageId],
      ),
    ).rejects.toThrow('append-only');
    await expect(
      database.query(
        'UPDATE player_chat_messages SET moderated_at = NULL, moderated_by_staff_id = NULL, moderation_reason = NULL WHERE id = $1',
        [sent.messageId],
      ),
    ).rejects.toThrow('append-only');
    await expect(
      database.query('DELETE FROM player_chat_messages WHERE id = $1', [
        sent.messageId,
      ]),
    ).rejects.toThrow('purged after expiry');
    const audit = (
      await audits('PLAYER_CHAT_MESSAGE_HIDDEN', sent.messageId)
    )[0];
    expect(audit).toMatchObject({ actor_type: 'STAFF', outcome: 'SUCCESS' });
    expect(JSON.stringify(audit.metadata)).not.toContain('offensive');
  });

  it('is atomic: an Audit failure rolls the intervention back entirely', async () => {
    const id = await uncertain();
    await database.query(
      "ALTER TABLE audit_logs ADD CONSTRAINT recovery_audit_failure CHECK (action <> 'SERVER_CONTROL_UNCERTAIN_RESOLVED') NOT VALID",
    );
    try {
      await ops('post', `server-control/${id}/resolve`, {
        resolution: 'RESOLVED_FAILED',
        reason: 'x',
      }).expect(503);
    } finally {
      await database.query(
        'ALTER TABLE audit_logs DROP CONSTRAINT recovery_audit_failure',
      );
    }
    expect(
      await one(
        'SELECT resolution FROM server_control_operations WHERE id = $1',
        [id],
      ),
    ).toEqual({ resolution: null });
    expect(await count('operator_actions WHERE resource_id = $1', [id])).toBe(
      0,
    );
    // And the same key works once Audit is back.
    await ops('post', `server-control/${id}/resolve`, {
      resolution: 'RESOLVED_FAILED',
      reason: 'x',
    }).expect(200);
  });

  it('lists final DOMAIN_EVENT rejections without payloads, and forgets push hints only on request', async () => {
    const host = await agent();
    const bogus = host.event('TRADE_SETTLEMENT', {
      workId: randomUUID(),
      outcome: 'SETTLED',
    });
    await host.reply(bogus);
    const receipts = (
      await ops(
        'get',
        `domain-event-receipts?gameServerId=${server.id}&kind=TRADE_SETTLEMENT`,
        undefined,
        { role: 'DEV' },
      ).expect(200)
    ).body;
    expect(receipts.items).toEqual([
      {
        gameServerId: server.id,
        eventId: bogus.payload!.eventId,
        kind: 'TRADE_SETTLEMENT',
        status: 'REJECTED',
        reason: 'TRADE_NOT_FOUND',
        createdAt: expect.any(String),
      },
    ]);
    // An unknown workId is never noted per work item.
    expect(await count('agent_work_rejections')).toBe(1);
    expect(
      app.get(AgentWorkNotifier).forget('TRADE_SETTLEMENT', randomUUID()),
    ).toBe(0);
  });
});
