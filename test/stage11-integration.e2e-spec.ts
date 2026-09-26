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
import { SystemSource } from '../src/actors/actor.contracts.js';
import { EconomyService } from '../src/economy/economy.service.js';
import { GameServerService } from '../src/game-bridge/game-server.service.js';
import type { GameServer } from '../src/game-bridge/entities/game-server.entity.js';
import { DiscordIdentityProvider } from '../src/player-auth/discord-identity.provider.js';
import { PlayerAuthRateLimiter } from '../src/player-auth/player-auth-rate-limit.js';
import { AgentSessionRegistry } from '../src/game-agent/agent-session.registry.js';
import { MAX_AGENT_FRAME_BYTES } from '../src/game-agent/agent-protocol.contracts.js';
import { MAX_REALTIME_FRAME_BYTES } from '../src/realtime/realtime.gateway.js';
import { FakeDiscordProvider } from './support/fake-discord-provider.js';
import { FakeAgent, FakeTradeJournal } from './support/fake-agent.js';
import { RealtimeTestClient } from './support/realtime-client.js';

// Stage 11 acceptance battery (11.6): Admin Web ↔ Backend ↔ Host Agent and
// Electron ↔ Backend, combined, over real HTTP, real sockets and PostgreSQL.
const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;
const ENV = {
  GAME_COMMAND_WORKER_INTERVAL_MS: '100',
  GAME_COMMAND_PENDING_TIMEOUT_MS: '30000',
  SERVER_CONTROL_WORKER_INTERVAL_MS: '100',
  SERVER_CONTROL_PENDING_TIMEOUT_MS: '30000',
  SERVER_CONTROL_DELIVERY_WINDOW_MS: '2000',
  SERVER_CONTROL_RESULT_TIMEOUT_MS: '3000',
  AGENT_WORK_PUSH_INTERVAL_MS: '150',
};
const CAPS = [
  'GAME_COMMAND_V1',
  'COMMAND_DEDUP_V1',
  'CHARACTER_INVENTORY_QUERY',
  'CHARACTER_PROPERTIES_QUERY',
  'CHARACTER_ITEM_GIVE',
  'SERVER_CONTROL_V1',
  'SERVER_START',
  'SERVER_PAUSE',
  'SERVER_RESTART',
];
const READY = { gameProcessState: 'RUNNING', skseReady: true };
const STOPPED = { gameProcessState: 'STOPPED', skseReady: false };
const CHARACTER = 'opaque:staff-target';
const SERVER = 'STAFF_GAME_SERVER_UPDATED';
const OPERATION = 'STAFF_GAME_OPERATION_UPDATED';
const CONTROL = 'STAFF_SERVER_CONTROL_UPDATED';
const LINK = 'PLAYER_CHARACTER_LINK_UPDATED';
const PLAYER_OPERATION = 'PLAYER_GAME_OPERATION_UPDATED';
const ROLES = ['COORDINATOR', 'DEV', 'ADMIN', 'SUPPORT'] as const;
type Role = (typeof ROLES)[number];
type Session = { accessToken: string; player: { id: string } };
type Event = { type: string; data: Record<string, unknown> };
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

