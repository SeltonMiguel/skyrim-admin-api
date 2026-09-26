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
import { GameServerService } from '../src/game-bridge/game-server.service.js';
import type { GameServer } from '../src/game-bridge/entities/game-server.entity.js';
import { GameCommandDispatcher } from '../src/game-bridge/game-command-dispatcher.js';
import { GameCommandReceiver } from '../src/game-bridge/game-command-receiver.js';
import { GameCommandStore } from '../src/game-bridge/game-command-store.js';
import { CommandStatus } from '../src/game-bridge/command-state.js';
import { GameCommandWorker } from '../src/game-agent/game-command.worker.js';
import { GameConnectionService } from '../src/game-bridge/game-connection.service.js';
import { DiscordIdentityProvider } from '../src/player-auth/discord-identity.provider.js';
import { PlayerAuthRateLimiter } from '../src/player-auth/player-auth-rate-limit.js';
import { CharacterLinkService } from '../src/player-characters/character-link.service.js';
import { AgentSessionRegistry } from '../src/game-agent/agent-session.registry.js';
import { RealtimeEventBus } from '../src/realtime-events/realtime-event-bus.js';
import { MAX_REALTIME_FRAME_BYTES } from '../src/realtime/realtime.gateway.js';
import { FakeDiscordProvider } from './support/fake-discord-provider.js';
import { FakeAgent } from './support/fake-agent.js';
import { RealtimeTestClient } from './support/realtime-client.js';

