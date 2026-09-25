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
import { playerActor } from '../src/actors/actor.contracts.js';
import { GameServerService } from '../src/game-bridge/game-server.service.js';
import type { GameServer } from '../src/game-bridge/entities/game-server.entity.js';
import { DiscordIdentityProvider } from '../src/player-auth/discord-identity.provider.js';
import { CharacterLinkService } from '../src/player-characters/character-link.service.js';
import { ProfessionExperienceService } from '../src/professions/profession-experience.service.js';
import { Profession } from '../src/professions/profession.contracts.js';
import { FakeDiscordProvider } from './support/fake-discord-provider.js';

const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;
interface Session {
  accessToken: string;
  player: { id: string };
}
interface Link {
  id: string;
  characterExternalId: string;
  server: GameServer;
}
describeDatabase('Professions with real PostgreSQL', () => {
  let admin: DataSource, database: DataSource, app: INestApplication<App>;
  let links: CharacterLinkService, xp: ProfessionExperienceService;
  let servers: GameServerService, server: GameServer, staffToken: string;
  let a: Session, b: Session;
  const discord = new FakeDiscordProvider();
  const schema = `professions_test_${randomUUID().replaceAll('-', '')}`;
  const http = () => request(app.getHttpServer());
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
  const link = async (
    session: Session,
    state: 'PENDING' | 'VERIFIED' | 'REVOKED' = 'VERIFIED',
    on: GameServer = server,
  ): Promise<Link> => {
    const characterExternalId = `char:${randomUUID()}`;
    const actor = playerActor(session.player.id);
    const requested = await links.request(actor, {
      gameServerId: on.id,
      characterExternalId,
    });
    if (state !== 'PENDING')
      await links.confirmFromAgent({
        challenge: requested.challenge,
        gameServerId: on.id,
        characterExternalId,
      });
    if (state === 'REVOKED') await links.revoke(actor, requested.link.id);
    return { id: requested.link.id, characterExternalId, server: on };
  };
  const path = (id: string) => `/api/v1/player/me/characters/${id}/profession`;
  const select = (session: Session | string, id: string, body: object) =>
    http()
      .post(path(id))
      .auth(typeof session === 'string' ? session : session.accessToken, {
        type: 'bearer',
      })
      .send(body);
  const read = (session: Session, id: string) =>
    http().get(path(id)).auth(session.accessToken, { type: 'bearer' });
  const grant = (
    target: Link,
    amount: number,
    eventId: string = randomUUID(),
  ) =>
    xp.grantFromAgent({
      gameServerId: target.server.id,
      characterExternalId: target.characterExternalId,
      eventId,
      amount,
    });
  const row = async (linkId: string) =>
    (
      await database.query(
        // The profession is keyed by the link's server + character, not the link.
        `SELECT cp.* FROM character_professions cp JOIN player_characters pc
           ON pc.game_server_id = cp.game_server_id AND pc.character_external_id = cp.character_external_id
         WHERE pc.id = $1`,
        [linkId],
      )
    )[0];
  const audits = (action: string, linkId: string) =>
    database.query(
      "SELECT * FROM audit_logs WHERE action = $1 AND metadata->>'characterExternalId' = (SELECT character_external_id FROM player_characters WHERE id = $2) ORDER BY created_at",
      [action, linkId],
    );
  const professional = async (
    session: Session,
    profession = Profession.MINER,
  ) => {
    const target = await link(session);
    await select(session, target.id, { profession }).expect(201);
    return target;
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
    expect(await database.runMigrations()).toHaveLength(25);
    await database.undoLastMigration(); // Etapa 11.4 Agent Domain Events
    await database.undoLastMigration(); // Etapa 11.3 Server Control Transport
    await database.undoLastMigration(); // Etapa 11.1 Game Agent Transport
    await database.undoLastMigration(); // Etapa 10.17 VIP Entitlements
    await database.undoLastMigration(); // Etapa 10.16 Player Settings
    await database.undoLastMigration(); // Etapa 10.15 Player Chat
    await database.undoLastMigration(); // Etapa 10.14 Player Marketplace
    await database.undoLastMigration(); // Etapa 10.13 Player Trades
    await database.undoLastMigration(); // Etapa 10.12 Economy
    await database.undoLastMigration(); // Etapa 10.9 Player Guilds
    await database.undoLastMigration(); // Etapa 10.8 Player Groups
    await database.undoLastMigration();
    expect(await database.runMigrations()).toHaveLength(12);
    expect(await database.runMigrations()).toHaveLength(0);
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
    links = app.get(CharacterLinkService);
    xp = app.get(ProfessionExperienceService);
    servers = app.get(GameServerService);
    server = await servers.register({
      code: randomUUID(),
      name: 'Professions',
    });
    a = await login();
    b = await login();
    const password = 'Profession-Staff-Password-42';
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
  afterAll(async () => {
    await app?.close();
    if (database?.isInitialized) await database.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  it('adds both tables with closed catalog, progression and idempotency constraints', async () => {
    expect(database.options.synchronize).toBe(false);
    expect(await database.showMigrations()).toBe(false);
    expect(await database.query('SELECT * FROM migrations')).toHaveLength(25);
    const diff = await database.driver.createSchemaBuilder().log();
    expect([diff.upQueries, diff.downQueries]).toEqual([[], []]);
    const target = await link(a);
    const insert = (profession: string, experience: number, level: number) =>
      database.query(
        'INSERT INTO character_professions(game_server_id, character_external_id, profession, experience, level) VALUES ($1, $2, $3, $4, $5)',
        [server.id, target.characterExternalId, profession, experience, level],
      );
    for (const [profession, experience, level] of [
      ['WIZARD', 0, 1],
      ['MINER', -1, 1],
      ['MINER', 100, 1],
      ['MINER', 99, 2],
      ['MINER', 0, 0],
      ['MINER', 980100, 101],
      ['MINER', 1_000_000_000_001, 100],
    ] as const)
      await expect(insert(profession, experience, level)).rejects.toMatchObject(
        {
          driverError: { code: '23514' },
        },
      );
    await insert('MINER', 980100, 100);
    await expect(insert('COOK', 0, 1)).rejects.toMatchObject({
      driverError: { code: '23505' },
    });
    const [{ id }] = await database.query(
      'SELECT id FROM character_professions WHERE game_server_id = $1 AND character_external_id = $2',
      [server.id, target.characterExternalId],
    );
    const event = (eventId: string, amount: number, professionId = id) =>
      database.query(
        'INSERT INTO profession_experience_events(character_profession_id, game_server_id, external_event_id, amount) VALUES ($1, $2, $3, $4)',
        [professionId, server.id, eventId, amount],
      );
    for (const amount of [0, 1_000_001])
      await expect(event('e', amount)).rejects.toMatchObject({
        driverError: { code: '23514' },
      });
    await expect(event(' ', 1)).rejects.toMatchObject({
      driverError: { code: '23514' },
    });
    await event('dup', 1);
    await expect(event('dup', 1)).rejects.toMatchObject({
      driverError: { code: '23505' },
    });
    await expect(event('orphan', 1, randomUUID())).rejects.toMatchObject({
      driverError: { code: '23503' },
    });
  });
  it('reports no profession, then selects each of the seven once with PLAYER Audit', async () => {
    for (const profession of Object.values(Profession)) {
      const target = await link(a);
      expect((await read(a, target.id).expect(200)).body).toEqual({
        characterLinkId: target.id,
        profession: null,
      });
      const created = await select(a, target.id, { profession }).expect(201);
      const state = {
        characterLinkId: target.id,
        profession,
        level: 1,
        experience: 0,
        nextLevelExperience: 100,
      };
      expect(created.body).toEqual(state);
      expect((await read(a, target.id).expect(200)).body).toEqual(state);
      const repeated = await select(a, target.id, { profession }).expect(200);
      expect(repeated.body).toEqual(state);
      const entries = await audits('PROFESSION_SELECTED', target.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        actor_type: 'PLAYER',
        actor_player_id: a.player.id,
        actor_role: null,
        resource_type: 'CHARACTER_PROFESSION',
        status_code: 201,
      });
      expect(entries[0].metadata).toEqual({
        playerCharacterId: target.id,
        gameServerId: server.id,
        characterExternalId: target.characterExternalId,
        profession,
        level: 1,
      });
    }
  });
  it('rejects a different profession with 409 PROFESSION_ALREADY_SELECTED and any extra input', async () => {
    const target = await professional(a, Profession.BLACKSMITH);
    const conflict = await select(a, target.id, { profession: 'COOK' }).expect(
      409,
    );
    expect(conflict.body).toMatchObject({
      error: 'PROFESSION_ALREADY_SELECTED',
      message: 'Profession already selected',
    });
    expect((await row(target.id)).profession).toBe('BLACKSMITH');
    const fresh = await link(a);
    for (const body of [
      {},
      { profession: 'WIZARD' },
      { profession: 'blacksmith' },
      { profession: 'MINER', experience: 5000 },
      { profession: 'MINER', level: 50 },
      { profession: 'MINER', playerId: b.player.id },
      { profession: 'MINER', source: 'AGENT' },
    ])
      await select(a, fresh.id, body).expect(400);
    expect(await row(fresh.id)).toBeUndefined();
  });
  it('requires an own VERIFIED link: PENDING, REVOKED, foreign or unknown give a generic 404', async () => {
    const pending = await link(a, 'PENDING');
    const revoked = await link(a, 'REVOKED');
    const foreign = await link(b);
    for (const id of [pending.id, revoked.id, foreign.id, randomUUID()]) {
      expect((await read(a, id).expect(404)).body.message).toBe(
        'Character not found',
      );
      expect(
        (await select(a, id, { profession: 'MINER' }).expect(404)).body.message,
      ).toBe('Character not found');
    }
    await read(a, 'invalid').expect(400);
    const own = await professional(b);
    await read(a, own.id).expect(404);
    await select(staffToken, own.id, { profession: 'MINER' }).expect(401);
    await http().get(path(own.id)).expect(401);
    for (const id of [pending.id, revoked.id])
      expect(await row(id)).toBeUndefined();
  });
  it('lets PostgreSQL decide concurrent selections', async () => {
    const same = await link(a);
    const repeated = await Promise.all(
      Array.from({ length: 8 }, () =>
        select(a, same.id, { profession: 'HUNTER' }),
      ),
    );
    expect(repeated.map((r) => r.status).sort()).toEqual([
      200, 200, 200, 200, 200, 200, 200, 201,
    ]);
    expect(await audits('PROFESSION_SELECTED', same.id)).toHaveLength(1);
    const contested = await link(a);
    const raced = await Promise.all(
      Object.values(Profession).map((profession) =>
        select(a, contested.id, { profession }),
      ),
    );
    expect(raced.filter((r) => r.status === 201)).toHaveLength(1);
    expect(raced.filter((r) => r.status === 409)).toHaveLength(6);
    const winner = raced.find((r) => r.status === 201)!.body.profession;
    expect((await row(contested.id)).profession).toBe(winner);
    expect(
      await database.query(
        'SELECT count(*)::int AS n FROM character_professions WHERE game_server_id = $1 AND character_external_id = $2',
        [server.id, contested.characterExternalId],
      ),
    ).toEqual([{ n: 1 }]);
  });
  it('grants trusted Agent XP idempotently, recalculating level with SYSTEM:AGENT Audit', async () => {
    const target = await professional(a);
    const first = randomUUID();
    expect(await grant(target, 99, first)).toEqual({
      outcome: 'GRANTED',
      progress: {
        gameServerId: server.id,
        characterExternalId: target.characterExternalId,
        profession: 'MINER',
        level: 1,
        experience: 99,
        nextLevelExperience: 100,
      },
    });
    expect(await grant(target, 99, first)).toMatchObject({
      outcome: 'ALREADY_APPLIED',
      progress: { experience: 99, level: 1 },
    });
    expect(await grant(target, 50, first)).toEqual({
      outcome: 'REJECTED',
      reason: 'EVENT_CONFLICT',
    });
    expect(await grant(target, 1)).toMatchObject({
      progress: { experience: 100, level: 2 },
    });
    expect(await grant(target, 299)).toMatchObject({
      progress: { experience: 399, level: 2 },
    });
    expect(await grant(target, 1)).toMatchObject({
      progress: { experience: 400, level: 3, nextLevelExperience: 900 },
    });
    expect((await read(a, target.id).expect(200)).body).toEqual({
      characterLinkId: target.id,
      profession: 'MINER',
      level: 3,
      experience: 400,
      nextLevelExperience: 900,
    });
    const entries = await audits('PROFESSION_EXPERIENCE_GRANTED', target.id);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toMatchObject({
      actor_type: 'SYSTEM',
      actor_system_source: 'AGENT',
      actor_player_id: null,
      actor_staff_id: null,
    });
    expect(entries[0].metadata).toEqual({
      gameServerId: server.id,
      characterExternalId: target.characterExternalId,
      profession: 'MINER',
      amount: 99,
      previousLevel: 1,
      newLevel: 1,
      externalEventId: first,
    });
    expect(entries[1].metadata).toMatchObject({
      previousLevel: 1,
      newLevel: 2,
    });
    // Event ids are scoped per game server.
    const other = await servers.register({ code: randomUUID(), name: 'Other' });
    const elsewhere = await link(a, 'VERIFIED', other);
    await select(a, elsewhere.id, { profession: 'COOK' }).expect(201);
    expect(await grant(elsewhere, 10, first)).toMatchObject({
      outcome: 'GRANTED',
    });
  });
  it('caps the level at 100 while XP keeps accumulating up to the safe ceiling', async () => {
    const target = await professional(a);
    expect(await grant(target, 980099)).toMatchObject({
      progress: { level: 99, experience: 980099 },
    });
    expect(await grant(target, 1)).toMatchObject({
      progress: { level: 100, experience: 980100, nextLevelExperience: null },
    });
    expect(await grant(target, 1_000_000)).toMatchObject({
      progress: {
        level: 100,
        experience: 1_980_100,
        nextLevelExperience: null,
      },
    });
    await database.query(
      'UPDATE character_professions SET experience = 999999999990 WHERE game_server_id = $1 AND character_external_id = $2',
      [server.id, target.characterExternalId],
    );
    expect(await grant(target, 1000)).toMatchObject({
      outcome: 'GRANTED',
      progress: { level: 100, experience: 1_000_000_000_000 },
    });
    expect((await read(a, target.id).expect(200)).body.experience).toBe(
      1_000_000_000_000,
    );
  });
  it('applies concurrent replays once and concurrent distinct events without lost updates', async () => {
    const target = await professional(a);
    const eventId = randomUUID();
    const replays = await Promise.all(
      Array.from({ length: 8 }, () => grant(target, 250, eventId)),
    );
    expect(replays.filter((r) => r.outcome === 'GRANTED')).toHaveLength(1);
    expect(replays.filter((r) => r.outcome === 'ALREADY_APPLIED')).toHaveLength(
      7,
    );
    expect(Number((await row(target.id)).experience)).toBe(250);
    const distinct = await Promise.all(
      Array.from({ length: 10 }, () => grant(target, 100)),
    );
    expect(distinct.every((r) => r.outcome === 'GRANTED')).toBe(true);
    const stored = await row(target.id);
    expect(Number(stored.experience)).toBe(1250);
    expect(stored.level).toBe(4);
    expect(
      await audits('PROFESSION_EXPERIENCE_GRANTED', target.id),
    ).toHaveLength(11);
    expect(
      await database.query(
        'SELECT count(*)::int AS n FROM profession_experience_events WHERE character_profession_id = $1',
        [stored.id],
      ),
    ).toEqual([{ n: 11 }]);
  });
  it('rejects grants for invalid input, unowned characters, missing professions and blocked accounts', async () => {
    const target = await professional(a);
    const events = async () =>
      Number(
        (
          await database.query(
            'SELECT count(*) FROM profession_experience_events',
          )
        )[0].count,
      );
    const before = await events();
    for (const amount of [0, -5, 1.5, 1_000_001, Number.NaN])
      expect(await grant(target, amount)).toEqual({
        outcome: 'REJECTED',
        reason: 'INVALID_INPUT',
      });
    for (const input of [
      { eventId: '' },
      { eventId: 'x'.repeat(129) },
      { gameServerId: 'invalid' },
      { characterExternalId: '' },
    ])
      expect(
        await xp.grantFromAgent({
          gameServerId: server.id,
          characterExternalId: target.characterExternalId,
          eventId: randomUUID(),
          amount: 10,
          ...input,
        }),
      ).toEqual({ outcome: 'REJECTED', reason: 'INVALID_INPUT' });
    const pending = await link(a, 'PENDING');
    const revoked = await link(a, 'REVOKED');
    for (const unowned of [
      pending,
      revoked,
      { ...target, characterExternalId: 'char:unknown' },
    ])
      expect(await grant(unowned, 10)).toEqual({
        outcome: 'REJECTED',
        // Pending/revoked links here never selected a profession.
        reason: 'PROFESSION_NOT_SELECTED',
      });
    expect(await grant(await link(a), 10)).toEqual({
      outcome: 'REJECTED',
      reason: 'PROFESSION_NOT_SELECTED',
    });
    for (const status of ['SUSPENDED', 'BANNED']) {
      await database.query('UPDATE players SET status = $1 WHERE id = $2', [
        status,
        a.player.id,
      ]);
      try {
        expect(await grant(target, 10)).toEqual({
          outcome: 'REJECTED',
          reason: 'PLAYER_UNAVAILABLE',
        });
      } finally {
        await database.query(
          "UPDATE players SET status = 'ACTIVE' WHERE id = $1",
          [a.player.id],
        );
      }
    }
    expect(await events()).toBe(before);
    expect(Number((await row(target.id)).experience)).toBe(0);
    expect(await grant(target, 10)).toMatchObject({ outcome: 'GRANTED' });
  });
  it('keeps profession, XP and level with the character when ownership moves to another player', async () => {
    // 1–3: A owns character X, selects BLACKSMITH and levels up.
    const x = await professional(a, Profession.BLACKSMITH);
    expect(await grant(x, 500)).toMatchObject({
      outcome: 'GRANTED',
      progress: { profession: 'BLACKSMITH', level: 3, experience: 500 },
    });
    // 4: A's ownership is revoked; A loses access.
    await http()
      .post(`/api/v1/player/character-links/${x.id}/revoke`)
      .auth(a.accessToken, { type: 'bearer' })
      .expect(200);
    await read(a, x.id).expect(404);
    await select(a, x.id, { profession: 'BLACKSMITH' }).expect(404);
    // Progress belongs to the character, so the Agent can still grant it.
    expect(await grant(x, 100)).toMatchObject({
      outcome: 'GRANTED',
      progress: { experience: 600, level: 3 },
    });
    // 5: B verifies ownership of the same character (internal test setup).
    const requested = await links.request(playerActor(b.player.id), {
      gameServerId: server.id,
      characterExternalId: x.characterExternalId,
    });
    expect(
      await links.confirmFromAgent({
        challenge: requested.challenge,
        gameServerId: server.id,
        characterExternalId: x.characterExternalId,
      }),
    ).toMatchObject({ outcome: 'VERIFIED' });
    // 6–7: B sees the same BLACKSMITH, XP and level through its own link.
    const inherited = {
      characterLinkId: requested.link.id,
      profession: 'BLACKSMITH',
      level: 3,
      experience: 600,
      nextLevelExperience: 900,
    };
    expect((await read(b, requested.link.id).expect(200)).body).toEqual(
      inherited,
    );
    expect(
      (
        await select(b, requested.link.id, { profession: 'BLACKSMITH' }).expect(
          200,
        )
      ).body,
    ).toEqual(inherited);
    await select(b, requested.link.id, { profession: 'COOK' }).expect(409);
    await read(a, requested.link.id).expect(404);
    expect(await grant(x, 300)).toMatchObject({
      progress: { experience: 900, level: 4 },
    });
    expect((await read(b, requested.link.id).expect(200)).body).toMatchObject({
      level: 4,
      experience: 900,
    });
    // Still exactly one profession row, guaranteed by UNIQUE(server, character).
    expect(
      await database.query(
        'SELECT count(*)::int AS n FROM character_professions WHERE game_server_id = $1 AND character_external_id = $2',
        [server.id, x.characterExternalId],
      ),
    ).toEqual([{ n: 1 }]);
    await expect(
      database.query(
        "INSERT INTO character_professions(game_server_id, character_external_id, profession) VALUES ($1, $2, 'COOK')",
        [server.id, x.characterExternalId],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23505' } });
    expect(await audits('PROFESSION_SELECTED', x.id)).toHaveLength(1);
  });
  it('offers players no XP route, creates no GameCommand and leaks no identity data', async () => {
    const target = await professional(a);
    for (const suffix of ['experience', 'xp', 'grant'])
      await http()
        .post(`${path(target.id)}/${suffix}`)
        .auth(a.accessToken, { type: 'bearer' })
        .send({ amount: 1000, eventId: 'x' })
        .expect(404);
    await http()
      .put(path(target.id))
      .auth(a.accessToken, { type: 'bearer' })
      .send({ profession: 'COOK' })
      .expect(404);
    await http()
      .delete(path(target.id))
      .auth(a.accessToken, { type: 'bearer' })
      .expect(404);
    const { body } = await http().get('/docs-json').expect(200);
    expect(Object.keys(body.paths).filter((p) => /profession/.test(p))).toEqual(
      ['/api/v1/player/me/characters/{characterLinkId}/profession'],
    );
    expect(
      Object.keys(body.components.schemas.SelectProfessionDto.properties),
    ).toEqual(['profession']);
    const text = (await read(a, target.id).expect(200)).text;
    expect(text).not.toContain(a.player.id);
    expect(text).not.toContain(target.characterExternalId);
    expect(
      Number(
        (await database.query('SELECT count(*) FROM game_commands'))[0].count,
      ),
    ).toBe(0);
  });
  it('reverts only the profession tables and reapplies cleanly', async () => {
    await database.undoLastMigration(); // Etapa 11.4 Agent Domain Events
    await database.undoLastMigration(); // Etapa 11.3 Server Control Transport
    await database.undoLastMigration(); // Etapa 11.1 Game Agent Transport
    await database.undoLastMigration(); // Etapa 10.17 VIP Entitlements
    await database.undoLastMigration(); // Etapa 10.16 Player Settings
    await database.undoLastMigration(); // Etapa 10.15 Player Chat
    await database.undoLastMigration(); // Etapa 10.14 Player Marketplace
    await database.undoLastMigration(); // Etapa 10.13 Player Trades
    await database.undoLastMigration(); // Etapa 10.12 Economy
    await database.undoLastMigration(); // Etapa 10.9 Player Guilds
    await database.undoLastMigration(); // Etapa 10.8 Player Groups
    await database.undoLastMigration();
    expect(
      await database.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename IN ('character_professions', 'profession_experience_events')",
        [schema],
      ),
    ).toEqual([]);
    expect(await database.runMigrations()).toHaveLength(12);
    expect(await database.runMigrations()).toHaveLength(0);
    expect(
      (await database.driver.createSchemaBuilder().log()).upQueries,
    ).toEqual([]);
  });
});
