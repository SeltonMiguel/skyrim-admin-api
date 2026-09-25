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
import { BridgeClock } from '../src/game-bridge/bridge-clock.js';
import { GameGateway } from '../src/game-bridge/game-gateway.js';
import { GameServerService } from '../src/game-bridge/game-server.service.js';
import { GameConnectionService } from '../src/game-bridge/game-connection.service.js';
import { GameCommandDispatcher } from '../src/game-bridge/game-command-dispatcher.js';
import { GameCommandReceiver } from '../src/game-bridge/game-command-receiver.js';
import { CommandStatus as S } from '../src/game-bridge/command-state.js';
import type { ResultMessage } from '../src/game-bridge/command-contract.js';
import type { GameCommand } from '../src/game-bridge/entities/game-command.entity.js';
import type { GameServer } from '../src/game-bridge/entities/game-server.entity.js';
import { DiscordIdentityProvider } from '../src/player-auth/discord-identity.provider.js';
import { PlayerAuthRateLimiter } from '../src/player-auth/player-auth-rate-limit.js';
import { CharacterLinkService } from '../src/player-characters/character-link.service.js';
import { playerActor } from '../src/actors/actor.contracts.js';
import { SKILL_NAMES } from '../src/player-character-operations/character-profile.contracts.js';
import { FakeDiscordProvider } from './support/fake-discord-provider.js';
import {
  MockGameGateway,
  TestBridgeClock,
} from './support/mock-game-gateway.js';

