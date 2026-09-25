import type { INestApplication, LoggerService } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { compiledDatabaseArtifacts } from './compiled-database.js';
import { loadEnvironment } from '../src/config/environment.js';
import { createDatabaseOptions } from '../src/database/database.options.js';
import { setupApp } from '../src/setup-app.js';
import { AppExpressAdapter } from '../src/common/http/app-express.adapter.js';
import { PasswordService } from '../src/auth/password.service.js';
import { DiscordIdentityProvider } from '../src/player-auth/discord-identity.provider.js';
import { PlayerAuthRateLimiter } from '../src/player-auth/player-auth-rate-limit.js';
import { PlayerStatus } from '../src/player-accounts/player-account.contracts.js';
import { FakeDiscordProvider } from './support/fake-discord-provider.js';

const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;
class CapturingLogger implements LoggerService {
  lines: string[] = [];
  private push = (...values: unknown[]) =>
    this.lines.push(values.map((v) => JSON.stringify(v) ?? '').join(' '));
  log = this.push;
  error = this.push;
  warn = this.push;
  debug = this.push;
  verbose = this.push;
}
describeDatabase('Player authentication with real PostgreSQL', () => {
  let admin: DataSource, database: DataSource, app: INestApplication<App>;
  let limiter: PlayerAuthRateLimiter, staffToken: string;
  const discord = new FakeDiscordProvider();
  const logger = new CapturingLogger();
  const schema = `player_auth_test_${randomUUID().replaceAll('-', '')}`;
  const redirectUri = 'http://127.0.0.1:53682/callback';
  const http = () => request(app.getHttpServer());
  const subjects: string[] = [];
  // Registers a Discord user and returns a fresh single-use authorization code.
  const discordUser = (
    subject = `${Date.now()}${Math.floor(Math.random() * 1e6)}`,
  ) => {
    subjects.push(subject);
    const code = `code-${randomUUID()}`;
    discord.codes.set(code, {
      subject,
      displayName: `Dovah ${subject.slice(-4)}`,
    });
    return { code, subject };
  };
  const exchange = (code: string) =>
    http().post('/api/v1/player/auth/discord/exchange').send({
      authorizationCode: code,
      redirectUri,
    });
  const login = async (subject?: string) =>
    (await exchange(discordUser(subject).code).expect(200)).body;
  const me = (token: string) =>
    http().get('/api/v1/player/me').auth(token, { type: 'bearer' });
  const refresh = (refreshToken: string) =>
    http().post('/api/v1/player/auth/refresh').send({ refreshToken });
  const setStatus = (id: string, status: PlayerStatus) =>
    database.query('UPDATE players SET status = $1 WHERE id = $2', [
      status,
      id,
    ]);
  const count = async (table: string) =>
    Number((await database.query(`SELECT count(*) FROM ${table}`))[0].count);
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
    expect(await database.runMigrations()).toHaveLength(22);
    await database.undoLastMigration(); // Etapa 10.17 VIP Entitlements
    await database.undoLastMigration(); // Etapa 10.16 Player Settings
    await database.undoLastMigration(); // Etapa 10.15 Player Chat
    await database.undoLastMigration(); // Etapa 10.14 Player Marketplace
    await database.undoLastMigration(); // Etapa 10.13 Player Trades
    await database.undoLastMigration(); // Etapa 10.12 Economy
    await database.undoLastMigration(); // Etapa 10.9 Player Guilds
    await database.undoLastMigration(); // Etapa 10.8 Player Groups
    await database.undoLastMigration(); // Etapa 10.7 Professions
    await database.undoLastMigration(); // Etapa 10.4 Player Characters
    await database.undoLastMigration();
    expect(
      await database.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename = 'player_sessions'",
        [schema],
      ),
    ).toEqual([]);
    expect(await database.runMigrations()).toHaveLength(11);
    expect(await database.runMigrations()).toHaveLength(0);
    const { AppModule } = await import('../src/app.module.js');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DataSource)
      .useValue(database)
      .overrideProvider(DiscordIdentityProvider)
      .useValue(discord)
      .compile();
    app = module.createNestApplication(new AppExpressAdapter());
    app.useLogger(logger);
    setupApp(app);
    await app.listen(0, '127.0.0.1');
    limiter = app.get(PlayerAuthRateLimiter);
    const password = 'Player-Auth-Staff-Password-42';
    await database.query(
      "INSERT INTO staff_users(username, display_name, password_hash, role_name) VALUES ('coordinator', 'Coordinator', $1, 'COORDINATOR')",
      [await new PasswordService().hash(password)],
    );
    staffToken = (
      await http()
        .post('/api/v1/auth/login')
        .send({ username: 'coordinator', password })
        .expect(200)
    ).body.accessToken;
  }, 30000);
  beforeEach(() => {
    limiter.reset();
    discord.outage = false;
    discord.grants = [];
  });
  afterAll(async () => {
    await app?.close();
    if (database?.isInitialized) await database.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  it('adds only player_sessions, independent of staff, with no schema diff', async () => {
    expect(database.options.synchronize).toBe(false);
    expect(await database.showMigrations()).toBe(false);
    const diff = await database.driver.createSchemaBuilder().log();
    expect(diff.upQueries).toEqual([]);
    expect(diff.downQueries).toEqual([]);
    expect(
      (
        await database.query(
          'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position',
          [schema, 'player_sessions'],
        )
      ).map((r: { column_name: string }) => r.column_name),
    ).toEqual([
      'id',
      'player_id',
      'refresh_token_hash',
      'expires_at',
      'revoked_at',
      'last_used_at',
      'created_at',
    ]);
    expect(
      await database.query(
        "SELECT confrelid::regclass::text AS target FROM pg_constraint WHERE contype = 'f' AND conrelid = 'player_sessions'::regclass",
      ),
    ).toEqual([{ target: 'players' }]);
  });
  it('provisions player, identity and session on first login and reuses them afterwards', async () => {
    const { subject, code } = discordUser();
    const players = await count('players');
    const first = await exchange(code).expect(200);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.body).toEqual({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      expiresIn: 900,
      refreshExpiresAt: expect.any(String),
      player: {
        id: expect.any(String),
        displayName: `Dovah ${subject.slice(-4)}`,
        status: 'ACTIVE',
        identities: [{ provider: 'DISCORD', linkedAt: expect.any(String) }],
      },
    });
    const refreshDays =
      (Date.parse(first.body.refreshExpiresAt) - Date.now()) / 86400000;
    expect(refreshDays).toBeGreaterThan(29.9);
    expect(refreshDays).toBeLessThanOrEqual(30);
    const again = await login(subject);
    expect(again.player.id).toBe(first.body.player.id);
    expect(await count('players')).toBe(players + 1);
    expect(
      await database.query(
        'SELECT provider, provider_subject FROM player_identities WHERE player_id = $1',
        [first.body.player.id],
      ),
    ).toEqual([{ provider: 'DISCORD', provider_subject: subject }]);
    expect(
      await database.query(
        'SELECT count(*)::int AS n FROM player_sessions WHERE player_id = $1',
        [first.body.player.id],
      ),
    ).toEqual([{ n: 2 }]);
    expect(discord.grants[0]).toEqual({
      authorizationCode: code,
      redirectUri,
      codeVerifier: undefined,
    });
  });
  it('creates exactly one player for concurrent first logins of the same identity', async () => {
    const subject = `${Date.now()}77`;
    const codes = Array.from({ length: 8 }, () => discordUser(subject).code);
    const players = await count('players');
    const responses = await Promise.all(codes.map((code) => exchange(code)));
    expect(responses.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect(new Set(responses.map((r) => r.body.player.id)).size).toBe(1);
    expect(await count('players')).toBe(players + 1);
    expect(
      await database.query(
        'SELECT count(*)::int AS n FROM player_sessions WHERE player_id = $1',
        [responses[0].body.player.id],
      ),
    ).toEqual([{ n: 8 }]);
  });
  it('fails safely on provider rejection or outage without leaking provider data', async () => {
    const players = await count('players');
    const rejected = await exchange('unknown-code').expect(401);
    expect(rejected.body.message).toBe('Discord authorization rejected');
    discord.outage = true;
    const outage = await exchange(discordUser().code).expect(503);
    expect(outage.body).not.toHaveProperty('accessToken');
    expect(await count('players')).toBe(players);
    for (const body of [
      {},
      { authorizationCode: 'x' },
      { redirectUri },
      { authorizationCode: 'a b', redirectUri },
      { authorizationCode: 'x', redirectUri, codeVerifier: 'short' },
      { authorizationCode: 'x', redirectUri, clientSecret: 'x' },
      { authorizationCode: 'x', redirectUri, playerId: randomUUID() },
      { authorizationCode: 'x', redirectUri, providerSubject: '1' },
    ])
      await http()
        .post('/api/v1/player/auth/discord/exchange')
        .send(body)
        .expect(400);
  });
  it('issues separate player access/refresh JWTs that staff guards reject, and vice versa', async () => {
    const { accessToken, refreshToken, player } = await login();
    for (const [token, audience] of [
      [accessToken, 'skyrim-player-access'],
      [refreshToken, 'skyrim-player-refresh'],
    ]) {
      expect(decodeProtectedHeader(token)).toEqual({
        alg: 'HS256',
        typ: 'JWT',
      });
      expect(decodeJwt(token)).toMatchObject({
        iss: 'skyrim-player-api',
        aud: audience,
        sub: player.id,
      });
    }
    const access = decodeJwt(accessToken);
    expect(access.exp! - access.iat!).toBe(900);
    await me(accessToken).expect(200);
    await me(refreshToken).expect(401);
    await me(staffToken).expect(401);
    await http()
      .post('/api/v1/player/auth/logout')
      .auth(staffToken, { type: 'bearer' })
      .expect(401);
    await refresh(staffToken).expect(401);
    await refresh(accessToken).expect(401);
    for (const token of [accessToken, refreshToken])
      await http()
        .get('/api/v1/auth/me')
        .auth(token, { type: 'bearer' })
        .expect(401);
    await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect(401);
    await http()
      .get('/api/v1/auth/me')
      .auth(staffToken, { type: 'bearer' })
      .expect(200);
    await http().get('/api/v1/player/me').expect(401);
  });
  it('returns a safe /player/me derived only from the token', async () => {
    const { accessToken, player } = await login();
    const other = await login();
    const response = await me(accessToken).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual(player);
    expect(response.text).not.toMatch(
      /providerSubject|provider_subject|session|refresh|hash|token/i,
    );
    for (const subject of subjects)
      expect(response.text).not.toContain(subject);
    await me(accessToken).query({ playerId: other.player.id }).expect(400);
    await me(accessToken).query({ id: other.player.id }).expect(400);
    expect((await me(other.accessToken).expect(200)).body.id).toBe(
      other.player.id,
    );
  });
  it.each([PlayerStatus.SUSPENDED, PlayerStatus.BANNED])(
    'blocks %s at login, refresh and on live access tokens',
    async (status) => {
      const { subject, code } = discordUser();
      const first = (await exchange(code).expect(200)).body;
      await me(first.accessToken).expect(200);
      await setStatus(first.player.id, status);
      try {
        await me(first.accessToken).expect(403);
        await refresh(first.refreshToken).expect(403);
        await exchange(discordUser(subject).code).expect(403);
        await http()
          .post('/api/v1/player/auth/logout')
          .auth(first.accessToken, { type: 'bearer' })
          .expect(403);
      } finally {
        await setStatus(first.player.id, PlayerStatus.ACTIVE);
      }
      await me(first.accessToken).expect(200);
    },
  );
  it('rotates refresh tokens and rejects reuse of a previous token, including concurrently', async () => {
    const first = await login();
    const second = (await refresh(first.refreshToken).expect(200)).body;
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.player.id).toBe(first.player.id);
    expect(second.refreshExpiresAt).toBe(first.refreshExpiresAt);
    await refresh(first.refreshToken).expect(401);
    await me(second.accessToken).expect(200);
    const raced = await Promise.all([
      refresh(second.refreshToken),
      refresh(second.refreshToken),
    ]);
    expect(raced.map((r) => r.status).sort()).toEqual([200, 401]);
    const [row] = await database.query(
      'SELECT refresh_token_hash, last_used_at FROM player_sessions WHERE player_id = $1',
      [first.player.id],
    );
    expect(row.refresh_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.last_used_at).not.toBeNull();
    const winner = raced.find((r) => r.status === 200)!.body;
    expect(row.refresh_token_hash).not.toContain(winner.refreshToken);
  });
  it('revokes the session on logout and rejects expired sessions', async () => {
    const session = await login();
    await http()
      .post('/api/v1/player/auth/logout')
      .auth(session.accessToken, { type: 'bearer' })
      .expect(204);
    await me(session.accessToken).expect(401);
    await refresh(session.refreshToken).expect(401);
    const expired = await login();
    await database.query(
      "UPDATE player_sessions SET created_at = now() - interval '31 days', expires_at = now() - interval '1 second' WHERE player_id = $1",
      [expired.player.id],
    );
    await me(expired.accessToken).expect(401);
    await refresh(expired.refreshToken).expect(401);
  });
  it('rate limits exchange and refresh per client without affecting other routes', async () => {
    for (let i = 0; i < limiter.limit; i++)
      await refresh('invalid-token').expect(401);
    const limited = await refresh('invalid-token').expect(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    const session = await login();
    await me(session.accessToken).expect(200);
    for (let i = 1; i < limiter.limit; i++)
      await exchange('unknown').expect(401);
    await exchange('unknown').expect(429);
    expect(discord.grants.length).toBe(limiter.limit);
  });
  it('stores no provider credential and keeps provider subjects out of logs and Audit', async () => {
    await login();
    const tables = (
      await database.query(
        'SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1',
        [schema],
      )
    ).filter((r: { table_name: string }) => r.table_name.startsWith('player'));
    for (const { column_name } of tables)
      expect(column_name).not.toMatch(
        /token(?!_hash)|secret|email|oauth|access|password/i,
      );
    expect(
      await database.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE actor_type = 'PLAYER'",
      ),
    ).toEqual([{ n: 0 }]);
    const audit = JSON.stringify(
      await database.query('SELECT * FROM audit_logs'),
    );
    const logs = logger.lines.join('\n');
    for (const subject of subjects) {
      expect(audit).not.toContain(subject);
      expect(logs).not.toContain(subject);
    }
  });
  it('documents the player auth routes without exposing provider secrets', async () => {
    const { body } = await http().get('/docs-json').expect(200);
    expect(
      Object.keys(body.paths)
        .filter((p) => p.startsWith('/api/v1/player'))
        .sort(),
    ).toEqual([
      '/api/v1/player/auth/discord/exchange',
      '/api/v1/player/auth/logout',
      '/api/v1/player/auth/refresh',
      '/api/v1/player/character-links',
      '/api/v1/player/character-links/{linkId}',
      '/api/v1/player/character-links/{linkId}/revoke',
      '/api/v1/player/character-operations/{operationId}',
      '/api/v1/player/chat/direct/{targetCharacterId}',
      '/api/v1/player/chat/global',
      '/api/v1/player/game-servers/{gameServerId}/characters/{characterId}/holds-query',
      '/api/v1/player/game-servers/{gameServerId}/characters/{characterId}/horses-query',
      '/api/v1/player/game-servers/{gameServerId}/characters/{characterId}/profile-query',
      '/api/v1/player/game-servers/{gameServerId}/characters/{characterId}/properties-query',
      '/api/v1/player/game-servers/{gameServerId}/characters/{characterId}/skills-query',
      '/api/v1/player/group-invites',
      '/api/v1/player/group-invites/{inviteId}/accept',
      '/api/v1/player/group-invites/{inviteId}/decline',
      '/api/v1/player/groups',
      '/api/v1/player/groups/{groupId}',
      '/api/v1/player/groups/{groupId}/chat',
      '/api/v1/player/groups/{groupId}/disband',
      '/api/v1/player/groups/{groupId}/invites',
      '/api/v1/player/groups/{groupId}/leave',
      '/api/v1/player/groups/{groupId}/members/{memberId}/kick',
      '/api/v1/player/guild-invites',
      '/api/v1/player/guild-invites/{inviteId}/accept',
      '/api/v1/player/guild-invites/{inviteId}/decline',
      '/api/v1/player/guilds',
      '/api/v1/player/guilds/{guildId}',
      '/api/v1/player/guilds/{guildId}/chat',
      '/api/v1/player/guilds/{guildId}/disband',
      '/api/v1/player/guilds/{guildId}/invites',
      '/api/v1/player/guilds/{guildId}/leave',
      '/api/v1/player/guilds/{guildId}/members/{memberId}/kick',
      '/api/v1/player/guilds/{guildId}/members/{memberId}/role',
      '/api/v1/player/guilds/{guildId}/members/{memberId}/transfer-master',
      '/api/v1/player/marketplace/listings',
      '/api/v1/player/marketplace/listings/{listingId}',
      '/api/v1/player/marketplace/listings/{listingId}/cancel',
      '/api/v1/player/marketplace/listings/{listingId}/purchase',
      '/api/v1/player/me',
      '/api/v1/player/me/characters',
      '/api/v1/player/me/characters/{characterLinkId}',
      '/api/v1/player/me/characters/{characterLinkId}/chat/direct/{targetCharacterId}',
      '/api/v1/player/me/characters/{characterLinkId}/chat/global',
      '/api/v1/player/me/characters/{characterLinkId}/guild',
      '/api/v1/player/me/characters/{characterLinkId}/marketplace/listings',
      '/api/v1/player/me/characters/{characterLinkId}/marketplace/purchases',
      '/api/v1/player/me/characters/{characterLinkId}/profession',
      '/api/v1/player/me/characters/{characterLinkId}/trades',
      '/api/v1/player/me/characters/{characterLinkId}/vip/effective',
      '/api/v1/player/me/characters/{characterLinkId}/vip/entitlements',
      '/api/v1/player/me/characters/{characterLinkId}/wallet',
      '/api/v1/player/me/characters/{characterLinkId}/wallet/transactions',
      '/api/v1/player/settings',
      '/api/v1/player/trades',
      '/api/v1/player/trades/{tradeId}',
      '/api/v1/player/trades/{tradeId}/accept',
      '/api/v1/player/trades/{tradeId}/cancel',
      '/api/v1/player/trades/{tradeId}/offer',
      '/api/v1/player/vip/entitlements',
    ]);
    expect(
      Object.keys(body.components.schemas.DiscordExchangeDto.properties).sort(),
    ).toEqual(['authorizationCode', 'codeVerifier', 'redirectUri']);
    expect(body.components.schemas.PlayerMeDto.properties).not.toHaveProperty(
      'providerSubject',
    );
    expect(JSON.stringify(body)).not.toMatch(/clientSecret|client_secret/);
  });
});
