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
import { DiscordIdentityProvider } from '../src/player-auth/discord-identity.provider.js';
import { AgentSessionRegistry } from '../src/game-agent/agent-session.registry.js';
import { ServerControlReceiver } from '../src/server-control/server-control-receiver.js';
import type { ServerControlOperation } from '../src/server-control/entities/server-control-operation.entity.js';
import type { ServerControlType } from '../src/server-control/server-control.contracts.js';
import { FakeDiscordProvider } from './support/fake-discord-provider.js';
import { FakeAgent } from './support/fake-agent.js';

const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;
const CONTROL_CAPS = [
  'SERVER_CONTROL_V1',
  'SERVER_START',
  'SERVER_PAUSE',
  'SERVER_RESTART',
];
const STOPPED = { gameProcessState: 'STOPPED', skseReady: false };
const PATHS: Record<ServerControlType, string> = {
  SERVER_START: 'start',
  SERVER_PAUSE: 'pause',
  SERVER_RESTART: 'restart',
};
// Short, persistent deadlines for the suite (defaults: 30s / 10s / 5min).
const ENV = {
  SERVER_CONTROL_WORKER_INTERVAL_MS: '100',
  SERVER_CONTROL_PENDING_TIMEOUT_MS: '1500',
  SERVER_CONTROL_DELIVERY_WINDOW_MS: '1000',
  SERVER_CONTROL_RESULT_TIMEOUT_MS: '2500',
};
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

