import { NotFoundException } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash, randomUUID } from 'node:crypto';
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
import { PlayerAuthRateLimiter } from '../src/player-auth/player-auth-rate-limit.js';
import { CharacterLinkService } from '../src/player-characters/character-link.service.js';
import { CharacterOwnershipService } from '../src/player-characters/character-ownership.service.js';
import { FakeDiscordProvider } from './support/fake-discord-provider.js';

const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;
interface Session {
  accessToken: string;
  player: { id: string };
}
describeDatabase('Character ownership with real PostgreSQL', () => {
  let admin: DataSource, database: DataSource, app: INestApplication<App>;
  let links: CharacterLinkService, ownership: CharacterOwnershipService;
  let servers: GameServerService, limiter: PlayerAuthRateLimiter;
  let server: GameServer, a: Session, b: Session, staffToken: string;
  const discord = new FakeDiscordProvider();
  const schema = `player_characters_test_${randomUUID().replaceAll('-', '')}`;
  const http = () => request(app.getHttpServer());
  const character = () => `char:${randomUUID()}`;
  const login = async (): Promise<Session> => {
    const code = `code-${randomUUID()}`;
    discord.codes.set(code, {
      subject: `${Date.now()}${Math.floor(Math.random() * 1e9)}`,
      displayName: 'Dovahkiin',
    });
    return (
      await http()
        .post('/api/v1/player/auth/discord/exchange')
        .send({ authorizationCode: code, redirectUri: 'http://127.0.0.1/cb' })
        .expect(200)
    ).body;
  };
  const create = (
    session: Session,
    characterExternalId: string,
    gameServerId = server.id,
  ) =>
    http()
      .post('/api/v1/player/character-links')
      .auth(session.accessToken, { type: 'bearer' })
      .send({ gameServerId, characterExternalId });
  const requested = async (session: Session, id = character()) => {
    const { body } = await create(session, id).expect(201);
    return { ...body, characterExternalId: id };
  };
  const read = (session: Session, id: string) =>
    http()
      .get(`/api/v1/player/character-links/${id}`)
      .auth(session.accessToken, { type: 'bearer' });
  const revoke = (session: Session, id: string) =>
    http()
      .post(`/api/v1/player/character-links/${id}/revoke`)
      .auth(session.accessToken, { type: 'bearer' });
  const confirm = (
    challenge: string,
    characterExternalId: string,
    gameServerId = server.id,
  ) => links.confirmFromAgent({ challenge, gameServerId, characterExternalId });
  const row = async (id: string) =>
    (
      await database.query('SELECT * FROM player_characters WHERE id = $1', [
        id,
      ])
    )[0];
  const audits = (id: string) =>
    database.query(
      'SELECT * FROM audit_logs WHERE resource_id = $1 ORDER BY created_at, action',
      [id],
    );
  const sha = (challenge: string) =>
    createHash('sha256').update(challenge.replaceAll('-', '')).digest('hex');
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
    await database.undoLastMigration(); // Etapa 12.4 Operational Recovery
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
    await database.undoLastMigration(); // Etapa 10.7 Professions
    await database.undoLastMigration();
    expect(await database.runMigrations()).toHaveLength(14);
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
    ownership = app.get(CharacterOwnershipService);
    servers = app.get(GameServerService);
    limiter = app.get(PlayerAuthRateLimiter);
    a = await login();
    b = await login();
    const password = 'Ownership-Staff-Password-42';
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
    server = await servers.register({ code: randomUUID(), name: 'Ownership' });
  });
  afterAll(async () => {
    await app?.close();
    if (database?.isInitialized) await database.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  it('adds both tables with database-enforced ownership invariants and no schema diff', async () => {
    expect(database.options.synchronize).toBe(false);
    expect(await database.showMigrations()).toBe(false);
    const diff = await database.driver.createSchemaBuilder().log();
    expect(diff.upQueries).toEqual([]);
    expect(diff.downQueries).toEqual([]);
    const indexes = await database.query(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename LIKE 'player_character%' ORDER BY indexname",
      [schema],
    );
    const def = (name: string) =>
      indexes.find((i: { indexname: string }) => i.indexname === name).indexdef;
    expect(def('player_characters_verified_key')).toMatch(
      /UNIQUE INDEX .*\(game_server_id, character_external_id\) WHERE \(\(status\)::text = 'VERIFIED'/,
    );
    expect(def('player_characters_link_key')).toMatch(
      /UNIQUE INDEX .*\(player_id, game_server_id, character_external_id\)/,
    );
    expect(def('player_character_link_challenges_active_key')).toMatch(
      /UNIQUE INDEX .*\(player_character_id\) WHERE \(\(consumed_at IS NULL\) AND \(revoked_at IS NULL\)\)/,
    );
    const player = a.player.id;
    const insert = (status: string, extra = '') =>
      database.query(
        `INSERT INTO player_characters(player_id, game_server_id, character_external_id, status${extra ? ', verified_at' : ''}) VALUES ($1, $2, $3, $4${extra})`,
        [player, server.id, character(), status],
      );
    await expect(insert('VERIFIED')).rejects.toMatchObject({
      driverError: { code: '23514' },
    });
    await expect(insert('REVOKED')).rejects.toMatchObject({
      driverError: { code: '23514' },
    });
    await expect(insert('PENDING', ', now()')).rejects.toMatchObject({
      driverError: { code: '23514' },
    });
    await expect(insert('UNKNOWN')).rejects.toMatchObject({
      driverError: { code: '23514' },
    });
    await expect(
      database.query(
        "INSERT INTO player_characters(player_id, game_server_id, character_external_id) VALUES ($1, $2, '  ')",
        [player, server.id],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23514' } });
    await expect(
      database.query(
        "INSERT INTO player_characters(player_id, game_server_id, character_external_id) VALUES ($1, $2, 'x')",
        [randomUUID(), server.id],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23503' } });
  });
  it('creates a PENDING link and returns the challenge exactly once, storing only its hash', async () => {
    const id = character();
    const response = await create(a, `  ${id}  `).expect(201);
    expect(response.headers['cache-control']).toBe('no-store');
    const link = response.body;
    expect(link).toEqual({
      linkId: expect.any(String),
      gameServerId: server.id,
      characterExternalId: id,
      status: 'PENDING',
      verifiedAt: null,
      revokedAt: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      challenge: expect.stringMatching(
        /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{5}$/,
      ),
      challengeExpiresAt: expect.any(String),
    });
    const ttl = Date.parse(link.challengeExpiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(590000);
    expect(ttl).toBeLessThanOrEqual(600000);
    const later = await read(a, link.linkId).expect(200);
    expect(later.body).not.toHaveProperty('challenge');
    expect(later.text).not.toContain(link.challenge);
    const stored = await database.query(
      'SELECT * FROM player_character_link_challenges WHERE player_character_id = $1',
      [link.linkId],
    );
    expect(stored).toHaveLength(1);
    expect(stored[0].challenge_hash).toBe(sha(link.challenge));
    const everything = JSON.stringify([
      stored,
      await row(link.linkId),
      await audits(link.linkId),
    ]);
    for (const secret of [link.challenge, link.challenge.replaceAll('-', '')])
      expect(everything).not.toContain(secret);
    const [entry] = await audits(link.linkId);
    expect(entry).toMatchObject({
      action: 'PLAYER_CHARACTER_LINK_REQUESTED',
      actor_type: 'PLAYER',
      actor_player_id: a.player.id,
      actor_role: null,
      resource_type: 'PLAYER_CHARACTER',
      status_code: 201,
    });
    expect(entry.metadata).toEqual({
      linkId: link.linkId,
      gameServerId: server.id,
      characterExternalId: id,
      status: 'PENDING',
      relink: false,
    });
    expect(JSON.stringify(entry)).not.toContain(stored[0].challenge_hash);
    expect(
      Number(
        (await database.query('SELECT count(*) FROM game_commands'))[0].count,
      ),
    ).toBe(0);
  });
  it('isolates links between players and rejects any player selection or foreign token', async () => {
    const link = await requested(a);
    await read(b, link.linkId).expect(404);
    await revoke(b, link.linkId).expect(404);
    expect((await row(link.linkId)).status).toBe('PENDING');
    await read(a, 'invalid').expect(400);
    await read(a, randomUUID()).expect(404);
    for (const extra of [
      { playerId: b.player.id },
      { status: 'VERIFIED' },
      { challenge: 'ABCD-EFGH-JKMNP' },
      { verified: true },
    ])
      await http()
        .post('/api/v1/player/character-links')
        .auth(a.accessToken, { type: 'bearer' })
        .send({
          gameServerId: server.id,
          characterExternalId: character(),
          ...extra,
        })
        .expect(400);
    for (const invalid of ['', '   ', 'x'.repeat(129), 'a\nb', 1])
      await http()
        .post('/api/v1/player/character-links')
        .auth(a.accessToken, { type: 'bearer' })
        .send({ gameServerId: server.id, characterExternalId: invalid })
        .expect(400);
    await http()
      .post('/api/v1/player/character-links')
      .auth(staffToken, { type: 'bearer' })
      .send({ gameServerId: server.id, characterExternalId: character() })
      .expect(401);
    await http()
      .get(`/api/v1/player/character-links/${link.linkId}`)
      .expect(401);
    await http()
      .get('/api/v1/auth/me')
      .auth(a.accessToken, { type: 'bearer' })
      .expect(401);
    await revoke(a, link.linkId).send({ playerId: b.player.id }).expect(400);
  });
  it('verifies only through the trusted Agent confirmation, with replay safety and SYSTEM:AGENT Audit', async () => {
    const link = await requested(a);
    await expect(
      ownership.requireVerifiedOwnership(
        a.player.id,
        server.id,
        link.characterExternalId,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await confirm('ABCD-EFGH-JKMNP', link.characterExternalId)).toEqual({
      outcome: 'REJECTED',
      reason: 'INVALID_CHALLENGE',
    });
    expect(
      await confirm('not a challenge', link.characterExternalId),
    ).toMatchObject({
      reason: 'INVALID_CHALLENGE',
    });
    expect(await confirm(link.challenge, character())).toMatchObject({
      reason: 'CHALLENGE_MISMATCH',
    });
    const other = await servers.register({ code: randomUUID(), name: 'Other' });
    expect(
      await confirm(link.challenge, link.characterExternalId, other.id),
    ).toMatchObject({
      reason: 'CHALLENGE_MISMATCH',
    });
    expect((await row(link.linkId)).status).toBe('PENDING');
    const typed = ` ${link.challenge.toLowerCase().replaceAll('-', ' ')} `;
    expect(await confirm(typed, ` ${link.characterExternalId} `)).toEqual({
      outcome: 'VERIFIED',
      linkId: link.linkId,
      playerId: a.player.id,
    });
    const verified = (await read(a, link.linkId).expect(200)).body;
    expect(verified).toMatchObject({ status: 'VERIFIED', revokedAt: null });
    expect(Date.parse(verified.verifiedAt)).toBeGreaterThan(Date.now() - 60000);
    expect(
      (
        await ownership.requireVerifiedOwnership(
          a.player.id,
          server.id,
          ` ${link.characterExternalId} `,
        )
      ).id,
    ).toBe(link.linkId);
    expect(await confirm(link.challenge, link.characterExternalId)).toEqual({
      outcome: 'ALREADY_VERIFIED',
      linkId: link.linkId,
      playerId: a.player.id,
    });
    expect(await confirm(link.challenge, character())).toMatchObject({
      reason: 'INVALID_CHALLENGE',
    });
    const entries = await audits(link.linkId);
    expect(entries.map((e: { action: string }) => e.action)).toEqual([
      'PLAYER_CHARACTER_LINK_REQUESTED',
      'PLAYER_CHARACTER_LINK_VERIFIED',
    ]);
    expect(entries[1]).toMatchObject({
      actor_type: 'SYSTEM',
      actor_system_source: 'AGENT',
      actor_player_id: null,
      actor_staff_id: null,
    });
    expect(entries[1].metadata).toEqual({
      linkId: link.linkId,
      gameServerId: server.id,
      characterExternalId: link.characterExternalId,
      playerId: a.player.id,
    });
    await create(a, link.characterExternalId).expect(409);
  });
  it('rejects expired, superseded and revoked challenges without side effects', async () => {
    const expired = await requested(a);
    await database.query(
      "UPDATE player_character_link_challenges SET created_at = now() - interval '20 minutes', expires_at = now() - interval '1 second' WHERE player_character_id = $1",
      [expired.linkId],
    );
    expect(
      await confirm(expired.challenge, expired.characterExternalId),
    ).toMatchObject({
      reason: 'EXPIRED_CHALLENGE',
    });
    expect((await row(expired.linkId)).status).toBe('PENDING');
    const first = await requested(a);
    const second = (await create(a, first.characterExternalId).expect(201))
      .body;
    expect(second.linkId).toBe(first.linkId);
    expect(second.challenge).not.toBe(first.challenge);
    expect(
      await confirm(first.challenge, first.characterExternalId),
    ).toMatchObject({
      reason: 'INVALID_CHALLENGE',
    });
    const active = await database.query(
      'SELECT count(*)::int AS n FROM player_character_link_challenges WHERE player_character_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL',
      [first.linkId],
    );
    expect(active).toEqual([{ n: 1 }]);
    expect(
      await confirm(second.challenge, first.characterExternalId),
    ).toMatchObject({
      outcome: 'VERIFIED',
    });
    const pending = await requested(a);
    const revoked = (await revoke(a, pending.linkId).expect(200)).body;
    expect(revoked).toMatchObject({ status: 'REVOKED', verifiedAt: null });
    expect(
      await confirm(pending.challenge, pending.characterExternalId),
    ).toMatchObject({
      reason: 'INVALID_CHALLENGE',
    });
  });
  it('self-revokes VERIFIED links idempotently and relinks the same row with a new challenge', async () => {
    const link = await requested(a);
    await confirm(link.challenge, link.characterExternalId);
    const revoked = (await revoke(a, link.linkId).expect(200)).body;
    expect(revoked).toMatchObject({
      status: 'REVOKED',
      verifiedAt: expect.any(String),
    });
    expect(revoked.revokedAt).not.toBeNull();
    await expect(
      ownership.requireVerifiedOwnership(
        a.player.id,
        server.id,
        link.characterExternalId,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect((await revoke(a, link.linkId).expect(200)).body).toEqual(revoked);
    const relinked = (await create(a, link.characterExternalId).expect(201))
      .body;
    expect(relinked).toMatchObject({
      linkId: link.linkId,
      status: 'PENDING',
      verifiedAt: null,
      revokedAt: null,
    });
    expect(
      await confirm(relinked.challenge, link.characterExternalId),
    ).toMatchObject({
      outcome: 'VERIFIED',
    });
    expect(
      await database.query(
        'SELECT count(*)::int AS n FROM player_characters WHERE id = $1',
        [link.linkId],
      ),
    ).toEqual([{ n: 1 }]);
    const entries = await audits(link.linkId);
    expect(entries.map((e: { action: string }) => e.action)).toEqual([
      'PLAYER_CHARACTER_LINK_REQUESTED',
      'PLAYER_CHARACTER_LINK_VERIFIED',
      'PLAYER_CHARACTER_LINK_REVOKED',
      'PLAYER_CHARACTER_LINK_REQUESTED',
      'PLAYER_CHARACTER_LINK_VERIFIED',
    ]);
    expect(entries[2].metadata).toMatchObject({ previousStatus: 'VERIFIED' });
    expect(entries[3].metadata).toMatchObject({ relink: true });
  });
  it('keeps a character owned by one player without revealing the owner', async () => {
    const id = character();
    const bEarly = await requested(b, id);
    const owned = await requested(a, id);
    await confirm(owned.challenge, id);
    const conflict = await create(b, id).expect(409);
    expect(conflict.body.message).toBe('Character unavailable');
    expect(conflict.text).not.toContain(a.player.id);
    expect(conflict.text).not.toContain(owned.linkId);
    expect(await confirm(bEarly.challenge, id)).toEqual({
      outcome: 'REJECTED',
      reason: 'CHARACTER_UNAVAILABLE',
    });
    expect((await row(bEarly.linkId)).status).toBe('PENDING');
    // Same character on another server is independent.
    const other = await servers.register({ code: randomUUID(), name: 'Other' });
    await create(b, id, other.id).expect(201);
    // Ownership passes only after A revokes; nothing transfers automatically.
    await revoke(a, owned.linkId).expect(200);
    const reclaim = (await create(b, id).expect(201)).body;
    expect((await row(owned.linkId)).status).toBe('REVOKED');
    expect(await confirm(reclaim.challenge, id)).toMatchObject({
      outcome: 'VERIFIED',
    });
    expect(
      (await ownership.requireVerifiedOwnership(b.player.id, server.id, id))
        .playerId,
    ).toBe(b.player.id);
  });
  it('does not confirm for SUSPENDED/BANNED players or disabled servers and keeps existing links', async () => {
    for (const status of ['SUSPENDED', 'BANNED']) {
      const link = await requested(a);
      await database.query('UPDATE players SET status = $1 WHERE id = $2', [
        status,
        a.player.id,
      ]);
      try {
        expect(await confirm(link.challenge, link.characterExternalId)).toEqual(
          {
            outcome: 'REJECTED',
            reason: 'PLAYER_UNAVAILABLE',
          },
        );
        await read(a, link.linkId).expect(403);
      } finally {
        await database.query(
          "UPDATE players SET status = 'ACTIVE' WHERE id = $1",
          [a.player.id],
        );
      }
      expect(
        await confirm(link.challenge, link.characterExternalId),
      ).toMatchObject({
        outcome: 'VERIFIED',
      });
    }
    const kept = await requested(a);
    await confirm(kept.challenge, kept.characterExternalId);
    await database.query(
      "UPDATE players SET status = 'SUSPENDED' WHERE id = $1",
      [a.player.id],
    );
    expect((await row(kept.linkId)).status).toBe('VERIFIED');
    await database.query("UPDATE players SET status = 'ACTIVE' WHERE id = $1", [
      a.player.id,
    ]);
    const blocked = await requested(a);
    await database
      .getRepository<GameServer>('GameServer')
      .update(server.id, { enabled: false });
    try {
      expect(
        await confirm(blocked.challenge, blocked.characterExternalId),
      ).toMatchObject({
        reason: 'SERVER_UNAVAILABLE',
      });
      await create(a, character()).expect(409);
    } finally {
      await database
        .getRepository<GameServer>('GameServer')
        .update(server.id, { enabled: true });
    }
    await create(a, character(), randomUUID()).expect(404);
    await create(a, character(), 'invalid').expect(400);
  });
  it('lets PostgreSQL decide concurrent confirmations, cross-player races, relinks and revocations', async () => {
    const link = await requested(a);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        confirm(link.challenge, link.characterExternalId),
      ),
    );
    expect(results.filter((r) => r.outcome === 'VERIFIED')).toHaveLength(1);
    expect(
      results.filter((r) => r.outcome === 'ALREADY_VERIFIED'),
    ).toHaveLength(7);
    expect(
      (await audits(link.linkId)).filter(
        (e: { action: string }) =>
          e.action === 'PLAYER_CHARACTER_LINK_VERIFIED',
      ),
    ).toHaveLength(1);
    const id = character();
    const [la, lb] = [await requested(a, id), await requested(b, id)];
    const raced = await Promise.all([
      confirm(la.challenge, id),
      confirm(lb.challenge, id),
    ]);
    expect(raced.map((r) => r.outcome).sort()).toEqual([
      'REJECTED',
      'VERIFIED',
    ]);
    expect(raced.find((r) => r.outcome === 'REJECTED')).toMatchObject({
      reason: 'CHARACTER_UNAVAILABLE',
    });
    expect(
      await database.query(
        "SELECT count(*)::int AS n FROM player_characters WHERE game_server_id = $1 AND character_external_id = $2 AND status = 'VERIFIED'",
        [server.id, id],
      ),
    ).toEqual([{ n: 1 }]);
    const shared = character();
    const burst = await Promise.all(
      Array.from({ length: 6 }, () => create(a, shared)),
    );
    expect(burst.map((r) => r.status)).toEqual(Array(6).fill(201));
    expect(new Set(burst.map((r) => r.body.linkId)).size).toBe(1);
    expect(
      await database.query(
        'SELECT count(*)::int AS n FROM player_character_link_challenges WHERE player_character_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL',
        [burst[0].body.linkId],
      ),
    ).toEqual([{ n: 1 }]);
    const winners = await Promise.all(
      burst.map((r) => confirm(r.body.challenge, shared)),
    );
    expect(winners.filter((r) => r.outcome === 'VERIFIED')).toHaveLength(1);
    const contested = await requested(a);
    const [revoked, confirmed] = await Promise.all([
      revoke(a, contested.linkId),
      confirm(contested.challenge, contested.characterExternalId),
    ]);
    expect(revoked.status).toBe(200);
    const final = await row(contested.linkId);
    expect(final.status).toBe('REVOKED');
    if (confirmed.outcome === 'VERIFIED')
      expect(final.verified_at).not.toBeNull();
    else {
      expect(confirmed).toMatchObject({ reason: 'INVALID_CHALLENGE' });
      expect(final.verified_at).toBeNull();
    }
  });
  it('exposes only the three player link routes, no Agent endpoint and no GameCommand', async () => {
    const { body } = await http().get('/docs-json').expect(200);
    expect(
      Object.keys(body.paths)
        .filter((p) => p.includes('character-links'))
        .sort(),
    ).toEqual([
      '/api/v1/player/character-links',
      '/api/v1/player/character-links/{linkId}',
      '/api/v1/player/character-links/{linkId}/revoke',
    ]);
    expect(
      // The Staff credential API (11.1) manages the Agent, not links.
      Object.keys(body.paths).filter(
        (p) =>
          /agent|confirm|verify/i.test(p) && !/\/agent-credentials/.test(p),
      ),
    ).toEqual([]);
    expect(
      Object.keys(
        body.components.schemas.CreateCharacterLinkDto.properties,
      ).sort(),
    ).toEqual(['characterExternalId', 'gameServerId']);
    const link = await requested(a);
    for (const suffix of ['confirm', 'verify', 'agent'])
      await http()
        .post(`/api/v1/player/character-links/${link.linkId}/${suffix}`)
        .auth(a.accessToken, { type: 'bearer' })
        .send({ challenge: link.challenge })
        .expect(404);
    await http()
      .get('/api/v1/player/me/characters/active/select')
      .auth(a.accessToken, { type: 'bearer' })
      .expect(404);
    expect((await row(link.linkId)).status).toBe('PENDING');
    expect(
      Number(
        (await database.query('SELECT count(*) FROM game_commands'))[0].count,
      ),
    ).toBe(0);
  });
  it('reverts only the ownership tables and reapplies cleanly', async () => {
    await database.undoLastMigration(); // Etapa 12.4 Operational Recovery
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
    await database.undoLastMigration(); // Etapa 10.7 Professions
    await database.undoLastMigration();
    expect(
      await database.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename LIKE 'player_character%'",
        [schema],
      ),
    ).toEqual([]);
    expect(await database.runMigrations()).toHaveLength(14);
    expect(await database.runMigrations()).toHaveLength(0);
    expect(
      (await database.driver.createSchemaBuilder().log()).upQueries,
    ).toEqual([]);
  });
});