describeDatabase(
  'Stage 11 end-to-end: Admin Web, Electron, Backend and Host Agent',
  () => {
    let admin: DataSource, database: DataSource, app: INestApplication<App>;
    let options: DataSourceOptions, server: GameServer, url: string;
    const tokens = {} as Record<Role, string>;
    const staffIds = {} as Record<Role, string>;
    const sockets: RealtimeTestClient[] = [];
    const agents: FakeAgent[] = [];
    const discord = new FakeDiscordProvider();
    const schema = `stage11_test_${randomUUID().replaceAll('-', '')}`;
    const password = 'Stage-Eleven-Password-42';
    const http = () => request(app.getHttpServer());
    const staff = (path: string, role: Role = 'COORDINATOR') =>
      http().get(`/api/v1/${path}`).auth(tokens[role], { type: 'bearer' });
    const staffPost = (
      path: string,
      body: object = {},
      role: Role = 'COORDINATOR',
    ) =>
      http()
        .post(`/api/v1/${path}`)
        .auth(tokens[role], { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send(body);
    const player = (s: Session, path: string) =>
      http()
        .get(`/api/v1/player/${path}`)
        .auth(s.accessToken, { type: 'bearer' });
    const playerPost = (s: Session, path: string, body: object = {}) =>
      http()
        .post(`/api/v1/player/${path}`)
        .auth(s.accessToken, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send(body);
    const subjects = new Map<string, string>();
    // Same Discord subject: a new login of the same player (fresh install).
    const login = async (as = randomUUID()): Promise<Session> => {
      const code = randomUUID();
      subjects.set(as, subjects.get(as) ?? `${Date.now()}${Math.random()}`);
      discord.codes.set(code, { subject: subjects.get(as)!, displayName: 'P' });
      return (
        await http()
          .post('/api/v1/player/auth/discord/exchange')
          .send({ authorizationCode: code, redirectUri: 'http://127.0.0.1/cb' })
          .expect(200)
      ).body;
    };
    const socket = async (
      token: string,
      surface: 'PLAYER' | 'STAFF' = 'STAFF',
    ) => {
      const client = new RealtimeTestClient(`${url}/api/v1/realtime`);
      sockets.push(client);
      expect(await client.authenticate(surface, token)).toMatchObject({
        type: 'AUTHENTICATED',
        surface,
      });
      return client;
    };
    const credential = async (serverId = server.id) =>
      (
        await staffPost(
          `admin/game-servers/${serverId}/agent-credentials`,
        ).expect(201)
      ).body as { credentialId: string; credentialSecret: string };
    const agent = async (
      runtime: Record<string, unknown> = READY,
      options: {
        key?: Awaited<ReturnType<typeof credential>>;
        journal?: FakeAgent;
      } = {},
    ) => {
      const created = new FakeAgent(
        url,
        server.id,
        options.journal?.journal,
        options.journal?.executions,
        options.journal?.operations,
        options.journal?.performed,
      );
      agents.push(created);
      await created.hello(
        options.key ?? (await credential()),
        CAPS,
        runtime as never,
      );
      return created;
    };
    const events = (c: RealtimeTestClient, type?: string) =>
      (c.events() as unknown as Event[]).filter(
        (e) => !type || e.type === type,
      );
    const mine = (c: RealtimeTestClient, type: string) =>
      events(c, type).filter((e) => e.data.gameServerId === server.id);
    const waitFor = (
      c: RealtimeTestClient,
      type: string,
      match: (data: Record<string, unknown>) => boolean,
      timeoutMs = 8000,
    ) =>
      c.until(
        () => events(c, type).find((e) => match(e.data)),
        timeoutMs,
      ) as Promise<Event>;
    // Wake-ups only: small, flat, nothing internal or raw.
    const small = (event: Event) => {
      const json = JSON.stringify(event);
      expect(Buffer.byteLength(json)).toBeLessThan(1024);
      expect(Buffer.byteLength(json)).toBeLessThan(
        MAX_REALTIME_FRAME_BYTES / 16,
      );
      expect(json).not.toMatch(
        /credential|secret|hash|capabilit|connectionId|correlation|idempotency|payload|"result"|requestedBy|token|items/i,
      );
      for (const value of Object.values(event.data))
        expect(value === null || typeof value !== 'object').toBe(true);
    };
    const staffCommand = async (path: string, body: object = {}) =>
      (
        await staffPost(
          `game-servers/${server.id}/characters/${CHARACTER}/${path}`,
          body,
        ).expect(202)
      ).body.commandId as string;
    const commandStatus = async (id: string) =>
      (
        await database.query('SELECT status FROM game_commands WHERE id = $1', [
          id,
        ])
      )[0].status as string;
    const controlRow = async (id: string) =>
      (
        await database.query(
          'SELECT status, error_code FROM server_control_operations WHERE id = $1',
          [id],
        )
      )[0] as { status: string; error_code: string | null };
    const control = async (
      path: 'start' | 'pause' | 'restart',
      role: Role = 'COORDINATOR',
    ) =>
      (
        await staffPost(
          `game-servers/${server.id}/control/${path}`,
          {},
          role,
        ).expect(202)
      ).body.operationId as string;
    const verifiedLink = async (s: Session, host: FakeAgent) => {
      const char = `char:${randomUUID()}`;
      const requested = (
        await playerPost(s, 'character-links', {
          gameServerId: server.id,
          characterExternalId: char,
        }).expect(201)
      ).body;
      const proof = host.event('CHARACTER_OWNERSHIP_PROOF', {
        challenge: requested.challenge,
        characterExternalId: char,
      });
      expect(await host.reply(proof)).toMatchObject({
        type: 'DOMAIN_EVENT_ACK',
      });
      return { linkId: requested.linkId as string, char };
    };
    const properties = (char: string) => ({
      characterId: char,
      properties: [{ propertyId: 'property:1', displayName: 'House' }],
    });
    const boot = async () => {
      const db = new DataSource({
        ...options,
        schema,
        ...(await compiledDatabaseArtifacts()),
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
      database = db;
      app = created as INestApplication<App>;
      url = `ws://127.0.0.1:${address.port}`;
    };

    beforeAll(async () => {
      Object.assign(process.env, ENV);
      options = createDatabaseOptions(loadEnvironment());
      if (options.type !== 'postgres') throw new Error('PostgreSQL required');
      admin = new DataSource(options);
      await admin.initialize();
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await boot();
      expect(await database.runMigrations()).toHaveLength(26);
      const hash = await new PasswordService().hash(password);
      for (const role of ROLES) {
        const [row] = await database.query(
          'INSERT INTO staff_users(username, display_name, password_hash, role_name) VALUES ($1, $1, $2, $3) RETURNING id',
          [`stage11-${role.toLowerCase()}`, hash, role],
        );
        staffIds[role] = row.id;
        tokens[role] = (
          await http()
            .post('/api/v1/auth/login')
            .send({ username: `stage11-${role.toLowerCase()}`, password })
            .expect(200)
        ).body.accessToken;
      }
    }, 60000);
    beforeEach(async () => {
      app.get(PlayerAuthRateLimiter).reset();
      server = await app
        .get(GameServerService)
        .register({ code: randomUUID(), name: 'Stage 11' });
    });
    afterEach(async () => {
      for (const s of sockets.splice(0)) if (!s.closed) await s.close();
      for (const a of agents.splice(0)) await a.close();
      await eventually(async () => app.get(AgentSessionRegistry).count() === 0);
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

    it('wakes Staff on real GameServer/Agent changes only, with a small payload, and GET stays the source of truth', async () => {
      const coordinator = await socket(tokens.COORDINATOR);
      const support = await socket(tokens.SUPPORT);
      const someone = await socket((await login()).accessToken, 'PLAYER');
      // Connected with Skyrim stopped.
      const key = await credential();
      const first = await agent(STOPPED, { key });
      for (const c of [coordinator, support]) {
        const woke = await waitFor(
          c,
          SERVER,
          (d) => d.gameServerId === server.id && d.agentConnected === true,
        );
        small(woke);
        expect(Object.keys(woke.data).sort()).toEqual(
          [
            'gameServerId',
            'enabled',
            'agentConnected',
            'gameProcessState',
            'gameReady',
            'updatedAt',
          ].sort(),
        );
        expect(woke.data).toMatchObject({
          enabled: true,
          gameProcessState: 'STOPPED',
          gameReady: false,
        });
      }
      // The Admin re-reads the same state, including the Agent runtime.
      const detail = (await staff(`game-servers/${server.id}`).expect(200))
        .body;
      expect(detail).toMatchObject({
        health: 'ONLINE',
        currentConnection: {
          id: first.connectionId,
          gameProcessState: 'STOPPED',
          skseReady: false,
        },
      });
      expect(JSON.stringify(detail)).not.toMatch(
        /credential|capabilit|secret/i,
      );
      // An unchanged heartbeat publishes nothing.
      const count = () => mine(coordinator, SERVER).length;
      const before = count();
      await first.heartbeat('STOPPED', false);
      await first.heartbeat('STOPPED', false);
      await pause(300);
      expect(count()).toBe(before);
      // A runtime change does.
      await first.heartbeat('RUNNING', true);
      expect(
        (
          await waitFor(
            coordinator,
            SERVER,
            (d) => d.gameServerId === server.id && d.gameReady === true,
          )
        ).data,
      ).toMatchObject({ agentConnected: true, gameProcessState: 'RUNNING' });
      // Supersede: a second session of the same server replaces the first.
      const seen = count();
      const second = await agent(READY);
      expect(await first.client.closedWith()).toEqual({
        code: 4006,
        reason: 'SUPERSEDED',
      });
      await coordinator.until(() => count() > seen);
      expect(
        (await staff(`game-servers/${server.id}`).expect(200)).body
          .currentConnection.id,
      ).toBe(second.connectionId);
      // Offline Staff: nothing is replayed; GET after reconnect recovers.
      await coordinator.close();
      await second.close();
      await waitFor(
        support,
        SERVER,
        (d) => d.gameServerId === server.id && d.agentConnected === false,
      );
      const back = await socket(tokens.COORDINATOR);
      await pause(300);
      expect(events(back)).toEqual([]);
      expect(
        (await staff(`game-servers/${server.id}`).expect(200)).body,
      ).toMatchObject({ health: 'OFFLINE', currentConnection: null });
      // Stale: the persisted heartbeat aged; the next heartbeat closes it.
      const stale = await agent(READY, { key });
      await waitFor(
        back,
        SERVER,
        (d) => d.gameServerId === server.id && d.agentConnected === true,
      );
      await database.query(
        "UPDATE game_connections SET last_heartbeat_at = now() - interval '1 hour' WHERE id = $1",
        [stale.connectionId],
      );
      stale.send('HEARTBEAT', READY);
      expect((await stale.client.closedWith()).reason).toBe('SESSION_CLOSED');
      expect(
        (
          await waitFor(
            back,
            SERVER,
            (d) =>
              d.gameServerId === server.id &&
              d.agentConnected === false &&
              mine(back, SERVER).length >= 2,
          )
        ).data,
      ).toMatchObject({ gameProcessState: null, gameReady: false });
      // Revocation closes the session and wakes the Staff too.
      const revoked = await agent(READY, { key });
      const connectedAgain = mine(back, SERVER).length;
      await back.until(() => mine(back, SERVER).length > connectedAgain);
      await staffPost(
        `admin/game-servers/${server.id}/agent-credentials/${key.credentialId}/revoke`,
      ).expect(200);
      expect((await revoked.client.closedWith()).reason).toBe(
        'CREDENTIAL_REVOKED',
      );
      await back.until(
        () => mine(back, SERVER).at(-1)?.data.agentConnected === false,
      );
      // Staff events never reach the Player surface.
      expect(
        events(someone).filter((e) => e.type.startsWith('STAFF_')),
      ).toEqual([]);
    });

    it('delivers each Staff event only with the permission of its HTTP read, re-checked at delivery', async () => {
      const [coordinator, dev, adminRole, support] = await Promise.all(
        ROLES.map((role) => socket(tokens[role])),
      );
      const someone = await socket((await login()).accessToken, 'PLAYER');
      const host = await agent(STOPPED);
      // GAME_BRIDGE_READ: every Staff role reads servers, so all are woken.
      for (const c of [coordinator, dev, adminRole, support])
        await waitFor(c, SERVER, (d) => d.gameServerId === server.id);
      // SERVER_START: COORDINATOR and DEV only.
      const started = await control('start', 'DEV');
      host.perform(await host.control(started));
      for (const c of [coordinator, dev])
        await waitFor(c, CONTROL, (d) => d.operationId === started);
      await pause(300);
      for (const c of [adminRole, support, someone])
        expect(events(c, CONTROL)).toEqual([]);
      await staff(`server-control-operations/${started}`, 'ADMIN').expect(403);
      await staff(`server-control-operations/${started}`, 'DEV').expect(200);
      // Role change: DEV becomes SUPPORT; the next event honours it at once.
      await http()
        .patch(`/api/v1/staff/${staffIds.DEV}/role`)
        .auth(tokens.COORDINATOR, { type: 'bearer' })
        .send({ role: 'SUPPORT' })
        .expect(200);
      const restarted = await control('restart');
      host.perform(await host.control(restarted));
      await waitFor(coordinator, CONTROL, (d) => d.operationId === restarted);
      await pause(300);
      expect(events(dev, CONTROL).map((e) => e.data.operationId)).toEqual([
        started,
      ]);
      await staff(`server-control-operations/${restarted}`, 'DEV').expect(403);
      // Still a valid session: GAME_BRIDGE_READ events keep arriving.
      await host.heartbeat('RUNNING', true);
      await waitFor(dev, SERVER, (d) => d.gameReady === true);
      // Disabled account: its sessions are revoked and the socket closes on
      // the next Staff delivery; HTTP agrees.
      await http()
        .patch(`/api/v1/staff/${staffIds.SUPPORT}/status`)
        .auth(tokens.COORDINATOR, { type: 'bearer' })
        .send({ status: 'DISABLED' })
        .expect(200);
      await host.heartbeat('PAUSED', true);
      expect(await support.closedWith()).toEqual({
        code: 4001,
        reason: 'UNAUTHORIZED',
      });
      await staff('game-servers', 'SUPPORT').expect(401);
      await waitFor(
        coordinator,
        SERVER,
        (d) => d.gameProcessState === 'PAUSED',
      );
      // Restore the fixtures for the next tests.
      await database.query(
        "UPDATE staff_users SET role_name = 'DEV' WHERE id = $1",
        [staffIds.DEV],
      );
      await database.query(
        "UPDATE staff_users SET status = 'ACTIVE' WHERE id = $1",
        [staffIds.SUPPORT],
      );
      tokens.SUPPORT = (
        await http()
          .post('/api/v1/auth/login')
          .send({ username: 'stage11-support', password })
          .expect(200)
      ).body.accessToken;
    });

    it('runs a Staff GameCommand end to end: COMMAND, ACK, RESULT, terminal wake-up, then GET', async () => {
      const coordinator = await socket(tokens.COORDINATOR);
      const support = await socket(tokens.SUPPORT);
      const someone = await socket((await login()).accessToken, 'PLAYER');
      const host = await agent(READY);
      const inventory = {
        characterId: CHARACTER,
        items: [{ itemId: 'opaque:item', displayName: 'Sword', quantity: 1 }],
      };
      const outcomes = [
        [{ outcome: 'SUCCEEDED', result: inventory }, 'SUCCEEDED', null],
        [
          { outcome: 'FAILED', errorCode: 'EXECUTION_FAILED' },
          'FAILED',
          'EXECUTION_FAILED',
        ],
        [{ outcome: 'UNCERTAIN' }, 'TIMEOUT', 'EXECUTION_UNCERTAIN'],
      ] as const;
      for (const [result, status, errorCode] of outcomes) {
        const id = await staffCommand('inventory/query');
        const sent = await host.command(id);
        await eventually(
          async () => (await commandStatus(id)) === 'DISPATCHED',
        );
        host.ack(sent);
        await eventually(
          async () => (await commandStatus(id)) === 'ACKNOWLEDGED',
        );
        // Not terminal yet: no wake-up.
        await pause(150);
        expect(
          events(coordinator, OPERATION).filter((e) => e.data.commandId === id),
        ).toEqual([]);
        expect(
          await host.reply(host.result(sent.payload!, result)),
        ).toMatchObject({ type: 'COMMAND_RESULT_ACK' });
        for (const c of [coordinator, support]) {
          const woke = await waitFor(c, OPERATION, (d) => d.commandId === id);
          small(woke);
          expect(woke.data).toEqual({
            commandId: id,
            gameServerId: server.id,
            commandType: 'CHARACTER_INVENTORY_QUERY',
            status,
            errorCode,
            completedAt: expect.any(String),
          });
        }
        // The Admin reads the outcome (and the typed result) over HTTP.
        expect(
          (await staff(`game-commands/${id}`).expect(200)).body,
        ).toMatchObject({ status, result: { errorCode } });
        const typed = (await staff(`character-operations/${id}`).expect(200))
          .body;
        expect(typed.status).toBe(status);
        if (status === 'SUCCEEDED')
          expect(typed.result).toMatchObject({ result: inventory });
      }
      // Exactly one wake-up per terminal transition, even for duplicates.
      const [last] = host.commands().slice(-1);
      await host.reply(host.result(last.payload!, { outcome: 'UNCERTAIN' }));
      await pause(200);
      expect(events(coordinator, OPERATION)).toHaveLength(3);
      // Offline Staff: the result lands while no socket is open.
      await coordinator.close();
      const offline = await staffCommand('inventory/query');
      const sent = await host.command(offline);
      host.ack(sent);
      await eventually(
        async () => (await commandStatus(offline)) === 'ACKNOWLEDGED',
      );
      await host.reply(
        host.result(sent.payload!, { outcome: 'SUCCEEDED', result: inventory }),
      );
      const back = await socket(tokens.COORDINATOR);
      await pause(300);
      expect(events(back, OPERATION)).toEqual([]);
      expect(
        (await staff(`game-commands/${offline}`).expect(200)).body.status,
      ).toBe('SUCCEEDED');
      // Player sockets never see Staff operations.
      expect(events(someone)).toEqual([]);
    });

    it('runs Server Control end to end: SUCCEEDED, UNCERTAIN without RESULT, result after reconnect and FAILED before delivery', async () => {
      const coordinator = await socket(tokens.COORDINATOR);
      const dev = await socket(tokens.DEV);
      const key = await credential();
      const host = await agent(STOPPED, { key });
      // START with Skyrim stopped; the result also reports the runtime.
      const started = await control('start');
      const frame = await host.control(started);
      expect(frame.payload).toMatchObject({ type: 'SERVER_START' });
      host.perform(frame, { outcome: 'SUCCEEDED', runtime: READY });
      const woke = await waitFor(
        dev,
        CONTROL,
        (d) => d.operationId === started,
      );
      small(woke);
      expect(woke.data).toEqual({
        operationId: started,
        gameServerId: server.id,
        type: 'SERVER_START',
        status: 'SUCCEEDED',
        errorCode: null,
        completedAt: expect.any(String),
      });
      await waitFor(coordinator, SERVER, (d) => d.gameReady === true);
      expect(
        (await staff(`server-control-operations/${started}`).expect(200)).body,
      ).toMatchObject({ status: 'SUCCEEDED', errorCode: null });
      // RESTART executed but never reported: UNCERTAIN at the deadline,
      // distinguishable from FAILED, and never sent again.
      const restarted = await control('restart');
      host.perform(await host.control(restarted), undefined, false);
      const uncertain = await waitFor(
        coordinator,
        CONTROL,
        (d) => d.operationId === restarted,
      );
      expect(uncertain.data).toMatchObject({
        status: 'UNCERTAIN',
        errorCode: 'RESULT_TIMEOUT',
      });
      expect(
        (await staff(`server-control-operations/${restarted}`).expect(200))
          .body,
      ).toMatchObject({ status: 'UNCERTAIN', errorCode: 'RESULT_TIMEOUT' });
      expect(host.controls(restarted)).toHaveLength(1);
      expect(host.performed.get(restarted)).toBe(1);
      // PAUSE: the connection drops after the action; the reconnected Agent
      // replays its journal and the result is accepted, executed once.
      const paused = await control('pause');
      host.perform(await host.control(paused), { outcome: 'SUCCEEDED' }, false);
      await host.close();
      const resumed = await agent(READY, { key, journal: host });
      await pause(300);
      expect(resumed.controls()).toEqual([]);
      expect(
        (await resumed.reply(resumed.replay(host.controls(paused)[0]))).payload,
      ).toMatchObject({
        status: 'SUCCEEDED',
        accepted: true,
        duplicate: false,
      });
      await waitFor(dev, CONTROL, (d) => d.operationId === paused);
      expect(host.performed.get(paused)).toBe(1);
      // FAILED before delivery: nothing was ever sent.
      await resumed.close();
      await eventually(
        async () => !app.get(AgentSessionRegistry).isConnected(server.id),
      );
      const held = await control('start');
      await database.query(
        'UPDATE game_servers SET enabled = false WHERE id = $1',
        [server.id],
      );
      const failed = await waitFor(dev, CONTROL, (d) => d.operationId === held);
      expect(failed.data).toMatchObject({
        status: 'FAILED',
        errorCode: 'SERVER_DISABLED',
      });
      // Cold start of the Admin Web: the list recovers every operation.
      const list = (
        await staff(`game-servers/${server.id}/control/operations`).expect(200)
      ).body;
      expect(
        list.items.map((o: { operationId: string }) => o.operationId),
      ).toEqual([held, paused, restarted, started]);
      expect(list.items[2]).toMatchObject({
        status: 'UNCERTAIN',
        errorCode: 'RESULT_TIMEOUT',
        errorMessage: expect.any(String),
      });
      expect(JSON.stringify(list)).not.toMatch(/idempotency|claim/i);
      expect(
        (
          await staff(
            `game-servers/${server.id}/control/operations?status=UNCERTAIN`,
          ).expect(200)
        ).body.items.map((o: { operationId: string }) => o.operationId),
      ).toEqual([restarted]);
      expect(
        (
          await staff(
            `game-servers/${server.id}/control/operations?type=SERVER_RESTART`,
            'DEV',
          ).expect(200)
        ).body.total,
      ).toBe(1);
      await staff(
        `game-servers/${server.id}/control/operations`,
        'ADMIN',
      ).expect(403);
      await staff(`game-servers/${randomUUID()}/control/operations`).expect(
        404,
      );
      for (const q of ['status=DONE', 'type=SHELL', 'limit=101', 'page=0'])
        await staff(`game-servers/${server.id}/control/operations?${q}`).expect(
          400,
        );
    });

    it('runs the Player character and GameCommand flows end to end and recovers offline changes by GET', async () => {
      const coordinator = await socket(tokens.COORDINATOR);
      const host = await agent(READY);
      const s = await login();
      const own = await socket(s.accessToken, 'PLAYER');
      // Discovery: the server is ready for this Player.
      expect(
        (await player(s, 'game-servers?limit=100').expect(200)).body.items,
      ).toContainEqual(
        expect.objectContaining({
          id: server.id,
          agentConnected: true,
          gameReady: true,
        }),
      );
      // Challenge → in-game proof → VERIFIED → owner wake-up → GET.
      const { linkId, char } = await verifiedLink(s, host);
      const linked = await waitFor(
        own,
        LINK,
        (d) => d.characterLinkId === linkId && d.status === 'VERIFIED',
      );
      expect(linked.data).toMatchObject({ status: 'VERIFIED' });
      expect(
        (await player(s, `character-links/${linkId}`).expect(200)).body.status,
      ).toBe('VERIFIED');
      // Player GameCommand: COMMAND, ACK, RESULT, wake-up, GET.
      const query = async () =>
        (
          await playerPost(
            s,
            `game-servers/${server.id}/characters/${encodeURIComponent(char)}/properties-query`,
          ).expect(202)
        ).body.operationId as string;
      const run = async (id: string) => {
        const sent = await host.command(id);
        host.ack(sent);
        await eventually(
          async () => (await commandStatus(id)) === 'ACKNOWLEDGED',
        );
        await host.reply(
          host.result(sent.payload!, {
            outcome: 'SUCCEEDED',
            result: properties(char),
          }),
        );
      };
      const first = await query();
      await run(first);
      expect(
        (await waitFor(own, PLAYER_OPERATION, (d) => d.operationId === first))
          .data,
      ).toMatchObject({ status: 'SUCCEEDED' });
      expect(
        (await player(s, `character-operations/${first}`).expect(200)).body,
      ).toMatchObject({
        status: 'SUCCEEDED',
        result: { data: properties(char) },
      });
      // Offline Player: result and revocation happen with no socket open.
      await own.close();
      const second = await query();
      await run(second);
      await playerPost(s, `character-links/${linkId}/revoke`).expect(200);
      const back = await socket(s.accessToken, 'PLAYER');
      await pause(300);
      expect(events(back)).toEqual([]);
      expect(
        (await player(s, `character-operations/${second}`).expect(200)).body
          .status,
      ).toBe('SUCCEEDED');
      expect(
        (await player(s, `character-links/${linkId}`).expect(200)).body.status,
      ).toBe('REVOKED');
      // The Staff surface never sees private Player events or Player
      // operations (a Player command is not a Staff operation).
      await pause(200);
      expect(
        events(coordinator).filter((e) => !e.type.startsWith('STAFF_')),
      ).toEqual([]);
      expect(
        events(coordinator, OPERATION).filter(
          (e) => e.data.commandId === first || e.data.commandId === second,
        ),
      ).toEqual([]);
    });

    it('rebuilds a fresh Electron install from Player auth and HTTP alone, including the current group', async () => {
      const host = await agent(READY);
      const economy = app.get(EconomyService);
      const alias = randomUUID();
      const s = await login(alias);
      const { linkId, char } = await verifiedLink(s, host);
      await economy.creditFromSystem({
        gameServerId: server.id,
        characterExternalId: char,
        amount: 250,
        idempotencyKey: randomUUID(),
        source: SystemSource.AGENT,
      });
      const group = (
        await playerPost(s, 'groups', { characterLinkId: linkId }).expect(201)
      ).body;
      await http()
        .patch('/api/v1/player/settings')
        .auth(s.accessToken, { type: 'bearer' })
        .send({ locale: 'pt-BR' })
        .expect(200);
      // New install: no cache, no ids, no realtime history; a new login.
      const fresh = await login(alias);
      expect(fresh.player.id).toBe(s.player.id);
      const servers = (
        await player(fresh, 'game-servers?limit=100').expect(200)
      ).body.items;
      expect(servers.map((x: { id: string }) => x.id)).toContain(server.id);
      const characters = (await player(fresh, 'me/characters').expect(200))
        .body;
      expect(JSON.stringify(characters)).toContain(linkId);
      const base = `me/characters/${linkId}`;
      expect((await player(fresh, `${base}/group`).expect(200)).body).toEqual({
        group: expect.objectContaining({
          id: group.id,
          gameServerId: server.id,
          status: 'ACTIVE',
          members: [
            expect.objectContaining({
              characterLinkId: linkId,
              role: 'LEADER',
            }),
          ],
        }),
      });
      expect((await player(fresh, `${base}/guild`).expect(200)).body).toEqual({
        guild: null,
      });
      expect(
        (await player(fresh, `${base}/wallet`).expect(200)).body,
      ).toMatchObject({ balance: 250 });
      await player(fresh, `${base}/trades`).expect(200);
      await player(fresh, `${base}/marketplace/listings`).expect(200);
      await player(fresh, `${base}/marketplace/purchases`).expect(200);
      await player(
        fresh,
        `marketplace/listings?gameServerId=${server.id}`,
      ).expect(200);
      await player(fresh, `${base}/vip/entitlements`).expect(200);
      await player(fresh, 'vip/entitlements').expect(200);
      await player(fresh, 'group-invites').expect(200);
      expect((await player(fresh, 'settings').expect(200)).body).toMatchObject({
        locale: 'pt-BR',
      });
      // The group read is owner-only, VERIFIED-only and shows no history.
      const other = await login();
      await player(other, `${base}/group`).expect(404);
      await player(fresh, 'me/characters/not-a-uuid/group').expect(400);
      await http().get(`/api/v1/player/${base}/group`).expect(401);
      await http()
        .get(`/api/v1/player/${base}/group`)
        .auth(tokens.COORDINATOR, { type: 'bearer' })
        .expect(401);
      await playerPost(s, `groups/${group.id}/leave`, {
        characterLinkId: linkId,
      }).expect(200);
      expect((await player(fresh, `${base}/group`).expect(200)).body).toEqual({
        group: null,
      });
      await playerPost(s, `character-links/${linkId}/revoke`).expect(200);
      await player(fresh, `${base}/group`).expect(404);
    });

    it('recovers domain work through WORK_SYNC after a dropped connection: same workId, completed exactly once', async () => {
      const economy = app.get(EconomyService);
      const key = await credential();
      const host = await agent(READY, { key });
      const party = async (gold: number) => {
        const s = await login();
        const link = await verifiedLink(s, host);
        await economy.creditFromSystem({
          gameServerId: server.id,
          characterExternalId: link.char,
          amount: gold,
          idempotencyKey: randomUUID(),
          source: SystemSource.AGENT,
        });
        return { s, ...link };
      };
      const a = await party(1000);
      const b = await party(100);
      const opened = (
        await playerPost(a.s, 'trades', {
          actorCharacterLinkId: a.linkId,
          targetCharacterId: b.char,
          offer: { gold: 200, items: [{ itemId: 'item:sword', quantity: 1 }] },
        }).expect(201)
      ).body;
      const view = (
        await player(
          a.s,
          `trades/${opened.tradeId}?characterLinkId=${a.linkId}`,
        ).expect(200)
      ).body;
      await playerPost(a.s, `trades/${opened.tradeId}/accept`, {
        characterLinkId: a.linkId,
        counterpartyOfferVersion: view.target.offer.version,
      }).expect(200);
      await playerPost(b.s, `trades/${opened.tradeId}/accept`, {
        characterLinkId: b.linkId,
        counterpartyOfferVersion: view.initiator.offer.version,
      }).expect(200);
      const watcher = await socket(b.s.accessToken, 'PLAYER');
      // Received (push or sync), partially fulfilled, then the link drops.
      const work = async (agentNow: FakeAgent) =>
        (await agentNow.syncAll())
          .flatMap(
            (p) =>
              p.payload!.items as {
                workId: string;
                kind: string;
                data: unknown;
              }[],
          )
          .filter((i) => i.kind === 'TRADE_SETTLEMENT');
      const [item] = await work(host);
      expect(item.workId).toBe(opened.tradeId);
      const journal = new FakeTradeJournal();
      expect(journal.fulfill(host, item, 0)).toBeUndefined();
      await host.close();
      const resumed = await agent(READY, { key });
      const [again] = await work(resumed);
      expect(again).toEqual(item);
      const settled = journal.fulfill(resumed, again)!;
      expect(await resumed.reply(settled)).toMatchObject({
        type: 'DOMAIN_EVENT_ACK',
        payload: { duplicate: false },
      });
      // A retry of the same eventId (after another reconnect) is absorbed.
      await resumed.close();
      const retry = await agent(READY, { key });
      expect(
        (await retry.reply(journal.fulfill(retry, item)!)).payload,
      ).toMatchObject({ duplicate: true });
      expect([...journal.effects.values()]).toEqual([1]);
      expect(await work(retry)).toEqual([]);
      const [trade] = await database.query(
        'SELECT status FROM player_trades WHERE id = $1',
        [opened.tradeId],
      );
      expect(trade.status).toBe('COMPLETED');
      expect(
        (
          await database.query(
            'SELECT count(*)::int AS n FROM agent_domain_event_receipts WHERE event_id = $1',
            [journal.eventIds.get(opened.tradeId)],
          )
        )[0].n,
      ).toBe(1);
      expect(
        (
          await database.query(
            "SELECT count(*)::int AS n FROM audit_logs WHERE resource_id = $1 AND action = 'PLAYER_TRADE_SETTLED'",
            [opened.tradeId],
          )
        )[0].n,
      ).toBe(1);
      // The Player is woken once and GET agrees.
      await watcher.until(() =>
        events(watcher, 'TRADE_COMPLETED').find(
          (e) => e.data.tradeId === opened.tradeId,
        ),
      );
      await pause(200);
      expect(events(watcher, 'TRADE_COMPLETED')).toHaveLength(1);
      expect(
        (
          await player(
            b.s,
            `trades/${opened.tradeId}?characterLinkId=${b.linkId}`,
          ).expect(200)
        ).body.status,
      ).toBe('COMPLETED');
    });

    it('keeps each protocol guarantee across the Agent reconnect matrix', async () => {
      const coordinator = await socket(tokens.COORDINATOR);
      const key = await credential();
      // 1. Disconnected before COMMAND send: stays PENDING, sent on connect.
      const early = await staffCommand('inventory/items/give', {
        itemId: 'opaque:item',
        quantity: 1,
      });
      await pause(300);
      expect(await commandStatus(early)).toBe('PENDING');
      const host = await agent(READY, { key });
      const sent = await host.command(early);
      host.ack(sent);
      await eventually(
        async () => (await commandStatus(early)) === 'ACKNOWLEDGED',
      );
      // 2. Executed, then disconnected before RESULT (at-least-once + the
      // Agent journal): the effect is recorded, the result never sent.
      host.executions.set(early, 1);
      host.journal.set(early, {
        state: 'COMPLETED',
        result: {
          characterId: CHARACTER,
          applied: true,
          targetId: 'opaque:item',
        },
      });
      await host.close();
      const second = await agent(READY, { key, journal: host });
      expect(
        (
          await second.reply(
            second.execute(sent, () => {
              throw new Error('never re-executed');
            }),
          )
        ).payload,
      ).toMatchObject({ status: 'SUCCEEDED', accepted: true });
      expect(second.executions.get(early)).toBe(1);
      await waitFor(coordinator, OPERATION, (d) => d.commandId === early);
      // 3. Duplicate Agent connection: the newest wins, the old is closed,
      // and an in-flight command completes through the new session.
      const inFlight = await staffCommand('inventory/query');
      const onSecond = await second.command(inFlight);
      second.ack(onSecond);
      await eventually(
        async () => (await commandStatus(inFlight)) === 'ACKNOWLEDGED',
      );
      const third = await agent(READY, { key, journal: second });
      expect((await second.client.closedWith()).reason).toBe('SUPERSEDED');
      await third.reply(
        third.result(onSecond.payload!, {
          outcome: 'SUCCEEDED',
          result: { characterId: CHARACTER, items: [] },
        }),
      );
      expect(await commandStatus(inFlight)).toBe('SUCCEEDED');
      // 4. Server Control result after a reconnect (at-most-once).
      const op = await control('pause');
      third.perform(await third.control(op), { outcome: 'SUCCEEDED' }, false);
      await third.close();
      const fourth = await agent(READY, { key, journal: third });
      await pause(300);
      expect(fourth.controls()).toEqual([]);
      await fourth.reply(fourth.replay(third.controls(op)[0]));
      expect((await controlRow(op)).status).toBe('SUCCEEDED');
      expect(third.performed.get(op)).toBe(1);
      // 5. DOMAIN_EVENT retry across a reconnect: one receipt, one effect.
      const s = await login();
      const char = `char:${randomUUID()}`;
      const requested = (
        await playerPost(s, 'character-links', {
          gameServerId: server.id,
          characterExternalId: char,
        }).expect(201)
      ).body;
      const eventId = randomUUID();
      const proof = {
        challenge: requested.challenge,
        characterExternalId: char,
      };
      expect(
        (
          await fourth.reply(
            fourth.event('CHARACTER_OWNERSHIP_PROOF', proof, eventId),
          )
        ).payload,
      ).toMatchObject({ eventId, duplicate: false });
      await fourth.close();
      const fifth = await agent(READY, { key, journal: fourth });
      expect(
        (
          await fifth.reply(
            fifth.event('CHARACTER_OWNERSHIP_PROOF', proof, eventId),
          )
        ).payload,
      ).toMatchObject({ eventId, duplicate: true });
      expect(
        (
          await database.query(
            'SELECT count(*)::int AS n FROM agent_domain_event_receipts WHERE event_id = $1',
            [eventId],
          )
        )[0].n,
      ).toBe(1);
      expect(
        (await player(s, `character-links/${requested.linkId}`).expect(200))
          .body.status,
      ).toBe('VERIFIED');
      // Realtime stayed best effort throughout: every Staff wake-up small.
      for (const event of events(coordinator)) small(event);
    });

    it('keeps the Agent, Player and Staff credentials on their own surfaces', async () => {
      const key = await credential();
      const s = await login();
      const agentSecret = key.credentialSecret;
      // Agent credential: no Staff or Player HTTP, no realtime.
      for (const path of [
        'auth/me',
        'game-servers',
        'player/me',
        'player/game-servers',
      ])
        await http()
          .get(`/api/v1/${path}`)
          .auth(agentSecret, { type: 'bearer' })
          .expect(401);
      for (const surface of ['PLAYER', 'STAFF'] as const) {
        const client = new RealtimeTestClient(`${url}/api/v1/realtime`);
        sockets.push(client);
        expect(await client.authenticate(surface, agentSecret)).toEqual({
          closed: { code: 4001, reason: 'UNAUTHORIZED' },
        });
      }
      // Player JWT: no Staff HTTP, no Staff realtime, no Agent session.
      await http()
        .get('/api/v1/game-servers')
        .auth(s.accessToken, { type: 'bearer' })
        .expect(401);
      await http()
        .get('/api/v1/auth/me')
        .auth(s.accessToken, { type: 'bearer' })
        .expect(401);
      // Staff JWT: no Player HTTP, no Player realtime, no Agent session.
      await http()
        .get('/api/v1/player/me')
        .auth(tokens.COORDINATOR, { type: 'bearer' })
        .expect(401);
      for (const [surface, token] of [
        ['STAFF', s.accessToken],
        ['PLAYER', tokens.COORDINATOR],
      ] as const) {
        const client = new RealtimeTestClient(`${url}/api/v1/realtime`);
        sockets.push(client);
        expect(await client.authenticate(surface, token)).toEqual({
          closed: { code: 4001, reason: 'UNAUTHORIZED' },
        });
      }
      for (const secret of [s.accessToken, tokens.COORDINATOR]) {
        const impostor = new FakeAgent(url, server.id);
        agents.push(impostor);
        await expect(
          impostor.hello(
            { credentialId: key.credentialId, credentialSecret: secret },
            CAPS,
          ),
        ).rejects.toThrow(/HELLO refused/);
        // Refused by the secret format (4003) or the verification (4001).
        expect([4001, 4003]).toContain(impostor.client.closed!.code);
      }
      // The Agent socket keeps its own 128 KiB limit, above the 16 KiB of
      // Player/Staff realtime.
      expect(MAX_AGENT_FRAME_BYTES).toBe(128 * 1024);
      expect(MAX_REALTIME_FRAME_BYTES).toBe(16 * 1024);
      const oversized = new RealtimeTestClient(`${url}/api/v1/realtime`);
      sockets.push(oversized);
      await oversized.open();
      oversized.send('x'.repeat(MAX_REALTIME_FRAME_BYTES + 1));
      expect((await oversized.closedWith()).code).toBe(1009);
    });

    it('survives a real backend restart: every recovery comes from PostgreSQL, not memory', async () => {
      const key = await credential();
      const host = await agent(STOPPED, { key });
      const s = await login();
      const { linkId } = await verifiedLink(s, host);
      // Completed command: its result receipt must survive.
      const done = await staffCommand('inventory/query');
      await host.heartbeat('RUNNING', true);
      const sent = await host.command(done);
      host.ack(sent);
      await eventually(
        async () => (await commandStatus(done)) === 'ACKNOWLEDGED',
      );
      await host.reply(
        host.result(sent.payload!, {
          outcome: 'SUCCEEDED',
          result: { characterId: CHARACTER, items: [] },
        }),
      );
      // Server Control crossed the delivery boundary; outcome never reported.
      const dispatched = await control('restart');
      host.perform(
        await host.control(dispatched),
        { outcome: 'SUCCEEDED' },
        false,
      );
      await eventually(
        async () => (await controlRow(dispatched)).status === 'DISPATCHED',
      );
      await host.close();
      await eventually(
        async () => !app.get(AgentSessionRegistry).isConnected(server.id),
      );
      // PENDING GameCommand with no Agent at all.
      const pending = await staffCommand('inventory/query');
      expect(await commandStatus(pending)).toBe('PENDING');
      // ---- Restart: a new process over the same database. ----
      for (const c of sockets.splice(0)) if (!c.closed) await c.close();
      agents.splice(0);
      await app.close();
      await boot();
      // Existing Staff and Player sessions still work (persisted sessions).
      const coordinator = await socket(tokens.COORDINATOR);
      expect(
        (await staff(`game-servers/${server.id}`).expect(200)).body,
      ).toMatchObject({ health: 'OFFLINE', currentConnection: null });
      expect(
        (await staff(`game-commands/${done}`).expect(200)).body,
      ).toMatchObject({
        status: 'SUCCEEDED',
        result: { outcome: 'SUCCEEDED' },
      });
      expect(
        (await player(s, `character-links/${linkId}`).expect(200)).body.status,
      ).toBe('VERIFIED');
      // The DISPATCHED Server Control is never resent: it ends UNCERTAIN.
      const back = await agent(READY, { key, journal: host });
      await waitFor(
        coordinator,
        SERVER,
        (d) => d.gameServerId === server.id && d.gameReady === true,
      );
      const uncertain = await waitFor(
        coordinator,
        CONTROL,
        (d) => d.operationId === dispatched,
      );
      expect(uncertain.data).toMatchObject({ status: 'UNCERTAIN' });
      expect(back.controls()).toEqual([]);
      expect(host.performed.get(dispatched)).toBe(1);
      // The PENDING command is found in the database and delivered.
      const recovered = await back.command(pending);
      back.ack(recovered);
      await eventually(
        async () => (await commandStatus(pending)) === 'ACKNOWLEDGED',
      );
      await back.reply(
        back.result(recovered.payload!, {
          outcome: 'SUCCEEDED',
          result: { characterId: CHARACTER, items: [] },
        }),
      );
      await waitFor(coordinator, OPERATION, (d) => d.commandId === pending);
      // Admin Web cold start after the restart.
      expect(
        (await staff('dashboard').expect(200)).body.servers.online,
      ).toBeGreaterThan(0);
      expect(
        (
          await staff(
            `game-servers/${server.id}/commands?status=SUCCEEDED`,
          ).expect(200)
        ).body.items.map((c: { id: string }) => c.id),
      ).toEqual(expect.arrayContaining([done, pending]));
      expect(
        (
          await staff(`game-servers/${server.id}/control/operations`).expect(
            200,
          )
        ).body.items[0],
      ).toMatchObject({ operationId: dispatched, status: 'UNCERTAIN' });
      expect(
        (
          await staff(`game-servers/${server.id}/connections`).expect(200)
        ).body.items.some(
          (c: { disconnectReason: string }) => c.disconnectReason !== null,
        ),
      ).toBe(true);
      await staff('audit').expect(200);
    });

    it('keeps all 26 migrations applied and the schema aligned without synchronization', async () => {
      expect(await database.showMigrations()).toBe(false);
      expect(
        (await database.query('SELECT count(*)::int AS n FROM migrations'))[0]
          .n,
      ).toBe(26);
      expect(database.options.synchronize).toBe(false);
      const sql = await database.driver.createSchemaBuilder().log();
      expect(sql.upQueries).toEqual([]);
      expect(sql.downQueries).toEqual([]);
    });
  },
);