describeDatabase(
  'Server Control through the Host Agent with real PostgreSQL',
  () => {
    let admin: DataSource, database: DataSource, app: INestApplication<App>;
    let servers: GameServerService, registry: AgentSessionRegistry;
    let server: GameServer, url: string;
    const tokens: Record<'COORDINATOR' | 'ADMIN', string> = {
      COORDINATOR: '',
      ADMIN: '',
    };
    const agents: FakeAgent[] = [];
    const discord = new FakeDiscordProvider();
    const schema = `server_control_agent_test_${randomUUID().replaceAll('-', '')}`;
    const http = () => request(app.getHttpServer());
    const credential = async (serverId = server.id) =>
      (
        await http()
          .post(`/api/v1/admin/game-servers/${serverId}/agent-credentials`)
          .auth(tokens.COORDINATOR, { type: 'bearer' })
          .expect(201)
      ).body as { credentialId: string; credentialSecret: string };
    const agent = async (
      capabilities = CONTROL_CAPS,
      runtime = STOPPED,
      options: {
        serverId?: string;
        key?: Awaited<ReturnType<typeof credential>>;
        // Same Host Agent process after a reconnect: same journals.
        journal?: FakeAgent;
      } = {},
    ) => {
      const serverId = options.serverId ?? server.id;
      const created = new FakeAgent(
        url,
        serverId,
        options.journal?.journal,
        options.journal?.executions,
        options.journal?.operations,
        options.journal?.performed,
      );
      agents.push(created);
      await created.hello(
        options.key ?? (await credential(serverId)),
        capabilities,
        runtime,
      );
      return created;
    };
    const control = (
      type: ServerControlType,
      serverId = server.id,
      token = tokens.COORDINATOR,
    ) =>
      http()
        .post(`/api/v1/game-servers/${serverId}/control/${PATHS[type]}`)
        .auth(token, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID());
    const start = async (type: ServerControlType, serverId = server.id) =>
      (await control(type, serverId).expect(202)).body.operationId as string;
    const detail = (id: string) =>
      http()
        .get(`/api/v1/server-control-operations/${id}`)
        .auth(tokens.COORDINATOR, { type: 'bearer' })
        .expect(200)
        .then((r) => r.body);
    const row = (id: string) =>
      database
        .getRepository<ServerControlOperation>('ServerControlOperation')
        .findOneByOrFail({ id });
    const status = async (id: string) => (await row(id)).status;
    const frames = (id: string) =>
      agents.reduce((sum, a) => sum + a.controls(id).length, 0);
    const audits = (id: string) =>
      database.query(
        "SELECT action FROM audit_logs WHERE metadata->>'operationId' = $1",
        [id],
      );

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
      expect(await database.runMigrations()).toHaveLength(27);
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
      const password = 'Server-Control-Agent-Password-42';
      const hash = await new PasswordService().hash(password);
      for (const role of ['COORDINATOR', 'ADMIN'] as const) {
        await database.query(
          'INSERT INTO staff_users(username, display_name, password_hash, role_name) VALUES ($1, $1, $2, $3)',
          [role.toLowerCase(), hash, role],
        );
        tokens[role] = (
          await http()
            .post('/api/v1/auth/login')
            .send({ username: role.toLowerCase(), password })
            .expect(200)
        ).body.accessToken;
      }
    }, 60000);
    beforeEach(async () => {
      server = await servers.register({ code: randomUUID(), name: 'Control' });
    });
    afterEach(async () => {
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

    it('starts a STOPPED server without SKSE end to end: one SERVER_CONTROL, one execution, SUCCEEDED, runtime followed', async () => {
      const host = await agent();
      expect(await host.heartbeat('STOPPED', false)).toMatchObject({
        type: 'HEARTBEAT_ACK',
      });
      const response = await control('SERVER_START').expect(202);
      const id = response.body.operationId as string;
      const sent = await host.control(id);
      const stored = await row(id);
      expect(sent).toMatchObject({
        protocolVersion: '1',
        type: 'SERVER_CONTROL',
        gameServerId: server.id,
      });
      expect(sent.payload).toEqual({
        operationId: id,
        correlationId: stored.correlationId,
        type: 'SERVER_START',
        issuedAt: stored.dispatchClaimedAt!.toISOString(),
        notAfter: stored.notAfter!.toISOString(),
      });
      // Only the typed action: no actor, key, token or process text.
      expect(JSON.stringify(sent)).not.toMatch(
        /idempotency|requestedBy|staff|actor|token|command|shell|path|script|args|env/i,
      );
      expect(
        stored.notAfter!.getTime() - stored.dispatchClaimedAt!.getTime(),
      ).toBe(1000);
      expect(stored.dispatchConnectionId).toBe(host.connectionId);
      await eventually(async () => (await status(id)) === 'DISPATCHED');
      const ack = await host.reply(
        host.perform(sent, {
          outcome: 'SUCCEEDED',
          runtime: { gameProcessState: 'STARTING', skseReady: false },
        })!,
      );
      expect(ack).toMatchObject({
        type: 'SERVER_CONTROL_RESULT_ACK',
        payload: {
          operationId: id,
          status: 'SUCCEEDED',
          accepted: true,
          duplicate: false,
        },
      });
      expect(await detail(id)).toMatchObject({
        operationId: id,
        type: 'SERVER_START',
        status: 'SUCCEEDED',
        errorCode: null,
        errorMessage: null,
        completedAt: expect.any(String),
        dispatchedAt: expect.any(String),
      });
      // The result's snapshot is recorded, never used as the outcome.
      expect(registry.getSession(server.id)?.runtime).toEqual({
        gameProcessState: 'STARTING',
        skseReady: false,
      });
      expect(
        await database.query(
          'SELECT game_process_state, skse_ready FROM game_connections WHERE id = $1',
          [host.connectionId],
        ),
      ).toEqual([{ game_process_state: 'STARTING', skse_ready: false }]);
      await host.heartbeat('RUNNING', true);
      expect(registry.getSession(server.id)?.runtime).toEqual({
        gameProcessState: 'RUNNING',
        skseReady: true,
      });
      // PAUSE and RESTART, the other real actions, one at a time.
      for (const [type, after] of [
        ['SERVER_PAUSE', 'PAUSED'],
        ['SERVER_RESTART', 'RESTARTING'],
      ] as const) {
        const next = await start(type);
        const frame = await host.control(next);
        expect(frame.payload!.type).toBe(type);
        await host.reply(
          host.perform(frame, {
            outcome: 'SUCCEEDED',
            runtime: { gameProcessState: after, skseReady: false },
          })!,
        );
        expect((await detail(next)).status).toBe('SUCCEEDED');
        expect(registry.getSession(server.id)?.runtime.gameProcessState).toBe(
          after,
        );
      }
      await pause(300);
      expect(host.performed.get(id)).toBe(1);
      expect(host.controls()).toHaveLength(3);
      expect(host.client.messages.filter((m) => m.type === 'COMMAND')).toEqual(
        [],
      );
      // Only the creation Audit; no Audit for the technical result.
      expect(await audits(id)).toEqual([{ action: 'SERVER_START_REQUESTED' }]);
      expect(
        await database.query(
          'SELECT id FROM game_commands WHERE game_server_id = $1',
          [server.id],
        ),
      ).toEqual([]);
    });
    it('accepts the RESULT from a new session after a reconnect and never sends the operation again', async () => {
      const key = await credential();
      const first = await agent(CONTROL_CAPS, STOPPED, { key });
      const id = await start('SERVER_RESTART');
      const sent = await first.control(id);
      await eventually(async () => (await status(id)) === 'DISPATCHED');
      // Executes, then loses the socket before reporting.
      expect(
        first.perform(sent, { outcome: 'SUCCEEDED' }, false),
      ).toBeUndefined();
      await first.close();
      const second = await agent(CONTROL_CAPS, STOPPED, {
        key,
        journal: first,
      });
      await pause(400); // several worker ticks
      expect(second.controls()).toEqual([]);
      const ack = await second.reply(second.replay(sent));
      expect(ack.payload).toMatchObject({
        status: 'SUCCEEDED',
        accepted: true,
        duplicate: false,
      });
      const stored = await row(id);
      expect(stored.status).toBe('SUCCEEDED');
      // The first session stays the provenance of the delivery.
      expect(stored.dispatchConnectionId).toBe(first.connectionId);
      expect(first.performed.get(id)).toBe(1);
      expect(frames(id)).toBe(1);
      // A duplicate of the same RESULT is idempotent.
      expect((await second.reply(second.replay(sent))).payload).toMatchObject({
        status: 'SUCCEEDED',
        duplicate: true,
      });
    });
    it('makes an operation without RESULT UNCERTAIN at the deadline, never resends it, and refuses a late conflicting result', async () => {
      const key = await credential();
      const host = await agent(CONTROL_CAPS, STOPPED, { key });
      const id = await start('SERVER_RESTART');
      const sent = await host.control(id);
      await eventually(async () => (await status(id)) === 'UNCERTAIN', 6000);
      const read = await detail(id);
      expect(read).toMatchObject({
        operationId: id,
        status: 'UNCERTAIN',
        errorCode: 'RESULT_TIMEOUT',
        errorMessage: 'No result before the deadline; outcome unknown',
      });
      // Same operation, no retry, including after a reconnect.
      await host.close();
      const again = await agent(CONTROL_CAPS, STOPPED, { key, journal: host });
      await pause(400);
      expect(frames(id)).toBe(1);
      expect(again.controls()).toEqual([]);
      // A late definite outcome cannot rewrite the terminal UNCERTAIN.
      const late = await again.reply(
        again.controlResult(sent.payload!, { outcome: 'SUCCEEDED' }),
      );
      expect(late).toMatchObject({
        type: 'ERROR',
        payload: { code: 'RESULT_CONFLICT', retryable: false },
      });
      // ...but an Agent that also cannot tell agrees with it.
      expect(
        (
          await again.reply(
            again.controlResult(sent.payload!, { outcome: 'UNCERTAIN' }),
          )
        ).payload,
      ).toMatchObject({ status: 'UNCERTAIN', duplicate: true });
      expect((await row(id)).status).toBe('UNCERTAIN');
      // Terminal: the operator may explicitly request again.
      const next = await start('SERVER_RESTART');
      expect(next).not.toBe(id);
      expect((await again.control(next)).payload!.operationId).toBe(next);
    });
    it('records Agent-reported outcomes: UNCERTAIN from the journal and definite failures', async () => {
      const host = await agent();
      // Journal found EXECUTING without proof: UNCERTAIN, not FAILED.
      const unknown = await start('SERVER_RESTART');
      const first = await host.control(unknown);
      expect(
        (await host.reply(host.perform(first, { outcome: 'UNCERTAIN' })!))
          .payload,
      ).toMatchObject({ status: 'UNCERTAIN', accepted: true });
      expect(await detail(unknown)).toMatchObject({
        status: 'UNCERTAIN',
        errorCode: 'OUTCOME_UNKNOWN',
      });
      // Received after notAfter: refused without executing.
      const expired = await start('SERVER_START');
      const late = await host.control(expired);
      await pause(1100);
      await host.reply(host.perform(late)!);
      expect(await detail(expired)).toMatchObject({
        status: 'FAILED',
        errorCode: 'DELIVERY_EXPIRED',
      });
      expect(host.performed.get(expired)).toBeUndefined();
      const invalid = await start('SERVER_PAUSE');
      await host.reply(
        host.perform(await host.control(invalid), {
          outcome: 'FAILED',
          errorCode: 'INVALID_PROCESS_STATE',
          runtime: STOPPED,
        })!,
      );
      expect(await detail(invalid)).toMatchObject({
        status: 'FAILED',
        errorCode: 'INVALID_PROCESS_STATE',
        errorMessage:
          'Operation not applicable to the current game process state',
      });
    });
    it('fails safely before any delivery when no eligible Agent appears: offline or missing capability', async () => {
      // Offline.
      const offline = await start('SERVER_START');
      expect((await row(offline)).status).toBe('PENDING');
      // In flight: nothing else for this server meanwhile.
      await control('SERVER_RESTART').expect(409);
      await eventually(async () => (await status(offline)) === 'FAILED');
      expect(await detail(offline)).toMatchObject({
        status: 'FAILED',
        errorCode: 'DISPATCH_EXPIRED',
        dispatchedAt: null,
      });
      expect((await row(offline)).dispatchClaimedAt).toBeNull();
      // Connected but without the action capability, or without the
      // protocol capability: never sent, FAILED (never UNCERTAIN).
      for (const caps of [
        ['SERVER_CONTROL_V1', 'SERVER_START'],
        ['SERVER_RESTART', 'GAME_COMMAND_V1', 'COMMAND_DEDUP_V1'],
      ]) {
        const host = await agent(caps);
        const held = await start('SERVER_RESTART');
        await eventually(async () => (await status(held)) === 'FAILED');
        expect(await detail(held)).toMatchObject({
          errorCode: 'DISPATCH_EXPIRED',
        });
        expect(host.controls()).toEqual([]);
        await host.close();
      }
    });
    it('dispatches a PENDING operation once an eligible Agent connects within the window', async () => {
      const id = await start('SERVER_START');
      await pause(300);
      expect((await row(id)).dispatchClaimedAt).toBeNull();
      const host = await agent();
      const sent = await host.control(id);
      await host.reply(host.perform(sent)!);
      expect((await detail(id)).status).toBe('SUCCEEDED');
      await pause(300);
      expect(host.controls(id)).toHaveLength(1);
    });
    it('rejects forged, mismatched, malformed, foreign and premature results without creating anything', async () => {
      const host = await agent();
      const id = await start('SERVER_START');
      const sent = await host.control(id);
      const ids = sent.payload!;
      const error = async (payload: Record<string, unknown>) =>
        (await host.reply(host.send('SERVER_CONTROL_RESULT', payload))).payload;
      // Forged operationId: unknown, and nothing is created from it.
      expect(
        await error({
          operationId: randomUUID(),
          correlationId: ids.correlationId,
          type: 'SERVER_START',
          outcome: 'SUCCEEDED',
        }),
      ).toMatchObject({ code: 'UNKNOWN_OPERATION' });
      // The action is the backend's: another one is refused.
      expect(
        await error({
          operationId: id,
          correlationId: ids.correlationId,
          type: 'SERVER_RESTART',
          outcome: 'SUCCEEDED',
        }),
      ).toMatchObject({ code: 'OPERATION_MISMATCH' });
      expect(
        await error({
          operationId: id,
          correlationId: randomUUID(),
          type: 'SERVER_START',
          outcome: 'SUCCEEDED',
        }),
      ).toMatchObject({ code: 'INVALID_MESSAGE' });
      for (const extra of [
        { outcome: 'SUCCEEDED', message: 'started' },
        { outcome: 'FAILED', errorCode: 'EXECUTION_FAILED', stack: 'Error' },
        { outcome: 'FAILED', errorCode: 'SHELL_EXIT_1' },
        { outcome: 'DONE' },
        { outcome: 'SUCCEEDED', command: '/usr/bin/skyrim --start' },
      ])
        expect(
          await error({
            operationId: id,
            correlationId: ids.correlationId,
            type: 'SERVER_START',
            ...extra,
          }),
        ).toMatchObject({ code: 'INVALID_MESSAGE', retryable: false });
      expect((await row(id)).status).toBe('DISPATCHED');
      await host.reply(host.perform(sent)!);
      // Conflicting result after the terminal one.
      expect(
        await error({
          operationId: id,
          correlationId: ids.correlationId,
          type: 'SERVER_START',
          outcome: 'FAILED',
          errorCode: 'EXECUTION_FAILED',
        }),
      ).toMatchObject({ code: 'RESULT_CONFLICT' });
      expect((await row(id)).status).toBe('SUCCEEDED');
      // A result before the delivery boundary is impossible.
      const other = await servers.register({
        code: randomUUID(),
        name: 'Idle',
      });
      const partial = await agent(['SERVER_CONTROL_V1'], STOPPED, {
        serverId: other.id,
      });
      const held = await start('SERVER_PAUSE', other.id);
      const early = await partial.reply(
        partial.controlResult(
          {
            operationId: held,
            correlationId: (await row(held)).correlationId,
            type: 'SERVER_PAUSE',
          },
          { outcome: 'SUCCEEDED' },
        ),
      );
      expect(early.payload).toMatchObject({ code: 'NOT_DISPATCHED' });
      expect((await row(held)).status).toBe('PENDING');
      // Another server's operation: the session is closed.
      host.controlResult(
        {
          operationId: held,
          correlationId: (await row(held)).correlationId,
          type: 'SERVER_PAUSE',
        },
        { outcome: 'SUCCEEDED' },
      );
      expect(await host.client.closedWith()).toEqual({
        code: 4010,
        reason: 'SERVER_MISMATCH',
      });
      expect((await row(held)).status).toBe('PENDING');
      expect(
        await database.query(
          'SELECT count(*)::int AS n FROM server_control_operations WHERE game_server_id IN ($1, $2)',
          [server.id, other.id],
        ),
      ).toEqual([{ n: 2 }]);
    });
    it('keeps RBAC in the backend: Staff without the grant and Players never reach the Agent', async () => {
      const host = await agent();
      await control('SERVER_START', server.id, tokens.ADMIN).expect(403);
      const code = `code-${randomUUID()}`;
      discord.codes.set(code, { subject: `${Date.now()}`, displayName: 'P' });
      const player = (
        await http()
          .post('/api/v1/player/auth/discord/exchange')
          .send({ authorizationCode: code, redirectUri: 'http://127.0.0.1/cb' })
          .expect(200)
      ).body;
      await control('SERVER_START', server.id, player.accessToken).expect(401);
      await pause(300);
      expect(host.controls()).toEqual([]);
      expect(
        await database.query(
          'SELECT id FROM server_control_operations WHERE game_server_id = $1',
          [server.id],
        ),
      ).toEqual([]);
    });
    it('keeps one non-terminal operation per server under concurrent requests and dispatches it once', async () => {
      const host = await agent();
      const responses = await Promise.all(
        (['SERVER_START', 'SERVER_PAUSE', 'SERVER_RESTART'] as const).flatMap(
          (type) => Array.from({ length: 4 }, () => control(type)),
        ),
      );
      const accepted = responses.filter((r) => r.status === 202);
      expect(accepted).toHaveLength(1);
      expect(responses.filter((r) => r.status === 409)).toHaveLength(11);
      const id = accepted[0].body.operationId as string;
      await host.control(id);
      await pause(400);
      expect(host.controls()).toHaveLength(1);
      // A result racing a new request: no deadlock, and the request is
      // refused only while the first one is still open.
      const [ack, raced] = await Promise.all([
        host.reply(host.perform(host.controls(id)[0])!),
        control('SERVER_PAUSE'),
      ]);
      expect(ack.payload).toMatchObject({ status: 'SUCCEEDED' });
      expect([202, 409]).toContain(raced.status);
      if (raced.status === 409) await control('SERVER_PAUSE').expect(202);
    });
    it('lets exactly one of RESULT and deadline decide, coherently', async () => {
      const host = await agent();
      const receiver = app.get(ServerControlReceiver);
      const id = await start('SERVER_RESTART');
      const sent = await host.control(id);
      await eventually(async () => (await status(id)) === 'DISPATCHED');
      await database.query(
        "UPDATE server_control_operations SET result_deadline_at = now() + interval '40 milliseconds' WHERE id = $1",
        [id],
      );
      await pause(40);
      const [reply] = await Promise.all([
        host.reply(host.perform(sent)!),
        receiver.expireResults(),
      ]);
      const final = await status(id);
      expect(['SUCCEEDED', 'UNCERTAIN']).toContain(final);
      if (reply.type === 'SERVER_CONTROL_RESULT_ACK')
        expect(reply.payload).toMatchObject({
          status: final,
          accepted: final === 'SUCCEEDED',
        });
      else expect(reply.payload).toMatchObject({ code: 'RESULT_CONFLICT' });
      expect(frames(id)).toBe(1);
    });
    it('after a backend restart: never resends claimed work, accepts its RESULT, and expires it by the persisted deadline', async () => {
      const host = await agent();
      const now = Date.now();
      // Claimed by the previous process, which died before reconciling.
      const insert = async (serverId: string, deadline: number) => {
        const id = randomUUID();
        await database.query(
          "INSERT INTO server_control_operations(id, game_server_id, type, status, idempotency_key, correlation_id, requested_by_staff_id, dispatch_claimed_at, dispatch_connection_id, not_after, result_deadline_at) VALUES ($1, $2, 'SERVER_RESTART', 'PENDING', $3, $4, (SELECT id FROM staff_users WHERE username = 'coordinator'), $5, $6, $7, $8)",
          [
            id,
            serverId,
            randomUUID(),
            randomUUID(),
            new Date(now),
            host.connectionId,
            new Date(now + 1000),
            new Date(deadline),
          ],
        );
        return id;
      };
      const reported = await insert(server.id, now + 60000);
      const orphan = await insert(
        (await servers.register({ code: randomUUID(), name: 'Gone' })).id,
        now - 1,
      );
      await pause(400);
      expect(host.controls()).toEqual([]);
      expect((await row(reported)).status).toBe('PENDING');
      await eventually(async () => (await status(orphan)) === 'UNCERTAIN');
      const stored = await row(reported);
      const ack = await host.reply(
        host.controlResult(
          {
            operationId: reported,
            correlationId: stored.correlationId,
            type: 'SERVER_RESTART',
          },
          { outcome: 'SUCCEEDED' },
        ),
      );
      expect(ack.payload).toMatchObject({
        status: 'SUCCEEDED',
        accepted: true,
      });
      expect((await row(reported)).dispatchedAt).toEqual(
        stored.dispatchClaimedAt,
      );
      expect(host.controls()).toEqual([]);
    });
    it('sends only to the newest session of a duplicated Agent connection', async () => {
      const key = await credential();
      const old = await agent(CONTROL_CAPS, STOPPED, { key });
      const current = await agent(CONTROL_CAPS, STOPPED, { key });
      expect(await old.client.closedWith()).toMatchObject({ code: 4006 });
      const id = await start('SERVER_START');
      const sent = await current.control(id);
      expect(old.controls()).toEqual([]);
      expect((await row(id)).dispatchConnectionId).toBe(current.connectionId);
      await current.reply(current.perform(sent)!);
      expect((await row(id)).status).toBe('SUCCEEDED');
    });
  },
);