const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;
interface Session {
  accessToken: string;
  player: { id: string };
}
describeDatabase(
  'Player character profile and skills with real PostgreSQL',
  () => {
    let admin: DataSource, database: DataSource, app: INestApplication<App>;
    let links: CharacterLinkService, servers: GameServerService;
    let connections: GameConnectionService, dispatcher: GameCommandDispatcher;
    let receiver: GameCommandReceiver, limiter: PlayerAuthRateLimiter;
    let server: GameServer, a: Session, b: Session, staffToken: string;
    let charA: string, charB: string;
    const discord = new FakeDiscordProvider();
    const gateway = new MockGameGateway();
    const clock = new TestBridgeClock();
    const schema = `player_char_ops_test_${randomUUID().replaceAll('-', '')}`;
    const http = () => request(app.getHttpServer());
    const profileOf = (characterId: string) => ({
      characterId,
      name: 'Lydia',
      level: 12,
      race: 'NordRace',
      sex: 'FEMALE',
      health: 150,
      magicka: 80.5,
      stamina: 120,
    });
    const skillsOf = (characterId: string) => ({
      characterId,
      skills: Object.fromEntries(SKILL_NAMES.map((name) => [name, 15])),
    });
    const propertiesOf = (characterId: string) => ({
      characterId,
      properties: [
        { propertyId: 'BreezehomeLocation', displayName: 'Breezehome' },
        { propertyId: 'HoneysideLocation' },
      ],
    });
    const holdsOf = (characterId: string) => ({
      characterId,
      holds: [{ holdId: 'WhiterunHold', displayName: 'Whiterun' }],
    });
    const horsesOf = (characterId: string) => ({
      characterId,
      horses: [
        { horseId: 'ShadowmereRef', displayName: 'Shadowmere' },
        { horseId: '0x0009CCD7' },
      ],
    });
    type Kind = 'profile' | 'skills' | 'properties' | 'holds' | 'horses';
    const KINDS = [
      'profile',
      'skills',
      'properties',
      'holds',
      'horses',
    ] as const;
    const TYPES = {
      profile: 'CHARACTER_PROFILE_QUERY',
      skills: 'CHARACTER_SKILLS_QUERY',
      properties: 'CHARACTER_PROPERTIES_QUERY',
      holds: 'CHARACTER_HOLDS_QUERY',
      horses: 'CHARACTER_HORSES_QUERY',
    } as const;
    const staffCharacter = (
      path: string,
      characterId: string,
      body: object = {},
      token = staffToken,
    ) =>
      http()
        .post(
          `/api/v1/game-servers/${server.id}/characters/${encodeURIComponent(characterId)}/${path}`,
        )
        .auth(token, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send(body);
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
    const verified = async (
      session: Session,
      characterExternalId = `char:${randomUUID()}`,
    ) => {
      const { challenge } = await links.request(
        playerActor(session.player.id),
        { gameServerId: server.id, characterExternalId },
      );
      expect(
        await links.confirmFromAgent({
          challenge,
          gameServerId: server.id,
          characterExternalId,
        }),
      ).toMatchObject({ outcome: 'VERIFIED' });
      return characterExternalId;
    };
    const query = (
      session: Session,
      kind: Kind,
      characterId: string,
      key: string | null = randomUUID(),
      gameServerId = server.id,
    ) => {
      const call = http()
        .post(
          `/api/v1/player/game-servers/${gameServerId}/characters/${encodeURIComponent(characterId)}/${kind}-query`,
        )
        .auth(session.accessToken, { type: 'bearer' });
      return key === null ? call : call.set('Idempotency-Key', key);
    };
    const detail = (session: Session | string, id: string) =>
      http()
        .get(`/api/v1/player/character-operations/${id}`)
        .auth(typeof session === 'string' ? session : session.accessToken, {
          type: 'bearer',
        });
    const command = (id: string) =>
      database
        .getRepository<GameCommand>('GameCommand')
        .findOneByOrFail({ id });
    const commandCount = async () =>
      Number(
        (await database.query('SELECT count(*) FROM game_commands'))[0].count,
      );
    const message = (c: GameCommand, result: unknown): ResultMessage =>
      ({
        protocolVersion: '1',
        serverId: c.gameServerId,
        connectionId: c.dispatchedConnectionId!,
        commandId: c.id,
        correlationId: c.correlationId,
        outcome: S.SUCCEEDED,
        result,
      }) as ResultMessage;
    const dispatched = async (id: string) => {
      await connections.connect({
        gameServerId: server.id,
        externalConnectionId: randomUUID(),
      });
      return dispatcher.dispatch(id);
    };
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
      expect(await database.runMigrations()).toHaveLength(21);
      const { AppModule } = await import('../src/app.module.js');
      const module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(DataSource)
        .useValue(database)
        .overrideProvider(DiscordIdentityProvider)
        .useValue(discord)
        .overrideProvider(GameGateway)
        .useValue(gateway)
        .overrideProvider(BridgeClock)
        .useValue(clock)
        .compile();
      app = module.createNestApplication(new AppExpressAdapter());
      app.useLogger(false);
      setupApp(app);
      await app.listen(0, '127.0.0.1');
      links = app.get(CharacterLinkService);
      servers = app.get(GameServerService);
      connections = app.get(GameConnectionService);
      dispatcher = app.get(GameCommandDispatcher);
      receiver = app.get(GameCommandReceiver);
      limiter = app.get(PlayerAuthRateLimiter);
      a = await login();
      b = await login();
      const password = 'Profile-Staff-Password-42';
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
    }, 30000);
    beforeEach(async () => {
      limiter.reset();
      gateway.sends = [];
      gateway.responses = [];
      gateway.available = true;
      server = await servers.register({ code: randomUUID(), name: 'Profiles' });
      charA = await verified(a);
      charB = await verified(b);
    });
    afterAll(async () => {
      await app?.close();
      if (database?.isInitialized) await database.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.destroy();
      }
    });

    it('needs no migration: sixteen migrations and no schema diff', async () => {
      expect(await database.showMigrations()).toBe(false);
      expect(await database.query('SELECT * FROM migrations')).toHaveLength(21);
      expect(
        (await database.driver.createSchemaBuilder().log()).upQueries,
      ).toEqual([]);
    });
    it.each([
      ['profile', 'CHARACTER_PROFILE_QUERY'],
      ['skills', 'CHARACTER_SKILLS_QUERY'],
      ['properties', 'CHARACTER_PROPERTIES_QUERY'],
      ['holds', 'CHARACTER_HOLDS_QUERY'],
      ['horses', 'CHARACTER_HORSES_QUERY'],
    ] as const)(
      'accepts a %s query as a PLAYER-scoped command without Audit or dispatch',
      async (kind, type) => {
        const key = `key-${randomUUID()}`;
        const response = await query(a, kind, ` ${charA} `, key).expect(202);
        expect(response.body).toEqual({
          operationId: expect.any(String),
          type,
          gameServerId: server.id,
          characterId: charA,
          status: 'PENDING',
          createdAt: expect.any(String),
        });
        expect(response.headers.location).toBe(
          `/api/v1/player/character-operations/${response.body.operationId}`,
        );
        expect(response.text).not.toContain(key);
        expect(await command(response.body.operationId)).toMatchObject({
          type,
          payload: { characterId: charA },
          actorType: 'PLAYER',
          requestedByPlayerId: a.player.id,
          requestedByStaffId: null,
          requestedBySystemSource: null,
          idempotencyScope: `PLAYER:${a.player.id}`,
          idempotencyKey: key,
        });
        expect(
          await database.query(
            'SELECT id FROM audit_logs WHERE resource_id = $1',
            [response.body.operationId],
          ),
        ).toEqual([]);
        expect(gateway.sends).toHaveLength(0);
      },
    );
    it('requires VERIFIED ownership by the authenticated player and returns a generic 404', async () => {
      const before = await commandCount();
      const pending = `char:${randomUUID()}`;
      await links.request(playerActor(a.player.id), {
        gameServerId: server.id,
        characterExternalId: pending,
      });
      const revoked = await verified(a);
      const [link] = await database.query(
        'SELECT id FROM player_characters WHERE character_external_id = $1',
        [revoked],
      );
      await http()
        .post(`/api/v1/player/character-links/${link.id}/revoke`)
        .auth(a.accessToken, { type: 'bearer' })
        .expect(200);
      for (const [session, characterId] of [
        [a, pending],
        [a, revoked],
        [a, `char:${randomUUID()}`],
        [a, charB],
        [b, charA],
      ] as const)
        for (const kind of KINDS) {
          const response = await query(session, kind, characterId).expect(404);
          expect(response.body.message).toBe('Character not available');
        }
      const other = await servers.register({
        code: randomUUID(),
        name: 'Other',
      });
      await query(a, 'profile', charA, randomUUID(), other.id).expect(404);
      await query(a, 'profile', charA, randomUUID(), randomUUID()).expect(404);
      await query(a, 'profile', charA, randomUUID(), 'invalid').expect(400);
      await database.query(
        'UPDATE game_servers SET enabled = false WHERE id = $1',
        [server.id],
      );
      try {
        for (const kind of KINDS) await query(a, kind, charA).expect(409);
      } finally {
        await database.query(
          'UPDATE game_servers SET enabled = true WHERE id = $1',
          [server.id],
        );
      }
      expect(await commandCount()).toBe(before);
    });
    it('rejects staff tokens, player selection, missing keys and non-empty bodies', async () => {
      const before = await commandCount();
      await http()
        .post(
          `/api/v1/player/game-servers/${server.id}/characters/${charA}/profile-query`,
        )
        .auth(staffToken, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .expect(401);
      await http()
        .post(
          `/api/v1/player/game-servers/${server.id}/characters/${charA}/profile-query`,
        )
        .set('Idempotency-Key', randomUUID())
        .expect(401);
      for (const body of [
        { playerId: b.player.id },
        { requestedByPlayerId: b.player.id },
        { characterId: charB },
        { actorType: 'SYSTEM' },
      ])
        for (const kind of KINDS)
          await query(a, kind, charA).send(body).expect(400);
      for (const body of [
        { characterLinkId: randomUUID() },
        { permission: 'CHARACTER_PROPERTY_WRITE' },
        { type: 'CHARACTER_PROPERTY_GRANT' },
        { propertyId: 'BreezehomeLocation' },
        { holdId: 'WhiterunHold' },
        { horseId: 'ShadowmereRef' },
        { type: 'CHARACTER_HORSE_GIVE' },
        { permission: 'CHARACTER_HORSE_GIVE' },
      ])
        for (const kind of ['properties', 'holds', 'horses'] as const)
          await query(a, kind, charA).send(body).expect(400);
      for (const kind of ['properties', 'holds', 'horses'] as const)
        await http()
          .post(
            `/api/v1/player/game-servers/${server.id}/characters/${charA}/${kind}-query`,
          )
          .auth(staffToken, { type: 'bearer' })
          .set('Idempotency-Key', randomUUID())
          .expect(401);
      await query(a, 'properties', charA, null).expect(400);
      await query(a, 'holds', charA, null).expect(400);
      await query(a, 'horses', charA, null).expect(400);
      await query(a, 'skills', charA, null).expect(400);
      for (const key of ['', 'a b', 'x'.repeat(129)])
        await query(a, 'skills', charA, key).expect(400);
      expect(await commandCount()).toBe(before);
    });
    it('isolates idempotency per player and converges concurrent retries', async () => {
      const key = randomUUID();
      const first = (await query(a, 'profile', charA, key).expect(202)).body;
      expect((await query(a, 'profile', charA, key).expect(202)).body).toEqual(
        first,
      );
      await query(a, 'skills', charA, key).expect(409);
      const other = await verified(a);
      await query(a, 'profile', other, key).expect(409);
      const fromB = (await query(b, 'profile', charB, key).expect(202)).body;
      expect(fromB.operationId).not.toBe(first.operationId);
      const race = randomUUID();
      const responses = await Promise.all(
        Array.from({ length: 8 }, () => query(a, 'skills', charA, race)),
      );
      expect(responses.map((r) => r.status)).toEqual(Array(8).fill(202));
      expect(new Set(responses.map((r) => r.body.operationId)).size).toBe(1);
      expect(
        await database.query(
          'SELECT count(*)::int AS n FROM game_commands WHERE idempotency_key = $1',
          [race],
        ),
      ).toEqual([{ n: 1 }]);
    });
    it('reports PENDING, DISPATCHED and validated SUCCEEDED results through the player detail', async () => {
      for (const [kind, result] of [
        ['profile', profileOf(charA)],
        ['skills', skillsOf(charA)],
      ] as const) {
        const { operationId } = (await query(a, kind, charA).expect(202)).body;
        expect((await detail(a, operationId).expect(200)).body).toMatchObject({
          status: 'PENDING',
          completedAt: null,
          result: null,
        });
        const sent = await dispatched(operationId);
        expect(sent.status).toBe(S.DISPATCHED);
        expect((await detail(a, operationId).expect(200)).body.status).toBe(
          'DISPATCHED',
        );
        await receiver.result(message(sent, result));
        const done = await detail(a, operationId).expect(200);
        expect(done.headers['cache-control']).toBe('no-store');
        expect(done.body).toEqual({
          operationId,
          type:
            kind === 'profile'
              ? 'CHARACTER_PROFILE_QUERY'
              : 'CHARACTER_SKILLS_QUERY',
          gameServerId: server.id,
          characterId: charA,
          status: 'SUCCEEDED',
          createdAt: expect.any(String),
          completedAt: expect.any(String),
          result: {
            outcome: 'SUCCEEDED',
            data: result,
            errorCode: null,
            receivedAt: expect.any(String),
          },
        });
      }
    });
    it('reports FAILED and TIMEOUT without data', async () => {
      const failed = (await query(a, 'profile', charA).expect(202)).body
        .operationId;
      const sent = await dispatched(failed);
      await receiver.result({
        ...message(sent, null),
        outcome: S.FAILED,
        errorCode: 'BRIDGE_ERROR',
      } as ResultMessage);
      expect((await detail(a, failed).expect(200)).body).toMatchObject({
        status: 'FAILED',
        result: { outcome: 'FAILED', data: null, errorCode: 'BRIDGE_ERROR' },
      });
      const late = (await query(a, 'skills', charA).expect(202)).body
        .operationId;
      await dispatched(late);
      clock.advance(86400000);
      await receiver.expireCommands();
      expect((await detail(a, late).expect(200)).body).toMatchObject({
        status: 'TIMEOUT',
        result: { outcome: 'TIMEOUT', data: null },
      });
    });
    it('rejects invalid Skyrim results without completing the command', async () => {
      const levels = skillsOf(charA).skills;
      for (const [kind, invalid] of [
        ['profile', { ...profileOf(charA), gold: 5 }],
        ['profile', { ...profileOf(charA), characterId: charB }],
        ['profile', { ...profileOf(charA), level: 0 }],
        ['profile', { ...profileOf(charA), health: -5 }],
        ['profile', { ...profileOf(charA), sex: 'UNKNOWN' }],
        [
          'skills',
          { characterId: charA, skills: { ...levels, necromancy: 10 } },
        ],
        [
          'skills',
          { characterId: charA, skills: { ...levels, smithing: 101 } },
        ],
        ['skills', { characterId: charA, skills: { ...levels, sneak: 2.5 } }],
        ['skills', { characterId: charA, skills: { alchemy: 10 } }],
        ['skills', { ...skillsOf(charB) }],
        [
          'skills',
          { characterId: charA, skills: levels, extra: 'x'.repeat(70000) },
        ],
      ] as const) {
        const { operationId } = (await query(a, kind, charA).expect(202)).body;
        const sent = await dispatched(operationId);
        await expect(receiver.result(message(sent, invalid))).rejects.toThrow();
        expect((await command(operationId)).status).toBe(S.DISPATCHED);
        expect(
          (await detail(a, operationId).expect(200)).body.result,
        ).toBeNull();
      }
    });
    it('shows operations only to their player and never exposes command internals', async () => {
      const { operationId } = (await query(a, 'skills', charA).expect(202))
        .body;
      const sent = await dispatched(operationId);
      await receiver.result(message(sent, skillsOf(charA)));
      await detail(b, operationId).expect(404);
      await detail(staffToken, operationId).expect(401);
      await detail(a, randomUUID()).expect(404);
      await detail(a, 'invalid').expect(400);
      const stored = await command(operationId);
      const text = (await detail(a, operationId).expect(200)).text;
      for (const secret of [
        stored.idempotencyKey,
        stored.idempotencyScope,
        stored.correlationId,
        a.player.id,
        stored.dispatchedConnectionId!,
      ])
        expect(text).not.toContain(secret);
      expect(text).not.toMatch(
        /requestedBy|idempotency|scope|lease|dispatchAttempts|deadline|correlation|payload|actorType/i,
      );
      // Commands from other domains or actors are invisible to the player API.
      const staffCommand = await http()
        .post(`/api/v1/game-servers/${server.id}/world/time`)
        .auth(staffToken, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({ gameHour: 3 })
        .expect(202);
      await detail(a, staffCommand.body.commandId).expect(404);
      // Admin views stay redacted and do not treat these as staff Character operations.
      const generic = await http()
        .get(`/api/v1/game-commands/${operationId}`)
        .auth(staffToken, { type: 'bearer' })
        .expect(200);
      expect(generic.body).not.toHaveProperty('payload');
      expect(generic.text).not.toMatch(/idempotency|scope|PLAYER:|heavyArmor/i);
      expect(generic.text).not.toContain(a.player.id);
      await http()
        .get(`/api/v1/character-operations/${operationId}`)
        .auth(staffToken, { type: 'bearer' })
        .expect(404);
    });
    it('isolates properties and holds idempotency per player and per content', async () => {
      const key = randomUUID();
      const first = (await query(a, 'properties', charA, key).expect(202)).body;
      expect(
        (await query(a, 'properties', ` ${charA} `, key).expect(202)).body,
      ).toEqual(first);
      await query(a, 'holds', charA, key).expect(409);
      await query(a, 'properties', await verified(a), key).expect(409);
      const fromB = (await query(b, 'properties', charB, key).expect(202)).body;
      expect(fromB.operationId).not.toBe(first.operationId);
      const race = randomUUID();
      const responses = await Promise.all(
        Array.from({ length: 8 }, () => query(a, 'holds', charA, race)),
      );
      expect(responses.map((r) => r.status)).toEqual(Array(8).fill(202));
      expect(new Set(responses.map((r) => r.body.operationId)).size).toBe(1);
      expect(
        await database.query(
          'SELECT count(*)::int AS n, min(idempotency_scope) AS scope FROM game_commands WHERE idempotency_key = $1',
          [race],
        ),
      ).toEqual([{ n: 1, scope: `PLAYER:${a.player.id}` }]);
    });
    it('reports properties (houses) and holds through PENDING, DISPATCHED and validated SUCCEEDED', async () => {
      for (const [kind, result] of [
        ['properties', propertiesOf(charA)],
        ['holds', holdsOf(charA)],
        ['properties', { characterId: charA, properties: [] }],
      ] as const) {
        const { operationId } = (await query(a, kind, charA).expect(202)).body;
        expect((await detail(a, operationId).expect(200)).body).toMatchObject({
          type: TYPES[kind],
          status: 'PENDING',
          result: null,
        });
        const sent = await dispatched(operationId);
        expect(gateway.sends.at(-1)).toMatchObject({
          envelope: {
            commandId: operationId,
            type: TYPES[kind],
            payload: { characterId: charA },
          },
        });
        expect((await detail(a, operationId).expect(200)).body.status).toBe(
          'DISPATCHED',
        );
        await receiver.result(message(sent, result));
        expect((await detail(a, operationId).expect(200)).body).toEqual({
          operationId,
          type: TYPES[kind],
          gameServerId: server.id,
          characterId: charA,
          status: 'SUCCEEDED',
          createdAt: expect.any(String),
          completedAt: expect.any(String),
          result: {
            outcome: 'SUCCEEDED',
            data: result,
            errorCode: null,
            receivedAt: expect.any(String),
          },
        });
      }
    });
    it('reports FAILED and TIMEOUT for properties and holds without data', async () => {
      const failed = (await query(a, 'properties', charA).expect(202)).body
        .operationId;
      const sent = await dispatched(failed);
      await receiver.result({
        ...message(sent, null),
        outcome: S.FAILED,
        errorCode: 'BRIDGE_ERROR',
      } as ResultMessage);
      expect((await detail(a, failed).expect(200)).body).toMatchObject({
        type: 'CHARACTER_PROPERTIES_QUERY',
        status: 'FAILED',
        result: { outcome: 'FAILED', data: null, errorCode: 'BRIDGE_ERROR' },
      });
      const late = (await query(a, 'holds', charA).expect(202)).body
        .operationId;
      await dispatched(late);
      clock.advance(86400000);
      await receiver.expireCommands();
      expect((await detail(a, late).expect(200)).body).toMatchObject({
        type: 'CHARACTER_HOLDS_QUERY',
        status: 'TIMEOUT',
        result: { outcome: 'TIMEOUT', data: null },
      });
    });
    it('rejects invalid properties and holds results without completing the command', async () => {
      for (const [kind, invalid] of [
        ['properties', { ...propertiesOf(charA), characterId: charB }],
        ['properties', { ...propertiesOf(charA), owner: a.player.id }],
        [
          'properties',
          { characterId: charA, properties: [{ propertyId: 'x', price: 1 }] },
        ],
        [
          'properties',
          { characterId: charA, properties: [{ propertyId: '' }] },
        ],
        [
          'properties',
          {
            characterId: charA,
            properties: Array.from({ length: 513 }, (_, i) => ({
              propertyId: `p${i}`,
            })),
          },
        ],
        ['holds', { ...holdsOf(charA), characterId: charB }],
        ['holds', { characterId: charA, holds: 'Whiterun' }],
        ['holds', propertiesOf(charA)],
        ['holds', { characterId: charA, holds: [{ holdId: 'a\u0000b' }] }],
      ] as const) {
        const { operationId } = (await query(a, kind, charA).expect(202)).body;
        const sent = await dispatched(operationId);
        await expect(receiver.result(message(sent, invalid))).rejects.toThrow();
        expect((await command(operationId)).status).toBe(S.DISPATCHED);
        expect(
          (await detail(a, operationId).expect(200)).body.result,
        ).toBeNull();
      }
    });
    it('keeps property and hold mutations staff-only and separates player and staff operations', async () => {
      const before = await commandCount();
      // No player route mutates properties or holds.
      for (const path of [
        'properties-grant',
        'properties-revoke',
        'holds-grant',
        'holds-revoke',
        'properties/grant',
        'holds/revoke',
      ])
        await http()
          .post(
            `/api/v1/player/game-servers/${server.id}/characters/${charA}/${path}`,
          )
          .auth(a.accessToken, { type: 'bearer' })
          .set('Idempotency-Key', randomUUID())
          .send({ propertyId: 'BreezehomeLocation' })
          .expect(404);
      // Player tokens never reach the staff Character Management routes.
      for (const [path, body] of [
        ['properties/grant', { propertyId: 'BreezehomeLocation' }],
        ['properties/revoke', { propertyId: 'BreezehomeLocation' }],
        ['holds/grant', { holdId: 'WhiterunHold' }],
        ['holds/revoke', { holdId: 'WhiterunHold' }],
        ['properties/query', {}],
        ['holds/query', {}],
      ] as const)
        await staffCharacter(path, charA, body, a.accessToken).expect(401);
      expect(await commandCount()).toBe(before);
      const { body: docs } = await http().get('/docs-json').expect(200);
      expect(
        Object.keys(docs.paths).filter(
          (p) =>
            p.startsWith('/api/v1/player/game-servers/') &&
            /grant|revoke|give|add|remove/.test(p),
        ),
      ).toEqual([]);
      // Staff APIs keep working, with Audit only for staff mutations.
      const grant = (
        await staffCharacter('properties/grant', charA, {
          propertyId: 'BreezehomeLocation',
        }).expect(202)
      ).body;
      const staffQuery = (
        await staffCharacter('properties/query', charA).expect(202)
      ).body;
      const staffHolds = (
        await staffCharacter('holds/query', charA).expect(202)
      ).body;
      for (const id of [
        grant.commandId,
        staffQuery.commandId,
        staffHolds.commandId,
      ]) {
        await http()
          .get(`/api/v1/character-operations/${id}`)
          .auth(staffToken, { type: 'bearer' })
          .expect(200);
        // Staff commands of the same types are invisible to the player API.
        await detail(a, id).expect(404);
      }
      expect(
        (
          await database.query(
            'SELECT action FROM audit_logs WHERE resource_id = $1',
            [charA],
          )
        ).map((r: { action: string }) => r.action),
      ).toEqual(['CHARACTER_PROPERTY_GRANT_REQUESTED']);
      // A player's query is not a staff Character operation; the generic
      // admin view stays redacted.
      const own = (await query(a, 'properties', charA).expect(202)).body;
      const sent = await dispatched(own.operationId);
      await receiver.result(message(sent, propertiesOf(charA)));
      await http()
        .get(`/api/v1/character-operations/${own.operationId}`)
        .auth(staffToken, { type: 'bearer' })
        .expect(404);
      const generic = await http()
        .get(`/api/v1/game-commands/${own.operationId}`)
        .auth(staffToken, { type: 'bearer' })
        .expect(200);
      expect(generic.body).toMatchObject({
        type: 'CHARACTER_PROPERTIES_QUERY',
        status: 'SUCCEEDED',
      });
      expect(generic.body).not.toHaveProperty('payload');
      expect(generic.text).not.toMatch(
        /idempotency|scope|PLAYER:|Breezehome|Honeyside|propertyId|"properties"/i,
      );
      expect(generic.text).not.toContain(a.player.id);
      // Player detail never shows operational internals.
      const stored = await command(own.operationId);
      const text = (await detail(a, own.operationId).expect(200)).text;
      for (const secret of [
        stored.idempotencyKey,
        stored.idempotencyScope,
        stored.correlationId,
        a.player.id,
        stored.dispatchedConnectionId!,
      ])
        expect(text).not.toContain(secret);
      expect(text).not.toMatch(
        /requestedBy|idempotency|scope|lease|dispatchAttempts|deadline|correlation|payload|actorType/i,
      );
      await detail(b, own.operationId).expect(404);
      expect(
        await database.query(
          'SELECT id FROM audit_logs WHERE resource_id = $1',
          [own.operationId],
        ),
      ).toEqual([]);
    });
    it('isolates horses idempotency per player and per content', async () => {
      const key = randomUUID();
      const first = (await query(a, 'horses', charA, key).expect(202)).body;
      expect(
        (await query(a, 'horses', ` ${charA} `, key).expect(202)).body,
      ).toEqual(first);
      await query(a, 'properties', charA, key).expect(409);
      await query(a, 'horses', await verified(a), key).expect(409);
      const fromB = (await query(b, 'horses', charB, key).expect(202)).body;
      expect(fromB.operationId).not.toBe(first.operationId);
      const race = randomUUID();
      const responses = await Promise.all(
        Array.from({ length: 8 }, () => query(a, 'horses', charA, race)),
      );
      expect(responses.map((r) => r.status)).toEqual(Array(8).fill(202));
      expect(new Set(responses.map((r) => r.body.operationId)).size).toBe(1);
      expect(
        await database.query(
          'SELECT count(*)::int AS n, min(idempotency_scope) AS scope, min(type) AS type FROM game_commands WHERE idempotency_key = $1',
          [race],
        ),
      ).toEqual([
        {
          n: 1,
          scope: `PLAYER:${a.player.id}`,
          type: 'CHARACTER_HORSES_QUERY',
        },
      ]);
    });
    it('reports horses (mounts) through PENDING, DISPATCHED, SUCCEEDED, FAILED and TIMEOUT', async () => {
      for (const result of [
        horsesOf(charA),
        { characterId: charA, horses: [] },
      ]) {
        const { operationId } = (await query(a, 'horses', charA).expect(202))
          .body;
        expect((await detail(a, operationId).expect(200)).body).toMatchObject({
          type: 'CHARACTER_HORSES_QUERY',
          status: 'PENDING',
          result: null,
        });
        const sent = await dispatched(operationId);
        expect(gateway.sends.at(-1)).toMatchObject({
          envelope: {
            commandId: operationId,
            type: 'CHARACTER_HORSES_QUERY',
            payload: { characterId: charA },
          },
        });
        expect((await detail(a, operationId).expect(200)).body.status).toBe(
          'DISPATCHED',
        );
        await receiver.result(message(sent, result));
        expect((await detail(a, operationId).expect(200)).body).toEqual({
          operationId,
          type: 'CHARACTER_HORSES_QUERY',
          gameServerId: server.id,
          characterId: charA,
          status: 'SUCCEEDED',
          createdAt: expect.any(String),
          completedAt: expect.any(String),
          result: {
            outcome: 'SUCCEEDED',
            data: result,
            errorCode: null,
            receivedAt: expect.any(String),
          },
        });
      }
      const failed = (await query(a, 'horses', charA).expect(202)).body
        .operationId;
      const sent = await dispatched(failed);
      await receiver.result({
        ...message(sent, null),
        outcome: S.FAILED,
        errorCode: 'BRIDGE_ERROR',
      } as ResultMessage);
      expect((await detail(a, failed).expect(200)).body).toMatchObject({
        status: 'FAILED',
        result: { outcome: 'FAILED', data: null, errorCode: 'BRIDGE_ERROR' },
      });
      const late = (await query(a, 'horses', charA).expect(202)).body
        .operationId;
      await dispatched(late);
      clock.advance(86400000);
      await receiver.expireCommands();
      expect((await detail(a, late).expect(200)).body).toMatchObject({
        status: 'TIMEOUT',
        result: { outcome: 'TIMEOUT', data: null },
      });
    });
    it('rejects invalid horses results without completing the command', async () => {
      for (const invalid of [
        { ...horsesOf(charA), characterId: charB },
        { ...horsesOf(charA), mounted: true },
        { characterId: charA, horses: [{ horseId: 'h', health: 100 }] },
        { characterId: charA, horses: [{ horseId: '' }] },
        { characterId: charA, horses: 'Shadowmere' },
        { characterId: charA, mounts: [] },
        {
          characterId: charA,
          horses: Array.from({ length: 513 }, (_, i) => ({ horseId: `h${i}` })),
        },
      ]) {
        const { operationId } = (await query(a, 'horses', charA).expect(202))
          .body;
        const sent = await dispatched(operationId);
        await expect(receiver.result(message(sent, invalid))).rejects.toThrow();
        expect((await command(operationId)).status).toBe(S.DISPATCHED);
        expect(
          (await detail(a, operationId).expect(200)).body.result,
        ).toBeNull();
      }
    });
    it('keeps horse mutations staff-only and player horse queries out of admin details', async () => {
      const before = await commandCount();
      for (const path of [
        'horses-give',
        'horses-revoke',
        'horse-give',
        'horses/give',
        'horses/summon',
        'horses-summon',
      ])
        await http()
          .post(
            `/api/v1/player/game-servers/${server.id}/characters/${charA}/${path}`,
          )
          .auth(a.accessToken, { type: 'bearer' })
          .set('Idempotency-Key', randomUUID())
          .send({ horseId: 'ShadowmereRef' })
          .expect(404);
      for (const [path, body] of [
        ['horses/give', { horseId: 'ShadowmereRef' }],
        ['horses/revoke', { horseId: 'ShadowmereRef' }],
        ['horses/query', {}],
      ] as const)
        await staffCharacter(path, charA, body, a.accessToken).expect(401);
      expect(await commandCount()).toBe(before);
      // Staff keeps querying and giving horses; only the give is audited.
      const give = (
        await staffCharacter('horses/give', charA, {
          horseId: 'ShadowmereRef',
        }).expect(202)
      ).body;
      const staffQuery = (
        await staffCharacter('horses/query', charA).expect(202)
      ).body;
      for (const id of [give.commandId, staffQuery.commandId]) {
        await http()
          .get(`/api/v1/character-operations/${id}`)
          .auth(staffToken, { type: 'bearer' })
          .expect(200);
        await detail(a, id).expect(404);
      }
      expect(
        (
          await database.query(
            'SELECT action FROM audit_logs WHERE resource_id = $1',
            [charA],
          )
        ).map((r: { action: string }) => r.action),
      ).toEqual(['CHARACTER_HORSE_GIVE_REQUESTED']);
      const own = (await query(a, 'horses', charA).expect(202)).body;
      const sent = await dispatched(own.operationId);
      await receiver.result(message(sent, horsesOf(charA)));
      await http()
        .get(`/api/v1/character-operations/${own.operationId}`)
        .auth(staffToken, { type: 'bearer' })
        .expect(404);
      const generic = await http()
        .get(`/api/v1/game-commands/${own.operationId}`)
        .auth(staffToken, { type: 'bearer' })
        .expect(200);
      expect(generic.body).toMatchObject({
        type: 'CHARACTER_HORSES_QUERY',
        status: 'SUCCEEDED',
      });
      expect(generic.body).not.toHaveProperty('payload');
      expect(generic.text).not.toMatch(
        /idempotency|scope|PLAYER:|Shadowmere|horseId|"horses"/i,
      );
      expect(generic.text).not.toContain(a.player.id);
      const stored = await command(own.operationId);
      const text = (await detail(a, own.operationId).expect(200)).text;
      for (const secret of [
        stored.idempotencyKey,
        stored.idempotencyScope,
        stored.correlationId,
        a.player.id,
        stored.dispatchedConnectionId!,
      ])
        expect(text).not.toContain(secret);
      expect(text).not.toMatch(
        /requestedBy|idempotency|scope|lease|dispatchAttempts|deadline|correlation|payload|actorType/i,
      );
      await detail(b, own.operationId).expect(404);
      expect(
        await database.query(
          'SELECT id FROM audit_logs WHERE resource_id = $1',
          [own.operationId],
        ),
      ).toEqual([]);
    });
    it('documents the player query routes with required Idempotency-Key and 202 Location', async () => {
      const { body } = await http().get('/docs-json').expect(200);
      for (const kind of KINDS) {
        const route =
          body.paths[
            `/api/v1/player/game-servers/{gameServerId}/characters/{characterId}/${kind}-query`
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
        expect(route.post.responses['202'].headers).toHaveProperty('Location');
      }
      expect(
        body.paths['/api/v1/player/character-operations/{operationId}'].get,
      ).toBeDefined();
      const detailSchema = JSON.stringify(
        body.components.schemas.PlayerCharacterOperationDto,
      );
      expect(detailSchema).not.toMatch(
        /requestedBy|idempotency|payload|correlation/i,
      );
    });
  },
);
