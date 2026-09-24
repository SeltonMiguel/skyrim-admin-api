import { NotFoundException } from '@nestjs/common';
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
import { GameGateway } from '../src/game-bridge/game-gateway.js';
import { GameServerService } from '../src/game-bridge/game-server.service.js';
import type { GameServer } from '../src/game-bridge/entities/game-server.entity.js';
import { DiscordIdentityProvider } from '../src/player-auth/discord-identity.provider.js';
import { PlayerAuthRateLimiter } from '../src/player-auth/player-auth-rate-limit.js';
import { CharacterLinkService } from '../src/player-characters/character-link.service.js';
import { CharacterOwnershipService } from '../src/player-characters/character-ownership.service.js';
import { FakeDiscordProvider } from './support/fake-discord-provider.js';
import { MockGameGateway } from './support/mock-game-gateway.js';

const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;
interface Session {
  accessToken: string;
  player: { id: string };
}
describeDatabase('Player characters directory with real PostgreSQL', () => {
  let admin: DataSource, database: DataSource, app: INestApplication<App>;
  let links: CharacterLinkService, ownership: CharacterOwnershipService;
  let servers: GameServerService, limiter: PlayerAuthRateLimiter;
  let alpha: GameServer, beta: GameServer, staffToken: string;
  const discord = new FakeDiscordProvider();
  const gateway = new MockGameGateway();
  const schema = `player_me_chars_test_${randomUUID().replaceAll('-', '')}`;
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
  // Creates a link in the requested state and pins created_at for ordering.
  const link = async (
    session: Session,
    server: GameServer,
    state: 'PENDING' | 'VERIFIED' | 'REVOKED',
    createdAt: string,
  ) => {
    const characterExternalId = `char:${randomUUID()}`;
    const actor = playerActor(session.player.id);
    const requested = await links.request(actor, {
      gameServerId: server.id,
      characterExternalId,
    });
    if (state !== 'PENDING')
      await links.confirmFromAgent({
        challenge: requested.challenge,
        gameServerId: server.id,
        characterExternalId,
      });
    if (state === 'REVOKED') await links.revoke(actor, requested.link.id);
    await database.query(
      'UPDATE player_characters SET created_at = $1 WHERE id = $2',
      [createdAt, requested.link.id],
    );
    return { id: requested.link.id, characterExternalId, server };
  };
  const list = (
    session: Session | string,
    query: Record<string, unknown> = {},
  ) =>
    http()
      .get('/api/v1/player/me/characters')
      .query(query)
      .auth(typeof session === 'string' ? session : session.accessToken, {
        type: 'bearer',
      });
  const detail = (session: Session, id: string) =>
    http()
      .get(`/api/v1/player/me/characters/${id}`)
      .auth(session.accessToken, { type: 'bearer' });
  const commandCount = async () =>
    Number(
      (await database.query('SELECT count(*) FROM game_commands'))[0].count,
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
    expect(await database.runMigrations()).toHaveLength(19);
    const { AppModule } = await import('../src/app.module.js');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DataSource)
      .useValue(database)
      .overrideProvider(DiscordIdentityProvider)
      .useValue(discord)
      .overrideProvider(GameGateway)
      .useValue(gateway)
      .compile();
    app = module.createNestApplication(new AppExpressAdapter());
    app.useLogger(false);
    setupApp(app);
    await app.listen(0, '127.0.0.1');
    links = app.get(CharacterLinkService);
    ownership = app.get(CharacterOwnershipService);
    servers = app.get(GameServerService);
    limiter = app.get(PlayerAuthRateLimiter);
    alpha = await servers.register({
      code: `alpha-${randomUUID()}`,
      name: 'Alpha',
    });
    beta = await servers.register({
      code: `beta-${randomUUID()}`,
      name: 'Beta',
    });
    const password = 'Directory-Staff-Password-42';
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
  beforeEach(() => limiter.reset());
  afterAll(async () => {
    await app?.close();
    if (database?.isInitialized) await database.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  it('needs no migration and returns an empty page for a player without characters', async () => {
    expect(await database.query('SELECT * FROM migrations')).toHaveLength(19);
    expect(await database.showMigrations()).toBe(false);
    expect(database.options.synchronize).toBe(false);
    const diff = await database.driver.createSchemaBuilder().log();
    expect([diff.upQueries, diff.downQueries]).toEqual([[], []]);
    const fresh = await login();
    const response = await list(fresh).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      items: [],
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 0,
    });
  });
  it('lists own PENDING and VERIFIED characters across servers in deterministic order, hiding REVOKED', async () => {
    const a = await login();
    const b = await login();
    const tie = '2026-01-03T00:00:00.000Z';
    const pendingLate = await link(
      a,
      alpha,
      'PENDING',
      '2026-01-05T00:00:00.000Z',
    );
    const verifiedOld = await link(
      a,
      beta,
      'VERIFIED',
      '2026-01-01T00:00:00.000Z',
    );
    const revoked = await link(a, alpha, 'REVOKED', '2026-01-02T00:00:00.000Z');
    const tieOne = await link(a, alpha, 'VERIFIED', tie);
    const tieTwo = await link(a, beta, 'VERIFIED', tie);
    const pendingEarly = await link(
      a,
      beta,
      'PENDING',
      '2026-01-04T00:00:00.000Z',
    );
    await link(b, alpha, 'VERIFIED', '2026-01-01T00:00:00.000Z');
    const commands = await commandCount();
    const { body } = await list(a).expect(200);
    // PostgreSQL orders uuid bytewise, i.e. by lowercase hex string.
    const ties = [tieOne, tieTwo].sort((x, y) => (x.id < y.id ? -1 : 1));
    expect(body.items.map((item: { id: string }) => item.id)).toEqual([
      verifiedOld.id,
      ...ties.map((t) => t.id),
      pendingEarly.id,
      pendingLate.id,
    ]);
    expect(body.total).toBe(5);
    expect(body.items.map((item: { id: string }) => item.id)).not.toContain(
      revoked.id,
    );
    expect(body.items[0]).toEqual({
      id: verifiedOld.id,
      gameServer: { id: beta.id, code: beta.code, name: 'Beta', enabled: true },
      characterId: verifiedOld.characterExternalId,
      status: 'VERIFIED',
      verifiedAt: expect.any(String),
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(body.items[3]).toMatchObject({
      status: 'PENDING',
      verifiedAt: null,
    });
    // Identity only: no runtime data, internals, challenge data or history.
    const text = JSON.stringify(body);
    expect(text).not.toMatch(
      /playerId|revokedAt|challenge|hash|providerSubject|level|race|health|skills|profession|inventory|commandId|operationId/i,
    );
    expect(text).not.toContain(a.player.id);
    expect(await commandCount()).toBe(commands);
    expect(gateway.sends).toHaveLength(0);
  });
  it('paginates with the shared page/limit contract and rejects any player selection', async () => {
    const a = await login();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++)
      ids.push(
        (await link(a, alpha, 'VERIFIED', `2026-02-0${i + 1}T00:00:00.000Z`))
          .id,
      );
    const pages = [];
    for (const page of [1, 2, 3]) {
      const { body } = await list(a, { page, limit: 2 }).expect(200);
      expect(body).toMatchObject({ total: 5, page, limit: 2, totalPages: 3 });
      pages.push(...body.items.map((item: { id: string }) => item.id));
    }
    expect(pages).toEqual(ids);
    expect(
      (await list(a, { page: 4, limit: 2 }).expect(200)).body.items,
    ).toEqual([]);
    for (const query of [
      { page: 0 },
      { limit: 101 },
      { limit: 'x' },
      { playerId: randomUUID() },
      { status: 'REVOKED' },
      { includeRevoked: true },
    ])
      await list(a, query).expect(400);
  });
  it('returns detail for own PENDING/VERIFIED links and an indistinguishable 404 otherwise', async () => {
    const a = await login();
    const b = await login();
    const verified = await link(
      a,
      alpha,
      'VERIFIED',
      '2026-03-01T00:00:00.000Z',
    );
    const pending = await link(a, alpha, 'PENDING', '2026-03-02T00:00:00.000Z');
    const revoked = await link(a, beta, 'REVOKED', '2026-03-03T00:00:00.000Z');
    const foreign = await link(b, beta, 'VERIFIED', '2026-03-04T00:00:00.000Z');
    const shown = (await detail(a, verified.id).expect(200)).body;
    expect(shown).toEqual(
      (await list(a).expect(200)).body.items.find(
        (i: { id: string }) => i.id === verified.id,
      ),
    );
    expect((await detail(a, pending.id).expect(200)).body).toMatchObject({
      status: 'PENDING',
      verifiedAt: null,
    });
    const misses = await Promise.all(
      [revoked.id, foreign.id, randomUUID()].map((id) =>
        detail(a, id).expect(404),
      ),
    );
    expect(new Set(misses.map((r) => r.body.message))).toEqual(
      new Set(['Character not found']),
    );
    await detail(a, 'invalid').expect(400);
    await detail(b, verified.id).expect(404);
    // REVOKED stays as history in the database.
    expect(
      (
        await database.query(
          'SELECT status FROM player_characters WHERE id = $1',
          [revoked.id],
        )
      )[0].status,
    ).toBe('REVOKED');
  });
  it('lists PENDING without granting ownership, and only VERIFIED passes the 10.5 policy', async () => {
    const a = await login();
    const pending = await link(a, alpha, 'PENDING', '2026-04-01T00:00:00.000Z');
    const verified = await link(
      a,
      alpha,
      'VERIFIED',
      '2026-04-02T00:00:00.000Z',
    );
    expect((await list(a).expect(200)).body.total).toBe(2);
    await expect(
      ownership.requireVerifiedOwnership(
        a.player.id,
        alpha.id,
        pending.characterExternalId,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await http()
      .post(
        `/api/v1/player/game-servers/${alpha.id}/characters/${encodeURIComponent(pending.characterExternalId)}/profile-query`,
      )
      .auth(a.accessToken, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .expect(404);
    expect(
      (
        await ownership.requireVerifiedOwnership(
          a.player.id,
          alpha.id,
          verified.characterExternalId,
        )
      ).id,
    ).toBe(verified.id);
  });
  it('keeps characters on a disabled server visible with the registry flag only', async () => {
    const a = await login();
    const server = await servers.register({
      code: `off-${randomUUID()}`,
      name: 'Off',
    });
    const kept = await link(a, server, 'VERIFIED', '2026-05-01T00:00:00.000Z');
    await database.query(
      'UPDATE game_servers SET enabled = false WHERE id = $1',
      [server.id],
    );
    const { body } = await list(a).expect(200);
    expect(body.items).toEqual([
      expect.objectContaining({
        id: kept.id,
        status: 'VERIFIED',
        gameServer: {
          id: server.id,
          code: server.code,
          name: 'Off',
          enabled: false,
        },
      }),
    ]);
    expect(JSON.stringify(body)).not.toMatch(
      /health|online|stale|offline|connection/i,
    );
    expect((await detail(a, kept.id).expect(200)).body.gameServer.enabled).toBe(
      false,
    );
  });
  it('rejects staff and anonymous tokens and offers no selected/active character state', async () => {
    const a = await login();
    const verified = await link(
      a,
      alpha,
      'VERIFIED',
      '2026-06-01T00:00:00.000Z',
    );
    await list(staffToken).expect(401);
    await http().get('/api/v1/player/me/characters').expect(401);
    await http()
      .get(`/api/v1/player/me/characters/${verified.id}`)
      .auth(staffToken, { type: 'bearer' })
      .expect(401);
    for (const [method, path] of [
      ['post', `/api/v1/player/me/characters/${verified.id}/select`],
      ['put', '/api/v1/player/me/characters/active'],
      ['post', '/api/v1/player/me/characters'],
      ['delete', `/api/v1/player/me/characters/${verified.id}`],
    ] as const)
      await http()
        [method](path)
        .auth(a.accessToken, { type: 'bearer' })
        .expect(404);
    const { body } = await http().get('/docs-json').expect(200);
    expect(
      Object.entries(body.paths)
        .filter(([p]) => p.startsWith('/api/v1/player/me/characters'))
        .map(([p, ops]) => [p, Object.keys(ops as object)]),
    ).toEqual([
      ['/api/v1/player/me/characters', ['get']],
      ['/api/v1/player/me/characters/{characterLinkId}', ['get']],
      // 10.7: profession of a character (no selection of a "current" character).
      [
        '/api/v1/player/me/characters/{characterLinkId}/profession',
        ['get', 'post'],
      ],
      // 10.9: read-only guild of a character.
      ['/api/v1/player/me/characters/{characterLinkId}/guild', ['get']],
      // 10.12: read-only wallet of a character.
      ['/api/v1/player/me/characters/{characterLinkId}/wallet', ['get']],
      [
        '/api/v1/player/me/characters/{characterLinkId}/wallet/transactions',
        ['get'],
      ],
      // 10.13: trades of a character.
      ['/api/v1/player/me/characters/{characterLinkId}/trades', ['get']],
      // 10.14: marketplace listings and purchases of a character.
      [
        '/api/v1/player/me/characters/{characterLinkId}/marketplace/listings',
        ['get'],
      ],
      [
        '/api/v1/player/me/characters/{characterLinkId}/marketplace/purchases',
        ['get'],
      ],
    ]);
    expect(
      Object.keys(body.components.schemas.PlayerCharacterDto.properties).sort(),
    ).toEqual([
      'characterId',
      'createdAt',
      'gameServer',
      'id',
      'status',
      'verifiedAt',
    ]);
    const columns = await database.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name IN ('players', 'player_characters') AND column_name ~ '(active|selected)'",
      [schema],
    );
    expect(columns).toEqual([]);
  });
});
