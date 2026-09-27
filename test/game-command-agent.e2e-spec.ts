import { jest } from '@jest/globals';
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
import { playerActor } from '../src/actors/actor.contracts.js';
import { GameServerService } from '../src/game-bridge/game-server.service.js';
import { GameCommandBus } from '../src/game-bridge/game-command-bus.js';
import type { GameCommand } from '../src/game-bridge/entities/game-command.entity.js';
import type { GameServer } from '../src/game-bridge/entities/game-server.entity.js';
import { DiscordIdentityProvider } from '../src/player-auth/discord-identity.provider.js';
import { PlayerAuthRateLimiter } from '../src/player-auth/player-auth-rate-limit.js';
import { CharacterLinkService } from '../src/player-characters/character-link.service.js';
import { AgentSessionRegistry } from '../src/game-agent/agent-session.registry.js';
import { SKILL_NAMES } from '../src/player-character-operations/character-profile.contracts.js';
import { FakeDiscordProvider } from './support/fake-discord-provider.js';
import { startPerfTrace } from './support/perf-trace.js';
import { FakeAgent } from './support/fake-agent.js';

const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;
const QUERY_CAPS = [
  'GAME_COMMAND_V1',
  'BRIDGE_PING',
  'CHARACTER_INVENTORY_QUERY',
  'CHARACTER_PROFILE_QUERY',
  'CHARACTER_SKILLS_QUERY',
];
const MUTATION_CAPS = ['CHARACTER_ITEM_GIVE', 'COMMAND_DEDUP_V1'];
const FULL_CAPS = [...QUERY_CAPS, ...MUTATION_CAPS];
const CHARACTER = 'opaque:character-42';
const inventory = {
  characterId: CHARACTER,
  items: [{ itemId: 'opaque:target-1', displayName: 'Example', quantity: 2 }],
};
const given = {
  characterId: CHARACTER,
  applied: true,
  targetId: 'opaque:target-1',
};
async function eventually<T>(
  check: () => Promise<T | undefined | false>,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (performance.now() > deadline) throw new Error('Timed out waiting for state');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeDatabase(
  'GameCommand execution through the Host Agent with real PostgreSQL',
  () => {
    let admin: DataSource, database: DataSource, app: INestApplication<App>;
    let servers: GameServerService, registry: AgentSessionRegistry;
    let bus: GameCommandBus, links: CharacterLinkService;
    let server: GameServer, url: string, staffToken: string;
    const agents: FakeAgent[] = [];
    let stopPerfTrace = () => {};
    const discord = new FakeDiscordProvider();
    const schema = `game_command_agent_test_${randomUUID().replaceAll('-', '')}`;
    const http = () => request(app.getHttpServer());
    const credential = async (serverId = server.id) =>
      (
        await http()
          .post(`/api/v1/admin/game-servers/${serverId}/agent-credentials`)
          .auth(staffToken, { type: 'bearer' })
          .expect(201)
      ).body as { credentialId: string; credentialSecret: string };
    const agent = async (
      capabilities = FULL_CAPS,
      runtime = { gameProcessState: 'RUNNING', skseReady: true },
      options: {
        serverId?: string;
        key?: Awaited<ReturnType<typeof credential>>;
        journal?: FakeAgent;
      } = {},
    ) => {
      const serverId = options.serverId ?? server.id;
      const created = new FakeAgent(
        url,
        serverId,
        options.journal?.journal,
        options.journal?.executions,
      );
      agents.push(created);
      await created.hello(
        options.key ?? (await credential(serverId)),
        capabilities,
        runtime,
      );
      return created;
    };
    const staffPost = (path: string, body: object = {}, serverId = server.id) =>
      http()
        .post(
          `/api/v1/game-servers/${serverId}/characters/${CHARACTER}/${path}`,
        )
        .auth(staffToken, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send(body)
        .expect(202)
        .then((r) => r.body.commandId as string);
    const operation = (commandId: string) =>
      http()
        .get(`/api/v1/character-operations/${commandId}`)
        .auth(staffToken, { type: 'bearer' })
        .expect(200)
        .then((r) => r.body);
    const command = (id: string) =>
      database
        .getRepository<GameCommand>('GameCommand')
        .findOneByOrFail({ id });
    const status = async (id: string) => (await command(id)).status;
    const resultRows = (id: string) =>
      database.query(
        'SELECT * FROM game_command_results WHERE game_command_id = $1',
        [id],
      );
    const auditRows = (id: string) =>
      database.query(
        "SELECT action FROM audit_logs WHERE resource_type = 'CHARACTER' AND metadata->>'commandId' = $1",
        [id],
      );

    beforeAll(async () => {
      process.env.GAME_COMMAND_WORKER_INTERVAL_MS = '100';
      process.env.GAME_COMMAND_ACK_TIMEOUT_MS = '600';
      process.env.GAME_COMMAND_PENDING_TIMEOUT_MS = '4000';
      process.env.AGENT_MAX_IN_FLIGHT_COMMANDS = '2';
      process.env.AGENT_MESSAGE_RATE_LIMIT_COUNT = '40';
      process.env.AGENT_MESSAGE_RATE_LIMIT_WINDOW_MS = '2000';
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
      bus = app.get(GameCommandBus);
      links = app.get(CharacterLinkService);
      const password = 'Command-Agent-Password-42';
      await database.query(
        "INSERT INTO staff_users(username, display_name, password_hash, role_name) VALUES ('coordinator', 'C', $1, 'COORDINATOR')",
        [await new PasswordService().hash(password)],
      );
      staffToken = (
        await http()
          .post('/api/v1/auth/login')
          .send({ username: 'coordinator', password })
          .expect(200)
      ).body.accessToken;
    }, 60000);
    beforeEach(async () => {
      stopPerfTrace = startPerfTrace(app);
      app.get(PlayerAuthRateLimiter).reset();
      server = await servers.register({ code: randomUUID(), name: 'Commands' });
    });
    afterEach(async () => {
      for (const created of agents.splice(0)) await created.close();
      await eventually(async () => registry.count() === 0);
      stopPerfTrace();
    });
    afterAll(async () => {
      for (const name of [
        'GAME_COMMAND_WORKER_INTERVAL_MS',
        'GAME_COMMAND_ACK_TIMEOUT_MS',
        'GAME_COMMAND_PENDING_TIMEOUT_MS',
        'AGENT_MAX_IN_FLIGHT_COMMANDS',
        'AGENT_MESSAGE_RATE_LIMIT_COUNT',
        'AGENT_MESSAGE_RATE_LIMIT_WINDOW_MS',
      ])
        delete process.env[name];
      await app?.close();
      if (database?.isInitialized) await database.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.destroy();
      }
    });

    it('runs a Staff query and a Staff mutation end to end: COMMAND, ACK, RESULT, operation API', async () => {
      const host = await agent();
      const query = await staffPost('inventory/query');
      const sent = await host.command(query);
      expect(sent.payload).toEqual({
        commandId: query,
        correlationId: (await command(query)).correlationId,
        attempt: 1,
        type: 'CHARACTER_INVENTORY_QUERY',
        payload: { characterId: CHARACTER },
        issuedAt: expect.any(String),
        ackDeadlineAt: expect.any(String),
        executionDeadlineAt: expect.any(String),
      });
      // Nothing internal leaves the backend.
      expect(JSON.stringify(sent)).not.toMatch(
        /idempotency|requestedBy|actor|token/i,
      );
      // The frame may arrive before the send is reconciled (PENDING -> DISPATCHED).
      await eventually(async () => (await status(query)) === 'DISPATCHED');
      host.ack(sent);
      await eventually(async () => (await status(query)) === 'ACKNOWLEDGED');
      const ack = await host.reply(
        host.result(sent.payload!, { outcome: 'SUCCEEDED', result: inventory }),
      );
      expect(ack).toMatchObject({
        type: 'COMMAND_RESULT_ACK',
        payload: {
          commandId: query,
          status: 'SUCCEEDED',
          accepted: true,
          duplicate: false,
        },
      });
      expect(await operation(query)).toMatchObject({
        status: 'SUCCEEDED',
        dispatchAttempts: 1,
        result: { outcome: 'SUCCEEDED', result: inventory },
      });
      const mutation = await staffPost('inventory/items/give', {
        itemId: 'opaque:target-1',
        quantity: 2,
      });
      const give = await host.command(mutation);
      host.ack(give);
      await host.reply(host.execute(give, () => given));
      expect(await operation(mutation)).toMatchObject({
        status: 'SUCCEEDED',
        requestedByStaffId: expect.any(String),
        result: { outcome: 'SUCCEEDED', result: given },
      });
      expect(host.executions.get(mutation)).toBe(1);
      // Only the creation is audited: ACK and RESULT add nothing.
      expect(await auditRows(mutation)).toEqual([
        { action: 'CHARACTER_ITEM_GIVE_REQUESTED' },
      ]);
    });
    it('runs a Player query end to end with the PLAYER actor and the ownership check', async () => {
      const code = `code-${randomUUID()}`;
      discord.codes.set(code, { subject: `${Date.now()}`, displayName: 'P' });
      const player = (
        await http()
          .post('/api/v1/player/auth/discord/exchange')
          .send({ authorizationCode: code, redirectUri: 'http://127.0.0.1/cb' })
          .expect(200)
      ).body;
      const characterExternalId = `char:${randomUUID()}`;
      const requested = await links.request(playerActor(player.player.id), {
        gameServerId: server.id,
        characterExternalId,
      });
      await links.confirmFromAgent({
        challenge: requested.challenge,
        gameServerId: server.id,
        characterExternalId,
      });
      const host = await agent();
      const base = `/api/v1/player/game-servers/${server.id}/characters/${characterExternalId}`;
      // Ownership is the backend's: an unowned character never reaches the Agent.
      await http()
        .post(
          `${base.replace(characterExternalId, 'someone-else')}/profile-query`,
        )
        .auth(player.accessToken, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .expect(404);
      const { operationId } = (
        await http()
          .post(`${base}/skills-query`)
          .auth(player.accessToken, { type: 'bearer' })
          .set('Idempotency-Key', randomUUID())
          .expect(202)
      ).body;
      const sent = await host.command(operationId);
      expect(sent.payload!.type).toBe('CHARACTER_SKILLS_QUERY');
      const stored = await command(operationId);
      expect(stored).toMatchObject({
        actorType: 'PLAYER',
        requestedByPlayerId: player.player.id,
        requestedByStaffId: null,
      });
      const skills = {
        characterId: characterExternalId,
        skills: Object.fromEntries(SKILL_NAMES.map((name) => [name, 15])),
      };
      host.ack(sent);
      await host.reply(
        host.result(sent.payload!, { outcome: 'SUCCEEDED', result: skills }),
      );
      const detail = await http()
        .get(`/api/v1/player/character-operations/${operationId}`)
        .auth(player.accessToken, { type: 'bearer' })
        .expect(200);
      expect(detail.body).toMatchObject({
        status: 'SUCCEEDED',
        result: { outcome: 'SUCCEEDED', data: skills },
      });
      expect(host.commands()).toHaveLength(1);
    });
    it('accepts the RESULT through a new session after the dispatching one dropped', async () => {
      const first = await agent();
      const key = await credential();
      const query = await staffPost('inventory/query');
      const sent = await first.command(query);
      first.ack(sent);
      await eventually(async () => (await status(query)) === 'ACKNOWLEDGED');
      const dispatchedOn = (await command(query)).dispatchedConnectionId;
      expect(dispatchedOn).toBe(first.connectionId);
      await first.close();
      await eventually(async () => !registry.isConnected(server.id));
      const second = await agent(FULL_CAPS, undefined, { key, journal: first });
      expect(second.connectionId).not.toBe(first.connectionId);
      // ACKNOWLEDGED is never resent; the Agent replays the result it has.
      const ack = await second.reply(
        second.result(sent.payload!, {
          outcome: 'SUCCEEDED',
          result: inventory,
        }),
      );
      expect(ack.payload).toMatchObject({
        status: 'SUCCEEDED',
        accepted: true,
      });
      const done = await command(query);
      expect(done.status).toBe('SUCCEEDED');
      // The dispatching connection stays as provenance.
      expect(done.dispatchedConnectionId).toBe(dispatchedOn);
      expect(second.commands()).toEqual([]);
    });
    it('retries with the same identity on the new session and ignores the stale ACK of the old attempt', async () => {
      const first = await agent();
      const key = await credential();
      const query = await staffPost('inventory/query');
      const attempt1 = await first.command(query, 1);
      await first.close();
      await eventually(async () => !registry.isConnected(server.id));
      const second = await agent(FULL_CAPS, undefined, { key });
      // After the ACK window the worker retries on the new session.
      const attempt2 = await second.command(query, 2);
      expect(attempt2.payload).toMatchObject({
        commandId: attempt1.payload!.commandId,
        correlationId: attempt1.payload!.correlationId,
        type: attempt1.payload!.type,
        payload: attempt1.payload!.payload,
        executionDeadlineAt: attempt1.payload!.executionDeadlineAt,
      });
      const retried = await command(query);
      expect(retried).toMatchObject({
        status: 'DISPATCHED',
        dispatchAttempts: 2,
        dispatchedConnectionId: second.connectionId,
      });
      // A late ACK of attempt 1 confirms nothing about attempt 2.
      second.ack(attempt2, 1);
      const diagnosticStart = performance.now();
      // Frames are processed serially on this socket. HEARTBEAT_ACK proves
      // the stale ACK was handled before we inspect persisted command state.
      await second.heartbeat('RUNNING', true);
      if (process.env.PERF_FLAKE_TRACE)
        console.error(
          JSON.stringify({
            flake: 'gamecommand',
            waitMs: performance.now() - diagnosticStart,
            ackWindowMs: 600,
            state: await command(query),
          }),
        );
      expect(await command(query)).toMatchObject({
        status: 'DISPATCHED',
        dispatchAttempts: 2,
        dispatchedConnectionId: second.connectionId,
        acknowledgedAt: null,
      });
      second.ack(attempt2);
      await eventually(async () => (await status(query)) === 'ACKNOWLEDGED');
      await second.reply(
        second.result(attempt2.payload!, {
          outcome: 'SUCCEEDED',
          result: inventory,
        }),
      );
      expect(await status(query)).toBe('SUCCEEDED');
    });
    it('lets the journal absorb a redelivered mutation: executed once, result replayed', async () => {
      const host = await agent();
      const mutation = await staffPost('inventory/items/give', {
        itemId: 'opaque:target-1',
        quantity: 2,
      });
      const attempt1 = await host.command(mutation, 1);
      // Executed and journaled, but neither ACK nor RESULT left the Agent.
      host.journal.set(mutation, { state: 'COMPLETED', result: given });
      host.executions.set(mutation, 1);
      // After the ACK window the same commandId is redelivered.
      const attempt2 = await host.command(mutation, 2);
      expect(attempt2.payload).toMatchObject({
        commandId: attempt1.payload!.commandId,
        correlationId: attempt1.payload!.correlationId,
        payload: attempt1.payload!.payload,
      });
      host.ack(attempt2);
      await host.reply(
        host.execute(attempt2, () => {
          throw new Error('must not execute again');
        }),
      );
      expect(host.executions.get(mutation)).toBe(1);
      expect(await operation(mutation)).toMatchObject({
        status: 'SUCCEEDED',
        dispatchAttempts: 2,
        result: { result: given },
      });
    });
    it('records EXECUTION_UNCERTAIN as TIMEOUT, never FAILED, and does not reopen it', async () => {
      const host = await agent();
      const mutation = await staffPost('inventory/items/give', {
        itemId: 'opaque:target-1',
        quantity: 2,
      });
      const sent = await host.command(mutation);
      host.ack(sent);
      const uncertain = await host.reply(
        host.result(sent.payload!, { outcome: 'UNCERTAIN' }),
      );
      expect(uncertain.payload).toMatchObject({
        status: 'TIMEOUT',
        accepted: true,
        duplicate: false,
      });
      expect(await operation(mutation)).toMatchObject({
        status: 'TIMEOUT',
        result: {
          outcome: 'TIMEOUT',
          errorCode: 'EXECUTION_UNCERTAIN',
          result: null,
        },
      });
      const again = await host.reply(
        host.result(sent.payload!, { outcome: 'UNCERTAIN' }),
      );
      expect(again.payload).toMatchObject({ duplicate: true });
      const late = await host.reply(
        host.result(sent.payload!, { outcome: 'SUCCEEDED', result: given }),
      );
      expect(late).toMatchObject({
        type: 'ERROR',
        payload: { code: 'RESULT_CONFLICT' },
      });
      expect(await status(mutation)).toBe('TIMEOUT');
      expect(await resultRows(mutation)).toHaveLength(1);
      // A remote FAILED keeps its catalog code.
      const other = await staffPost('inventory/query');
      const failing = await host.command(other);
      await host.reply(
        host.result(failing.payload!, {
          outcome: 'FAILED',
          errorCode: 'EXECUTION_FAILED',
        }),
      );
      expect(await operation(other)).toMatchObject({
        status: 'FAILED',
        result: {
          errorCode: 'EXECUTION_FAILED',
          errorMessage: 'Game execution failed',
        },
      });
    });
    it('treats duplicate RESULT as idempotent and rejects conflicting, unknown, malformed and foreign ones', async () => {
      const host = await agent();
      const query = await staffPost('inventory/query');
      const sent = await host.command(query);
      const ids = sent.payload!;
      // Invalid results persist nothing and leave the command open.
      for (const [outcome, code] of [
        [
          { outcome: 'SUCCEEDED', result: { arbitrary: true } },
          'INVALID_MESSAGE',
        ],
        [
          {
            outcome: 'SUCCEEDED',
            result: { ...inventory, characterId: 'someone-else' },
          },
          'INVALID_MESSAGE',
        ],
        [
          {
            outcome: 'SUCCEEDED',
            result: {
              ...inventory,
              items: [
                {
                  itemId: 'x'.repeat(100),
                  quantity: 1,
                  displayName: 'y'.repeat(70000),
                },
              ],
            },
          },
          'INVALID_MESSAGE',
        ],
        [{ outcome: 'FAILED', errorCode: 'STACK_TRACE' }, 'INVALID_MESSAGE'],
        [
          {
            outcome: 'FAILED',
            errorCode: 'EXECUTION_FAILED',
            errorMessage: 'at Foo.bar',
          },
          'INVALID_MESSAGE',
        ],
        [{ outcome: 'TIMEOUT' }, 'INVALID_MESSAGE'],
      ] as const) {
        const answer = await host.reply(host.result(ids, outcome));
        expect(answer).toMatchObject({ type: 'ERROR', payload: { code } });
      }
      const wrongCorrelation = await host.reply(
        host.result(
          { ...ids, correlationId: randomUUID() },
          { outcome: 'SUCCEEDED', result: inventory },
        ),
      );
      expect(wrongCorrelation.payload).toMatchObject({
        code: 'INVALID_MESSAGE',
      });
      const unknown = await host.reply(
        host.result(
          { commandId: randomUUID(), correlationId: randomUUID() },
          { outcome: 'SUCCEEDED', result: inventory },
        ),
      );
      expect(unknown.payload).toMatchObject({ code: 'UNKNOWN_COMMAND' });
      expect(await resultRows(query)).toEqual([]);
      expect(await status(query)).toBe('DISPATCHED');
      const first = await host.reply(
        host.result(ids, { outcome: 'SUCCEEDED', result: inventory }),
      );
      expect(first.payload).toMatchObject({ accepted: true, duplicate: false });
      const replay = await host.reply(
        host.result(ids, { outcome: 'SUCCEEDED', result: inventory }),
      );
      expect(replay).toMatchObject({
        type: 'COMMAND_RESULT_ACK',
        payload: { status: 'SUCCEEDED', accepted: true, duplicate: true },
      });
      const conflict = await host.reply(
        host.result(ids, { outcome: 'FAILED', errorCode: 'EXECUTION_FAILED' }),
      );
      expect(conflict.payload).toMatchObject({ code: 'RESULT_CONFLICT' });
      expect(await resultRows(query)).toHaveLength(1);
      // A result for a command never dispatched...
      const idle = await bus.submit({
        gameServerId: (
          await servers.register({ code: randomUUID(), name: 'Idle' })
        ).id,
        type: 'BRIDGE_PING',
        payload: { nonce: 'idle' },
        idempotencyKey: randomUUID(),
      });
      // ...of another server: the socket is closed.
      host.result(
        { commandId: idle.id, correlationId: idle.correlationId },
        { outcome: 'SUCCEEDED', result: { nonce: 'idle' } },
      );
      expect(await host.client.closedWith()).toEqual({
        code: 4010,
        reason: 'SERVER_MISMATCH',
      });
      expect(await resultRows(idle.id)).toEqual([]);
    });
    it('closes the session on an ACK for another server and refuses a result before dispatch', async () => {
      const host = await agent();
      // The Agent does not support this type, so it stays PENDING.
      const pending = await bus.submit({
        gameServerId: server.id,
        type: 'CHARACTER_HOLD_GRANT',
        payload: { characterId: CHARACTER, holdId: 'opaque:hold' },
        idempotencyKey: randomUUID(),
      });
      const early = await host.reply(
        host.result(
          { commandId: pending.id, correlationId: pending.correlationId },
          {
            outcome: 'SUCCEEDED',
            result: {
              characterId: CHARACTER,
              applied: true,
              targetId: 'opaque:hold',
            },
          },
        ),
      );
      expect(early.payload).toMatchObject({ code: 'NOT_DISPATCHED' });
      expect(await status(pending.id)).toBe('PENDING');
      const foreignServer = await servers.register({
        code: randomUUID(),
        name: 'Foreign',
      });
      const foreign = await bus.submit({
        gameServerId: foreignServer.id,
        type: 'BRIDGE_PING',
        payload: { nonce: 'foreign' },
        idempotencyKey: randomUUID(),
      });
      host.send('COMMAND_ACK', {
        commandId: foreign.id,
        correlationId: foreign.correlationId,
        attempt: 1,
      });
      expect(await host.client.closedWith()).toEqual({
        code: 4010,
        reason: 'SERVER_MISMATCH',
      });
      expect(await status(foreign.id)).toBe('PENDING');
    });
    it('holds commands without a compatible capability and never sends mutations without the dedup journal', async () => {
      const host = await agent([
        'CHARACTER_INVENTORY_QUERY',
        'CHARACTER_ITEM_GIVE',
      ]);
      const query = await staffPost('inventory/query');
      await pause(500);
      // No GAME_COMMAND_V1: nothing sent, no attempt consumed.
      expect(host.commands()).toEqual([]);
      expect(await command(query)).toMatchObject({
        status: 'PENDING',
        dispatchAttempts: 0,
      });
      // Protocol + query capability, still no journal.
      await host.heartbeat('RUNNING', true, [
        'GAME_COMMAND_V1',
        'CHARACTER_INVENTORY_QUERY',
        'CHARACTER_ITEM_GIVE',
      ]);
      const mutation = await staffPost('inventory/items/give', {
        itemId: 'opaque:target-1',
        quantity: 2,
      });
      await host.command(query);
      await pause(500);
      expect(host.commands(mutation)).toEqual([]);
      expect(await command(mutation)).toMatchObject({
        status: 'PENDING',
        dispatchAttempts: 0,
      });
      // Declaring the journal makes the mutation deliverable.
      await host.heartbeat('RUNNING', true, [
        'GAME_COMMAND_V1',
        'CHARACTER_INVENTORY_QUERY',
        'CHARACTER_ITEM_GIVE',
        'COMMAND_DEDUP_V1',
      ]);
      expect((await host.command(mutation)).payload!.type).toBe(
        'CHARACTER_ITEM_GIVE',
      );
    });
    it('waits for the runtime: a connected but stopped game gets nothing, then RUNNING + SKSE ready does', async () => {
      const host = await agent(FULL_CAPS, {
        gameProcessState: 'STOPPED',
        skseReady: false,
      });
      const query = await staffPost('inventory/query');
      await pause(400);
      expect(host.commands()).toEqual([]);
      expect(await command(query)).toMatchObject({
        status: 'PENDING',
        dispatchAttempts: 0,
      });
      await host.heartbeat('RUNNING', false);
      await pause(400);
      expect(host.commands()).toEqual([]);
      expect((await command(query)).dispatchAttempts).toBe(0);
      await host.heartbeat('RUNNING', true);
      const sent = await host.command(query);
      expect(sent.payload!.attempt).toBe(1);
    });
    it('keeps the per-server in-flight budget from the database and resumes as commands finish', async () => {
      const host = await agent();
      const ids = [
        await staffPost('inventory/query'),
        await staffPost('inventory/query'),
        await staffPost('inventory/query'),
      ];
      const distinct = () =>
        new Set(host.commands().map((c) => c.payload!.commandId));
      await eventually(async () => distinct().size === 2);
      for (const sent of host.commands()) host.ack(sent);
      await pause(400);
      expect(distinct().size).toBe(2);
      const [waiting] = await database.query(
        "SELECT id, dispatch_attempts FROM game_commands WHERE game_server_id = $1 AND status = 'PENDING'",
        [server.id],
      );
      expect(waiting.dispatch_attempts).toBe(0);
      const first = host.commands()[0];
      await host.reply(
        host.result(first.payload!, {
          outcome: 'SUCCEEDED',
          result: inventory,
        }),
      );
      await host.command(waiting.id);
      expect(distinct()).toEqual(new Set(ids));
    });
    it('dispatches commands created while no Agent was connected once one connects, and expires them otherwise', async () => {
      const query = await staffPost('inventory/query');
      const stale = await bus.submit({
        gameServerId: (
          await servers.register({ code: randomUUID(), name: 'Nobody' })
        ).id,
        type: 'BRIDGE_PING',
        payload: { nonce: 'nobody' },
        idempotencyKey: randomUUID(),
      });
      await pause(300);
      expect(await command(query)).toMatchObject({
        status: 'PENDING',
        dispatchAttempts: 0,
      });
      const host = await agent();
      expect((await host.command(query)).payload!.commandId).toBe(query);
      // Never deliverable: FAILED/DISPATCH_EXPIRED after the pending timeout,
      // without ever consuming an attempt.
      await eventually(async () => (await status(stale.id)) === 'FAILED', 8000);
      expect(await command(stale.id)).toMatchObject({ dispatchAttempts: 0 });
      expect(await resultRows(stale.id)).toMatchObject([
        { outcome: 'FAILED', error_code: 'DISPATCH_EXPIRED' },
      ]);
    }, 15000);
    it('closes a flooding session with RATE_LIMITED', async () => {
      const host = await agent();
      for (let i = 0; i < 45; i++)
        host.send('HEARTBEAT', {
          gameProcessState: 'RUNNING',
          skseReady: true,
        });
      expect(await host.client.closedWith()).toEqual({
        code: 4012,
        reason: 'RATE_LIMITED',
      });
    });
    // 12.6B: the window is elapsed time. A backward civil step used to
    // freeze it, so a well-behaved Agent (30 frames per 2 s, limit 40)
    // accumulated across windows and was closed as RATE_LIMITED.
    const beat = { gameProcessState: 'RUNNING', skseReady: true };
    const stepClock = (
      target: { now(): number },
      offsetMs: number,
    ): (() => void) => {
      const real = target.now.bind(target);
      const spy = jest
        .spyOn(target, 'now')
        .mockImplementation(() => real() + offsetMs);
      return () => spy.mockRestore();
    };
    // Three real windows of 30 frames each (limit 40 per 2 s).
    const wellBehaved = async (host: FakeAgent) => {
      for (let window = 0; window < 3; window++) {
        for (let i = 0; i < 29; i++) host.send('HEARTBEAT', beat);
        await host.heartbeat('RUNNING', true);
        // Intentional elapsed window (not waiting for async work).
        await pause(2100);
      }
    };
    it('keeps the message window across windows without a clock step', async () => {
      const host = await agent();
      await host.heartbeat('RUNNING', true);
      await wellBehaved(host);
      expect((await host.heartbeat('RUNNING', true)).type).toBe(
        'HEARTBEAT_ACK',
      );
    }, 20000);
    it('keeps the message window across a backward civil clock step', async () => {
      const host = await agent();
      await host.heartbeat('RUNNING', true);
      const restore = stepClock(Date, -60_000);
      try {
        await wellBehaved(host);
        expect((await host.heartbeat('RUNNING', true)).type).toBe(
          'HEARTBEAT_ACK',
        );
      } finally {
        restore();
      }
    }, 20000);
    it('keeps the message window across a forward civil clock step', async () => {
      const host = await agent();
      await host.heartbeat('RUNNING', true);
      const restore = stepClock(Date, 60_000);
      try {
        await wellBehaved(host);
        expect((await host.heartbeat('RUNNING', true)).type).toBe(
          'HEARTBEAT_ACK',
        );
      } finally {
        restore();
      }
    }, 20000);
    // A forward civil step used to reset the window: 20 + 25 frames within one
    // real window slipped under the limit. Elapsed time still counts 45.
    it('does not reset the window on a forward civil clock step', async () => {
      const host = await agent();
      await host.heartbeat('RUNNING', true);
      for (let i = 0; i < 19; i++) host.send('HEARTBEAT', beat);
      await host.heartbeat('RUNNING', true);
      const restore = stepClock(Date, 60_000);
      try {
        for (let i = 0; i < 25; i++) host.send('HEARTBEAT', beat);
        expect(await host.client.closedWith()).toEqual({
          code: 4012,
          reason: 'RATE_LIMITED',
        });
      } finally {
        restore();
      }
    });
    // Control (12.6B evidence): the same backward step applied to the clock
    // the window actually reads reproduces the false RATE_LIMITED. Before
    // 12.6B that clock was Date.now, i.e. exactly the civil step above.
    it('control: a step of the window clock itself closes a well-behaved Agent', async () => {
      const host = await agent();
      await host.heartbeat('RUNNING', true);
      const restore = stepClock(performance, -60_000);
      try {
        await expect(wellBehaved(host)).rejects.toThrow();
        expect(await host.client.closedWith()).toEqual({
          code: 4012,
          reason: 'RATE_LIMITED',
        });
      } finally {
        restore();
      }
    }, 20000);
  },
);