type Session = { accessToken: string; player: { id: string } };
const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;
const LINK = 'PLAYER_CHARACTER_LINK_UPDATED';
const OPERATION = 'PLAYER_GAME_OPERATION_UPDATED';
const pause = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describeDatabase(
  'Electron contract with PostgreSQL, HTTP, Player realtime and Host Agent',
  () => {
    let admin: DataSource, database: DataSource, app: INestApplication<App>;
    let server: GameServer, url: string, staffToken: string;
    let links: CharacterLinkService, dispatcher: GameCommandDispatcher;
    const schema = `electron_test_${randomUUID().replaceAll('-', '')}`;
    const discord = new FakeDiscordProvider();
    const sockets: RealtimeTestClient[] = [];
    const agents: FakeAgent[] = [];
    const http = () => request(app.getHttpServer());
    const get = (s: Session, path: string) =>
      http()
        .get(`/api/v1/player/${path}`)
        .auth(s.accessToken, { type: 'bearer' });
    const post = (s: Session, path: string, body: object = {}) =>
      http()
        .post(`/api/v1/player/${path}`)
        .auth(s.accessToken, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send(body);
    const login = async (): Promise<Session> => {
      const code = randomUUID();
      discord.codes.set(code, { subject: randomUUID(), displayName: 'Player' });
      return (
        await http()
          .post('/api/v1/player/auth/discord/exchange')
          .send({ authorizationCode: code, redirectUri: 'http://127.0.0.1/cb' })
          .expect(200)
      ).body;
    };
    const socket = async (
      token: string,
      surface: 'PLAYER' | 'STAFF' = 'PLAYER',
    ) => {
      const client = new RealtimeTestClient(`${url}/api/v1/realtime`);
      sockets.push(client);
      expect(await client.authenticate(surface, token)).toMatchObject({
        type: 'AUTHENTICATED',
        surface,
      });
      return client;
    };
    const host = async () => {
      const key = (
        await http()
          .post(`/api/v1/admin/game-servers/${server.id}/agent-credentials`)
          .auth(staffToken, { type: 'bearer' })
          .expect(201)
      ).body;
      const agent = new FakeAgent(url, server.id);
      agents.push(agent);
      await agent.hello(
        key,
        ['GAME_COMMAND_V1', 'CHARACTER_PROPERTIES_QUERY'],
        { gameProcessState: 'RUNNING', skseReady: true },
      );
      return agent;
    };
    const link = async (s: Session, char = `char:${randomUUID()}`) =>
      (
        await post(s, 'character-links', {
          gameServerId: server.id,
          characterExternalId: char,
        }).expect(201)
      ).body;
    const verify = async (
      agent: FakeAgent,
      l: { challenge: string; characterExternalId: string },
    ) => {
      const frame = agent.event('CHARACTER_OWNERSHIP_PROOF', {
        challenge: l.challenge,
        characterExternalId: l.characterExternalId,
      });
      expect(await agent.reply(frame)).toMatchObject({
        type: 'DOMAIN_EVENT_ACK',
      });
      return frame;
    };
    const operation = async (s: Session, char: string) =>
      (
        await post(
          s,
          `game-servers/${server.id}/characters/${encodeURIComponent(char)}/properties-query`,
        ).expect(202)
      ).body as { operationId: string };
    const events = (s: RealtimeTestClient, type: string) =>
      s.events().filter((e) => e.type === type);
    const playerEvents = (s: RealtimeTestClient) =>
      s.events().filter((e) => !String(e.type).startsWith('STAFF_'));
    const terminal = async (s: RealtimeTestClient, operationId: string) =>
      s.until(() =>
        events(s, OPERATION).find(
          (e) =>
            (e.data as { operationId: string }).operationId === operationId,
        ),
      );
    const small = (event: unknown) => {
      const json = JSON.stringify(event);
      expect(Buffer.byteLength(json)).toBeLessThan(1024);
      expect(Buffer.byteLength(json)).toBeLessThan(
        MAX_REALTIME_FRAME_BYTES / 8,
      );
      expect(json).not.toMatch(
        /challenge|proof|hash|playerId|requestedBy|connectionId|credential|capabilities|correlationId|"result"/i,
      );
    };
    const acknowledged = async (id: string) => {
      for (let i = 0; i < 100; i++) {
        const [row] = await database.query(
          'SELECT status FROM game_commands WHERE id = $1',
          [id],
        );
        if (row.status === 'ACKNOWLEDGED') return;
        await pause(10);
      }
      throw new Error('ACK not persisted');
    };
    const auditCount = async () =>
      Number(
        (await database.query('SELECT count(*) FROM audit_logs'))[0].count,
      );

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
      expect(await database.runMigrations()).toHaveLength(26);
      const { AppModule } = await import('../src/app.module.js');
      const module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(DataSource)
        .useValue(database)
        .overrideProvider(DiscordIdentityProvider)
        .useValue(discord)
        // Dispatch explicitly so intermediate ACK/rollback/deadline assertions are deterministic.
        .overrideProvider(GameCommandWorker)
        .useValue({ tick: async () => 0 })
        .compile();
      app = module.createNestApplication(new AppExpressAdapter());
      app.useLogger(false);
      setupApp(app);
      await app.listen(0, '127.0.0.1');
      const address = (
        app.getHttpServer() as unknown as Server
      ).address() as AddressInfo;
      url = `ws://127.0.0.1:${address.port}`;
      links = app.get(CharacterLinkService);
      dispatcher = app.get(GameCommandDispatcher);
      const password = 'Electron-Integration-Password-42';
      await database.query(
        "INSERT INTO staff_users(username, display_name, password_hash, role_name) VALUES ('electron-staff', 'Staff', $1, 'COORDINATOR')",
        [await new PasswordService().hash(password)],
      );
      staffToken = (
        await http()
          .post('/api/v1/auth/login')
          .send({ username: 'electron-staff', password })
          .expect(200)
      ).body.accessToken;
    }, 60000);
    beforeEach(async () => {
      app.get(PlayerAuthRateLimiter).reset();
      server = await app
        .get(GameServerService)
        .register({ code: randomUUID(), name: 'Public Skyrim' });
    });
    afterEach(async () => {
      for (const s of sockets.splice(0)) if (!s.closed) await s.close();
      for (const a of agents.splice(0)) await a.close();
      for (let i = 0; i < 100 && app.get(AgentSessionRegistry).count(); i++)
        await pause(10);
      expect(app.get(AgentSessionRegistry).count()).toBe(0);
    });
    afterAll(async () => {
      await app?.close();
      if (database?.isInitialized) await database.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.destroy();
      }
    });

    it('discovers only public enabled servers, with Player auth, pagination and no Audit or internal fields', async () => {
      const a = await login(),
        b = await login();
      const hidden = await app.get(GameServerService).register({
        code: randomUUID(),
        name: 'Administrative',
        enabled: false,
      });
      await http().get('/api/v1/player/game-servers').expect(401);
      await http()
        .get('/api/v1/player/game-servers')
        .auth(staffToken, { type: 'bearer' })
        .expect(401);
      const before = await auditCount();
      const first = await get(a, 'game-servers').expect(200);
      expect(first.headers['cache-control']).toBe('no-store');
      expect((await get(b, 'game-servers').expect(200)).body).toEqual(
        first.body,
      );
      expect(first.body.items).toContainEqual({
        id: server.id,
        code: server.code,
        name: server.name,
        enabled: true,
        agentConnected: false,
        gameProcessState: null,
        gameReady: false,
      });
      expect(
        first.body.items.some((s: { id: string }) => s.id === hidden.id),
      ).toBe(false);
      for (const s of first.body.items)
        expect(Object.keys(s).sort()).toEqual(
          [
            'id',
            'code',
            'name',
            'enabled',
            'agentConnected',
            'gameProcessState',
            'gameReady',
          ].sort(),
        );
      expect(
        (await get(a, 'game-servers?limit=1').expect(200)).body.items,
      ).toHaveLength(1);
      for (const q of ['enabled=false', 'playerId=x', 'limit=101', 'page=0'])
        await get(a, `game-servers?${q}`).expect(400);
      expect(await auditCount()).toBe(before);
      for (const status of ['SUSPENDED', 'BANNED']) {
        await database.query('UPDATE players SET status = $1 WHERE id = $2', [
          status,
          a.player.id,
        ]);
        await get(a, 'game-servers').expect(403);
      }
    });

    it('separates persisted Agent liveness from STOPPED, RUNNING without SKSE and ready runtime, hiding stale snapshots', async () => {
      const a = await login();
      const read = async () =>
        (await get(a, 'game-servers?limit=100').expect(200)).body.items.find(
          (s: { id: string }) => s.id === server.id,
        );
      await app.get(GameConnectionService).connect({
        gameServerId: server.id,
        externalConnectionId: randomUUID(),
      });
      expect(await read()).toMatchObject({
        agentConnected: false,
        gameProcessState: null,
        gameReady: false,
      });
      const agent = await host();
      for (const [state, skse, ready] of [
        ['STOPPED', false, false],
        ['STARTING', false, false],
        ['RUNNING', false, false],
        ['RUNNING', true, true],
        ['PAUSED', true, false],
      ] as const) {
        await agent.heartbeat(state, skse);
        expect(await read()).toMatchObject({
          agentConnected: true,
          gameProcessState: state,
          gameReady: ready,
        });
      }
      await database.query(
        "UPDATE game_connections SET last_heartbeat_at = now() - interval '1 hour' WHERE id = $1",
        [agent.connectionId],
      );
      expect(await read()).toMatchObject({
        agentConnected: false,
        gameProcessState: null,
        gameReady: false,
      });
      await database.query(
        'UPDATE game_servers SET enabled = false WHERE id = $1',
        [server.id],
      );
      expect(await read()).toBeUndefined();
    });

    it('auth → discovery → link → Agent ownership → owner-only small realtime → canonical GET, with lifecycle and duplicate suppression', async () => {
      const a = await login(),
        b = await login();
      const owner = await socket(a.accessToken),
        other = await socket(b.accessToken),
        staff = await socket(staffToken, 'STAFF');
      expect(
        (await get(a, 'game-servers').expect(200)).body.items.some(
          (s: { id: string }) => s.id === server.id,
        ),
      ).toBe(true);
      const agent = await host();
      const l = await link(a);
      const pending = await owner.event(LINK);
      expect(pending.data).toMatchObject({
        characterLinkId: l.linkId,
        status: 'PENDING',
      });
      small(pending);
      const proof = await verify(agent, l);
      const verified = await owner.until(() =>
        events(owner, LINK).find(
          (e) => (e.data as { status: string }).status === 'VERIFIED',
        ),
      );
      small(verified);
      expect(JSON.stringify(verified)).not.toContain(l.challenge);
      const canonical = (
        await get(a, `character-links/${l.linkId}`).expect(200)
      ).body;
      expect(verified.data).toEqual({
        characterLinkId: l.linkId,
        gameServerId: server.id,
        characterExternalId: l.characterExternalId,
        status: 'VERIFIED',
        updatedAt: canonical.updatedAt,
      });
      expect(
        (await get(a, 'me/characters').expect(200)).body.items,
      ).toContainEqual(
        expect.objectContaining({ id: l.linkId, status: 'VERIFIED' }),
      );
      await get(b, `character-links/${l.linkId}`).expect(404);
      expect(
        await database.query(
          'SELECT status FROM agent_domain_event_receipts WHERE event_id = $1',
          [proof.payload!.eventId],
        ),
      ).toEqual([{ status: 'APPLIED' }]);
      await agent.reply(agent.send('DOMAIN_EVENT', proof.payload!));
      await verify(agent, l); // domain duplicate with another eventId
      await post(a, `character-links/${l.linkId}/revoke`).expect(200);
      await owner.until(() => events(owner, LINK).length === 3);
      await post(a, `character-links/${l.linkId}/revoke`).expect(200);
      await link(a, l.characterExternalId);
      await owner.until(() => events(owner, LINK).length === 4);
      await pause();
      expect(
        events(owner, LINK).map((e) => (e.data as { status: string }).status),
      ).toEqual(['PENDING', 'VERIFIED', 'REVOKED', 'PENDING']);
      expect(other.events()).toEqual([]);
      // Staff sockets get Staff wake-ups (11.6), never Player events.
      expect(playerEvents(staff)).toEqual([]);
      expect(
        await database.query(
          'SELECT action FROM audit_logs WHERE resource_id = $1 ORDER BY created_at',
          [l.linkId],
        ),
      ).toEqual(
        [
          'PLAYER_CHARACTER_LINK_REQUESTED',
          'PLAYER_CHARACTER_LINK_VERIFIED',
          'PLAYER_CHARACTER_LINK_REVOKED',
          'PLAYER_CHARACTER_LINK_REQUESTED',
        ].map((action) => ({ action })),
      );
    });

    it('publishes link changes only after commit, never on rolled-back proof/receipt or failed request', async () => {
      const a = await login(),
        owner = await socket(a.accessToken),
        agent = await host();
      const l = await link(a);
      await owner.event(LINK);
      await database.query(
        "ALTER TABLE agent_domain_event_receipts ADD CONSTRAINT electron_receipt_failure CHECK (kind <> 'CHARACTER_OWNERSHIP_PROOF') NOT VALID",
      );
      const eventId = randomUUID();
      const data = {
        challenge: l.challenge,
        characterExternalId: l.characterExternalId,
      };
      try {
        expect(
          (
            await agent.reply(
              agent.event('CHARACTER_OWNERSHIP_PROOF', data, eventId),
            )
          ).payload,
        ).toMatchObject({ code: 'TEMPORARILY_UNAVAILABLE' });
        expect(
          (await get(a, `character-links/${l.linkId}`).expect(200)).body.status,
        ).toBe('PENDING');
        await pause();
        expect(events(owner, LINK)).toHaveLength(1);
      } finally {
        await database.query(
          'ALTER TABLE agent_domain_event_receipts DROP CONSTRAINT electron_receipt_failure',
        );
      }
      const entered = gate(),
        release = gate();
      const confirming = links.confirmFromAgent(
        { ...data, gameServerId: server.id },
        async () => {
          entered.resolve();
          await release.promise;
        },
      );
      await entered.promise;
      try {
        expect(
          (await get(a, `character-links/${l.linkId}`).expect(200)).body.status,
        ).toBe('PENDING');
        expect(events(owner, LINK)).toHaveLength(1);
      } finally {
        release.resolve();
      }
      expect(await confirming).toMatchObject({ outcome: 'VERIFIED' });
      await owner.until(() => events(owner, LINK).length === 2);
      await post(a, 'character-links', {
        gameServerId: server.id,
        characterExternalId: l.characterExternalId,
      }).expect(409);
      await pause();
      expect(events(owner, LINK)).toHaveLength(2);
    });

    it.each(['SUCCEEDED', 'FAILED', 'UNCERTAIN'] as const)(
      'delivers %s Player operation to its original actor only, with no raw result, ACK or replay notification',
      async (outcome) => {
        const a = await login(),
          b = await login(),
          agent = await host();
        const l = await link(a);
        await verify(agent, l);
        const op = await operation(a, l.characterExternalId);
        // Ownership changes after creation: the notification still belongs to A.
        await post(a, `character-links/${l.linkId}/revoke`).expect(200);
        const newOwner = await link(b, l.characterExternalId);
        await verify(agent, newOwner);
        const owner = await socket(a.accessToken),
          other = await socket(b.accessToken),
          staff = await socket(staffToken, 'STAFF');
        await dispatcher.dispatch(op.operationId);
        const command = await agent.command(op.operationId);
        agent.ack(command);
        await acknowledged(op.operationId);
        expect(events(owner, OPERATION)).toEqual([]);
        // Larger than the Player socket frame limit but within GameCommand's 64 KiB.
        const raw = {
          characterId: l.characterExternalId,
          properties: Array.from({ length: 300 }, (_, i) => ({
            propertyId: `property:${i}`,
            displayName: 'Private property '.repeat(5).trim(),
          })),
        };
        expect(Buffer.byteLength(JSON.stringify(raw))).toBeGreaterThan(
          MAX_REALTIME_FRAME_BYTES,
        );
        const result =
          outcome === 'SUCCEEDED'
            ? { outcome, result: raw }
            : outcome === 'FAILED'
              ? { outcome, errorCode: 'EXECUTION_FAILED' }
              : { outcome };
        const before = await auditCount();
        const sent = agent.result(command.payload!, result);
        expect(await agent.reply(sent)).toMatchObject({
          type: 'COMMAND_RESULT_ACK',
        });
        const notification = await terminal(owner, op.operationId);
        small(notification);
        const status = outcome === 'UNCERTAIN' ? 'TIMEOUT' : outcome;
        expect(notification.data).toEqual({
          operationId: op.operationId,
          status,
          errorCode:
            outcome === 'SUCCEEDED'
              ? null
              : outcome === 'FAILED'
                ? 'EXECUTION_FAILED'
                : 'EXECUTION_UNCERTAIN',
          completedAt: expect.any(String),
        });
        const canonical = (
          await get(a, `character-operations/${op.operationId}`).expect(200)
        ).body;
        expect(canonical.status).toBe(status);
        expect(canonical.result.data).toEqual(
          outcome === 'SUCCEEDED' ? raw : null,
        );
        await get(b, `character-operations/${op.operationId}`).expect(404);
        await agent.reply(agent.result(command.payload!, result));
        await pause();
        expect(events(owner, OPERATION)).toHaveLength(1);
        expect(other.events()).toEqual([]);
        // Staff sockets get Staff wake-ups (11.6), never Player events.
        expect(playerEvents(staff)).toEqual([]);
        expect(await auditCount()).toBe(before);
        // A Staff-created command for the same character never enters Player realtime.
        const staffOp = (
          await http()
            .post(
              `/api/v1/game-servers/${server.id}/characters/${encodeURIComponent(l.characterExternalId)}/properties/query`,
            )
            .auth(staffToken, { type: 'bearer' })
            .set('Idempotency-Key', randomUUID())
            .send({})
            .expect(202)
        ).body;
        await dispatcher.dispatch(staffOp.commandId);
        const staffCommand = await agent.command(staffOp.commandId);
        await agent.reply(
          agent.result(staffCommand.payload!, {
            outcome: 'FAILED',
            errorCode: 'EXECUTION_FAILED',
          }),
        );
        await pause();
        expect(events(owner, OPERATION)).toHaveLength(1);
        expect(other.events()).toEqual([]);
        // Staff sockets get Staff wake-ups (11.6), never Player events.
        expect(playerEvents(staff)).toEqual([]);
      },
    );

    it('recovers missed link and operation events through HTTP after reconnect, including disabled server history', async () => {
      const a = await login(),
        agent = await host();
      const before = await socket(a.accessToken);
      const l = await link(a);
      await before.event(LINK);
      await before.close();
      await verify(agent, l);
      const op = await operation(a, l.characterExternalId);
      await dispatcher.dispatch(op.operationId);
      const command = await agent.command(op.operationId);
      await agent.reply(
        agent.result(command.payload!, {
          outcome: 'SUCCEEDED',
          result: { characterId: l.characterExternalId, properties: [] },
        }),
      );
      await database.query(
        'UPDATE game_servers SET enabled = false WHERE id = $1',
        [server.id],
      );
      const back = await socket(a.accessToken);
      expect(
        (await get(a, 'me/characters').expect(200)).body.items,
      ).toContainEqual(
        expect.objectContaining({
          id: l.linkId,
          status: 'VERIFIED',
          gameServer: expect.objectContaining({ enabled: false }),
        }),
      );
      expect(
        (await get(a, `character-links/${l.linkId}`).expect(200)).body.status,
      ).toBe('VERIFIED');
      expect(
        (await get(a, `character-operations/${op.operationId}`).expect(200))
          .body.status,
      ).toBe('SUCCEEDED');
      expect(
        (await get(a, 'game-servers?limit=100').expect(200)).body.items.some(
          (s: { id: string }) => s.id === server.id,
        ),
      ).toBe(false);
      await pause();
      expect(back.events()).toEqual([]); // no replay queue
    });

    it('does not publish a terminal transition before commit or on rollback, and tolerates failed realtime delivery', async () => {
      const a = await login(),
        agent = await host();
      const l = await link(a);
      await verify(agent, l);
      const op = await operation(a, l.characterExternalId),
        owner = await socket(a.accessToken);
      const store = app.get(GameCommandStore);
      await expect(
        store.locked(op.operationId, async (manager, command) => {
          await store.finish(
            manager,
            command,
            CommandStatus.FAILED,
            null,
            'DISPATCH_EXPIRED',
          );
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(
        (await get(a, `character-operations/${op.operationId}`).expect(200))
          .body.status,
      ).toBe('PENDING');
      expect(owner.events()).toEqual([]);
      const entered = gate(),
        release = gate();
      const completing = store.locked(
        op.operationId,
        async (manager, command) => {
          await store.finish(
            manager,
            command,
            CommandStatus.FAILED,
            null,
            'DISPATCH_EXPIRED',
          );
          entered.resolve();
          await release.promise;
        },
      );
      await entered.promise;
      try {
        expect(
          (await get(a, `character-operations/${op.operationId}`).expect(200))
            .body.status,
        ).toBe('PENDING');
        expect(owner.events()).toEqual([]);
      } finally {
        release.resolve();
      }
      const unsubscribe = app.get(RealtimeEventBus).subscribe(() => {
        throw new Error('socket failure');
      });
      try {
        await completing;
      } finally {
        unsubscribe();
      }
      small(await terminal(owner, op.operationId));
      expect(
        (await get(a, `character-operations/${op.operationId}`).expect(200))
          .body.status,
      ).toBe('FAILED');
    });

    it('also wakes the Player on backend pending expiry, execution timeout and disabled-server dispatch failure', async () => {
      const a = await login(),
        agent = await host(),
        l = await link(a);
      await verify(agent, l);
      const owner = await socket(a.accessToken);
      const receiver = app.get(GameCommandReceiver);
      const pending = await operation(a, l.characterExternalId);
      await database.query(
        "UPDATE game_commands SET created_at = now() - interval '30 days' WHERE id = $1",
        [pending.operationId],
      );
      await receiver.expirePending();
      expect((await terminal(owner, pending.operationId)).data).toMatchObject({
        status: 'FAILED',
        errorCode: 'DISPATCH_EXPIRED',
      });
      const timeout = await operation(a, l.characterExternalId);
      await dispatcher.dispatch(timeout.operationId);
      const sent = await agent.command(timeout.operationId);
      agent.ack(sent);
      await acknowledged(timeout.operationId);
      await database.query(
        "UPDATE game_commands SET execution_deadline_at = now() - interval '1 second' WHERE id = $1",
        [timeout.operationId],
      );
      await receiver.expireCommands();
      expect((await terminal(owner, timeout.operationId)).data).toMatchObject({
        status: 'TIMEOUT',
        errorCode: 'EXECUTION_TIMEOUT',
      });
      const disabled = await operation(a, l.characterExternalId);
      await database.query(
        'UPDATE game_servers SET enabled = false WHERE id = $1',
        [server.id],
      );
      await dispatcher.dispatch(disabled.operationId);
      expect((await terminal(owner, disabled.operationId)).data).toMatchObject({
        status: 'FAILED',
        errorCode: 'SERVER_DISABLED',
      });
    });

    it('keeps all 25 migrations applied and schema aligned without synchronization', async () => {
      expect(await database.query('SELECT * FROM migrations')).toHaveLength(26);
      expect(await database.showMigrations()).toBe(false);
      expect(database.options.synchronize).toBe(false);
      const diff = await database.driver.createSchemaBuilder().log();
      expect([diff.upQueries.length, diff.downQueries.length]).toEqual([0, 0]);
    });
  },
);
