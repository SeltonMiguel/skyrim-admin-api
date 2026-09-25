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
import { playerActor, SystemSource } from '../src/actors/actor.contracts.js';
import { GameServerService } from '../src/game-bridge/game-server.service.js';
import type { GameServer } from '../src/game-bridge/entities/game-server.entity.js';
import { DiscordIdentityProvider } from '../src/player-auth/discord-identity.provider.js';
import { CharacterLinkService } from '../src/player-characters/character-link.service.js';
import { PlayerAuthRateLimiter } from '../src/player-auth/player-auth-rate-limit.js';
import { RealtimeConnectionRegistry } from '../src/realtime/realtime-connection.registry.js';
import { ChatRateLimiter } from '../src/player-chat/chat-rate-limiter.js';
import { EconomyService } from '../src/economy/economy.service.js';
import { FakeDiscordProvider } from './support/fake-discord-provider.js';
import { RealtimeTestClient } from './support/realtime-client.js';

const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;
interface Session {
  accessToken: string;
  player: { id: string };
}
interface Party {
  session: Session;
  link: string;
  char: string;
}
const DEFAULTS = {
  locale: 'pt-BR',
  timeZone: 'UTC',
  allowDirectMessages: true,
  allowTradeRequests: true,
  allowGroupInvites: true,
  allowGuildInvites: true,
  updatedAt: null,
};
const SETTINGS_KEYS = Object.keys(DEFAULTS).sort();
describeDatabase('Player settings with real PostgreSQL', () => {
  let admin: DataSource, database: DataSource, app: INestApplication<App>;
  let links: CharacterLinkService, servers: GameServerService;
  let economy: EconomyService, registry: RealtimeConnectionRegistry;
  let server: GameServer, staffToken: string, url: string;
  const discord = new FakeDiscordProvider();
  const clients: RealtimeTestClient[] = [];
  const schema = `player_settings_test_${randomUUID().replaceAll('-', '')}`;
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
    char = `char:${randomUUID()}`,
    on: GameServer = server,
  ) => {
    const actor = playerActor(session.player.id);
    const requested = await links.request(actor, {
      gameServerId: on.id,
      characterExternalId: char,
    });
    await links.confirmFromAgent({
      challenge: requested.challenge,
      gameServerId: on.id,
      characterExternalId: char,
    });
    return requested.link.id;
  };
  const party = async (session?: Session): Promise<Party> => {
    const owner = session ?? (await login());
    const char = `char:${randomUUID()}`;
    return { session: owner, link: await link(owner, char), char };
  };
  const token = (session: Session | string) =>
    typeof session === 'string' ? session : session.accessToken;
  const settings = (session: Session | string) =>
    http()
      .get('/api/v1/player/settings')
      .auth(token(session), { type: 'bearer' });
  const patch = (session: Session | string, body: object) =>
    http()
      .patch('/api/v1/player/settings')
      .auth(token(session), { type: 'bearer' })
      .send(body);
  const post = (session: Session, path: string, body: object, key = true) => {
    const call = http()
      .post(`/api/v1/player/${path}`)
      .auth(session.accessToken, { type: 'bearer' });
    return (key ? call.set('Idempotency-Key', randomUUID()) : call).send(body);
  };
  const dm = (from: Party, to: string, message = 'hi') =>
    post(from.session, `chat/direct/${encodeURIComponent(to)}`, {
      characterLinkId: from.link,
      message,
    });
  const dmHistory = (p: Party, with_: string) =>
    http()
      .get(
        `/api/v1/player/me/characters/${p.link}/chat/direct/${encodeURIComponent(with_)}`,
      )
      .auth(p.session.accessToken, { type: 'bearer' });
  const openTrade = (from: Party, to: string, gold = 0) =>
    post(from.session, 'trades', {
      actorCharacterLinkId: from.link,
      targetCharacterId: to,
      offer: { gold, items: [] },
    });
  const groupInvite = (leader: Party, groupId: string, to: string) =>
    post(
      leader.session,
      `groups/${groupId}/invites`,
      { actorCharacterLinkId: leader.link, targetCharacterId: to },
      false,
    );
  const guildInvite = (master: Party, guildId: string, to: string) =>
    post(
      master.session,
      `guilds/${guildId}/invites`,
      { actorCharacterLinkId: master.link, targetCharacterId: to },
      false,
    );
  const newGroup = async (leader: Party) =>
    (
      await post(
        leader.session,
        'groups',
        { characterLinkId: leader.link },
        false,
      ).expect(201)
    ).body.id as string;
  const newGuild = async (master: Party) =>
    (
      await post(
        master.session,
        'guilds',
        {
          characterLinkId: master.link,
          name: `Guild ${randomUUID().slice(0, 8)}`,
        },
        false,
      ).expect(201)
    ).body.id as string;
  const rows = (session: Session) =>
    database.query('SELECT * FROM player_settings WHERE player_id = $1', [
      session.player.id,
    ]);
  const audits = (session: Session) =>
    database.query(
      "SELECT action, actor_type, actor_player_id, resource_type, resource_id, metadata FROM audit_logs WHERE resource_type = 'PLAYER_SETTINGS' AND actor_player_id = $1 ORDER BY created_at",
      [session.player.id],
    );
  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => 'ok',
      (error: { driverError?: { code: string } }) => error.driverError?.code,
    );
  const connected = async (session: Session) => {
    const socket = new RealtimeTestClient(`${url}/api/v1/realtime`);
    clients.push(socket);
    await socket.authenticate('PLAYER', session.accessToken);
    return socket;
  };
  const settingsEvents = (socket: RealtimeTestClient) =>
    socket.events().filter((e) => e.type === 'PLAYER_SETTINGS_UPDATED');
  const quiet = () => new Promise((resolve) => setTimeout(resolve, 200));
  // What an unknown target gets: the blocked target must look identical.
  const unavailable = { statusCode: 404, message: 'Character not available' };
  // The comparable part of an error body (requestId, path and timestamp vary).
  const shape = (body: {
    statusCode: number;
    error: string;
    message: string;
  }) => ({
    statusCode: body.statusCode,
    error: body.error,
    message: body.message,
  });
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
    // Apply, revert (no settings) and reapply the 10.16 migration.
    expect(await database.runMigrations()).toHaveLength(24);
    await database.undoLastMigration(); // Etapa 11.3 Server Control Transport
    await database.undoLastMigration(); // Etapa 11.1 Game Agent Transport
    await database.undoLastMigration(); // Etapa 10.17 VIP Entitlements
    await database.undoLastMigration();
    expect(
      await database.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename = 'player_settings'",
        [schema],
      ),
    ).toEqual([]);
    expect(await database.runMigrations()).toHaveLength(4);
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
    const address = (
      app.getHttpServer() as unknown as Server
    ).address() as AddressInfo;
    url = `ws://127.0.0.1:${address.port}`;
    links = app.get(CharacterLinkService);
    servers = app.get(GameServerService);
    economy = app.get(EconomyService);
    registry = app.get(RealtimeConnectionRegistry);
    server = await servers.register({ code: randomUUID(), name: 'Settings' });
    const password = 'Settings-Staff-Password-42';
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
  beforeEach(() => {
    app.get(PlayerAuthRateLimiter).reset();
    app.get(ChatRateLimiter).reset();
  });
  afterEach(async () => {
    const opened = clients.splice(0);
    for (const socket of opened) if (!socket.closed) await socket.close();
    if (opened.length)
      await opened[0].until(() => registry.count() === 0 || undefined);
  });
  afterAll(async () => {
    await app?.close();
    if (database?.isInitialized) await database.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  it('adds player_settings keyed by the player with database-enforced shape', async () => {
    expect(database.options.synchronize).toBe(false);
    expect(await database.showMigrations()).toBe(false);
    expect(await database.query('SELECT * FROM migrations')).toHaveLength(24);
    const diff = await database.driver.createSchemaBuilder().log();
    expect([diff.upQueries, diff.downQueries]).toEqual([[], []]);
    const session = await login();
    const insert = (locale: string, zone: string, player = session.player.id) =>
      database.query(
        'INSERT INTO player_settings(player_id, locale, time_zone) VALUES ($1, $2, $3)',
        [player, locale, zone],
      );
    for (const [locale, zone] of [
      ['', 'UTC'],
      ['pt BR', 'UTC'],
      ['x'.repeat(36), 'UTC'],
      ['pt-BR', ''],
      ['pt-BR', '+03:00'],
      ['pt-BR', 'America/Sao Paulo'],
    ])
      expect(await code(insert(locale, zone))).toBe(
        locale.length > 35 ? '22001' : '23514',
      );
    expect(await code(insert('pt-BR', 'UTC', randomUUID()))).toBe('23503');
    expect(await rows(session)).toEqual([]);
  });
  it('returns the defaults without creating a row and requires an ACTIVE player token', async () => {
    const session = await login();
    const { body } = await settings(session).expect(200);
    expect(body).toEqual(DEFAULTS);
    expect(Object.keys(body).sort()).toEqual(SETTINGS_KEYS);
    await settings(session).expect(200);
    expect(await rows(session)).toEqual([]);
    await settings(staffToken).expect(401);
    await patch(staffToken, { locale: 'en-US' }).expect(401);
    await http().get('/api/v1/player/settings').expect(401);
    for (const status of ['SUSPENDED', 'BANNED']) {
      await database.query('UPDATE players SET status = $2 WHERE id = $1', [
        session.player.id,
        status,
      ]);
      try {
        await settings(session).expect(403);
        await patch(session, { locale: 'en-US' }).expect(403);
      } finally {
        await database.query(
          "UPDATE players SET status = 'ACTIVE' WHERE id = $1",
          [session.player.id],
        );
      }
    }
    expect(await rows(session)).toEqual([]);
  });
  it('creates on the first effective change, applies partial changes and canonicalizes values', async () => {
    const session = await login();
    // Sending the defaults is a no-op: still no row.
    expect(
      (
        await patch(session, {
          locale: 'pt-BR',
          allowGuildInvites: true,
        }).expect(200)
      ).body,
    ).toEqual(DEFAULTS);
    expect(await rows(session)).toEqual([]);
    const first = (
      await patch(session, {
        locale: 'en-us',
        timeZone: 'america/sao_paulo',
      }).expect(200)
    ).body;
    expect(first).toEqual({
      ...DEFAULTS,
      locale: 'en-US',
      timeZone: 'America/Sao_Paulo',
      updatedAt: expect.any(String),
    });
    expect(await rows(session)).toHaveLength(1);
    // Partial: only the sent field changes.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = (
      await patch(session, { allowDirectMessages: false }).expect(200)
    ).body;
    expect(second).toEqual({
      ...first,
      allowDirectMessages: false,
      updatedAt: expect.any(String),
    });
    expect(new Date(second.updatedAt).getTime()).toBeGreaterThan(
      new Date(first.updatedAt).getTime(),
    );
    const many = (
      await patch(session, {
        timeZone: 'Europe/London',
        allowTradeRequests: false,
        allowGroupInvites: false,
        allowGuildInvites: false,
      }).expect(200)
    ).body;
    expect(many).toMatchObject({
      locale: 'en-US',
      timeZone: 'Europe/London',
      allowDirectMessages: false,
      allowTradeRequests: false,
      allowGroupInvites: false,
      allowGuildInvites: false,
    });
    expect((await settings(session).expect(200)).body).toEqual(many);
    // Same values again: 200 and nothing changes, not even updatedAt.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const same = (
      await patch(session, {
        timeZone: 'europe/london',
        allowTradeRequests: false,
      }).expect(200)
    ).body;
    expect(same).toEqual(many);
    expect(await audits(session)).toHaveLength(3);
    // Settings are account-scoped: a disabled server changes nothing.
    const p = await party(session);
    await database.query(
      'UPDATE game_servers SET enabled = false WHERE id = $1',
      [server.id],
    );
    try {
      await settings(session).expect(200);
      await patch(session, { locale: 'ja-JP' }).expect(200);
    } finally {
      await database.query(
        'UPDATE game_servers SET enabled = true WHERE id = $1',
        [server.id],
      );
    }
    expect(p.link).toBeTruthy();
  });
  it('validates the body strictly', async () => {
    const session = await login();
    const p = await party(session);
    for (const body of [
      {},
      { playerId: session.player.id },
      { characterLinkId: p.link },
      { locale: 'en-US', theme: 'dark' },
      { selectedGameServerId: server.id },
      { locale: '' },
      { locale: 'zz' },
      { locale: 'pt_BR' },
      { locale: 'x'.repeat(36) },
      { locale: 'pt-BR\u0000' },
      { locale: 42 },
      { locale: null },
      { timeZone: 'Mars/Olympus_Mons' },
      { timeZone: '+03:00' },
      { timeZone: '' },
      { timeZone: null },
      { allowDirectMessages: 'false' },
      { allowTradeRequests: 0 },
      { allowGroupInvites: null },
    ])
      await patch(session, body).expect(400);
    expect((await patch(session, {}).expect(400)).body.message).toBe(
      'At least one setting is required',
    );
    expect(await rows(session)).toEqual([]);
  });
  it('audits effective changes once in the same transaction, never no-ops', async () => {
    const session = await login();
    await patch(session, { locale: 'en-US', allowGuildInvites: false }).expect(
      200,
    );
    await patch(session, { locale: 'en-US' }).expect(200);
    const trail = await audits(session);
    expect(trail).toEqual([
      {
        action: 'PLAYER_SETTINGS_UPDATED',
        actor_type: 'PLAYER',
        actor_player_id: session.player.id,
        resource_type: 'PLAYER_SETTINGS',
        resource_id: session.player.id,
        metadata: { changedFields: ['locale', 'allowGuildInvites'] },
      },
    ]);
    // The Audit fails: the change rolls back and nothing is published.
    const socket = await connected(session);
    await database.query(`
      CREATE FUNCTION fail_settings_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'PLAYER_SETTINGS_UPDATED' THEN
          RAISE EXCEPTION 'audit down';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_settings_audit BEFORE INSERT ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION fail_settings_audit();
    `);
    const fresh = await login();
    try {
      await patch(session, { timeZone: 'Europe/London' }).expect(503);
      await patch(fresh, { locale: 'en-US' }).expect(503);
    } finally {
      await database.query(`
        DROP TRIGGER fail_settings_audit ON audit_logs;
        DROP FUNCTION fail_settings_audit();
      `);
    }
    expect((await settings(session).expect(200)).body.timeZone).toBe('UTC');
    expect(await rows(fresh)).toEqual([]);
    expect(await audits(session)).toHaveLength(1);
    await quiet();
    expect(settingsEvents(socket)).toEqual([]);
  });
  it('publishes the new settings to every connection of the player only, after commit', async () => {
    const [me, other] = [await login(), await login()];
    const [first, second, stranger] = [
      await connected(me),
      await connected(me),
      await connected(other),
    ];
    const updated = (
      await patch(me, { locale: 'en-GB', allowDirectMessages: false }).expect(
        200,
      )
    ).body;
    for (const socket of [first, second])
      expect(
        (await socket.until(() => settingsEvents(socket)[0])).data,
      ).toEqual(updated);
    // No-ops and invalid requests publish nothing.
    await patch(me, { locale: 'en-GB' }).expect(200);
    await patch(me, { locale: 'zz' }).expect(400);
    await quiet();
    expect(settingsEvents(first)).toHaveLength(1);
    expect(settingsEvents(second)).toHaveLength(1);
    expect(stranger.events()).toEqual([]);
    expect(JSON.stringify(first.events())).not.toContain(me.player.id);
  });
  it('never loses concurrent partial changes, including two first changes', async () => {
    for (let round = 0; round < 5; round++) {
      const session = await login();
      // Two first PATCHes at once: one row, both fields kept.
      const results = await Promise.all([
        patch(session, { locale: 'en-US' }),
        patch(session, { allowTradeRequests: false }),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect(await rows(session)).toHaveLength(1);
      // Concurrent partial changes on an existing row.
      await Promise.all([
        patch(session, { timeZone: 'Asia/Tokyo' }),
        patch(session, { allowGroupInvites: false }),
        patch(session, { allowGuildInvites: false }),
      ]);
      expect((await settings(session).expect(200)).body).toMatchObject({
        locale: 'en-US',
        timeZone: 'Asia/Tokyo',
        allowTradeRequests: false,
        allowGroupInvites: false,
        allowGuildInvites: false,
        allowDirectMessages: true,
      });
      expect(await audits(session)).toHaveLength(5);
    }
    // The same first change twice: one row, one Audit (the second is a no-op).
    const twin = await login();
    await Promise.all([
      patch(twin, { locale: 'fr-FR' }),
      patch(twin, { locale: 'fr-FR' }),
    ]);
    expect(await rows(twin)).toHaveLength(1);
    expect(await audits(twin)).toHaveLength(1);
  });
  it('lets allowDirectMessages block new DIRECT messages from other players only', async () => {
    const [a, b] = [await party(), await party()];
    // No row: allowed.
    await dm(a, b.char, 'before').expect(201);
    expect(await rows(b.session)).toEqual([]);
    await patch(b.session, { allowDirectMessages: false }).expect(200);
    // Blocked even in the existing thread, indistinguishable from unknown.
    const blocked = await dm(a, b.char, 'blocked').expect(404);
    const unknown = await dm(a, `char:${randomUUID()}`).expect(404);
    expect(blocked.body).toMatchObject(unavailable);
    expect(Object.keys(blocked.body).sort()).toEqual(
      Object.keys(unknown.body).sort(),
    );
    expect(shape(blocked.body)).toEqual(shape(unknown.body));
    expect(JSON.stringify(shape(blocked.body))).not.toMatch(
      /setting|block|allow|direct/i,
    );
    // History stays readable by both; B can still write to A.
    for (const [p, other] of [
      [a, b.char],
      [b, a.char],
    ] as const)
      expect(
        (await dmHistory(p, other).expect(200)).body.items.map(
          (m: { message: string }) => m.message,
        ),
      ).toEqual(['before']);
    await dm(b, a.char, 'b may still write').expect(201);
    // A character of the same player is not "another player".
    const bSibling = await party(b.session);
    await dm(bSibling, b.char, 'note to self').expect(201);
    await patch(b.session, { allowDirectMessages: true }).expect(200);
    await dm(a, b.char, 'allowed again').expect(201);
  });
  it('lets allowTradeRequests block new trades while existing ones keep working', async () => {
    const [a, b, c] = [await party(), await party(), await party()];
    expect(
      await economy.creditFromSystem({
        gameServerId: server.id,
        characterExternalId: a.char,
        amount: 50,
        idempotencyKey: randomUUID(),
        source: SystemSource.AGENT,
      }),
    ).toMatchObject({ outcome: 'POSTED' });
    const existing = (await openTrade(a, b.char, 50).expect(201)).body;
    await patch(b.session, { allowTradeRequests: false }).expect(200);
    const blocked = await openTrade(c, b.char).expect(404);
    expect(blocked.body).toMatchObject(unavailable);
    expect(shape(blocked.body)).toEqual(
      shape((await openTrade(c, `char:${randomUUID()}`).expect(404)).body),
    );
    // The existing trade is still visible, negotiable and completes.
    await http()
      .get(
        `/api/v1/player/trades/${existing.tradeId}?characterLinkId=${b.link}`,
      )
      .auth(b.session.accessToken, { type: 'bearer' })
      .expect(200);
    await post(b.session, `trades/${existing.tradeId}/accept`, {
      characterLinkId: b.link,
      counterpartyOfferVersion: 1,
    }).expect(200);
    const done = await post(a.session, `trades/${existing.tradeId}/accept`, {
      characterLinkId: a.link,
      counterpartyOfferVersion: 1,
    }).expect(200);
    expect(done.body.status).toBe('COMPLETED');
    // B may still open trades with others; A (no row) still receives them.
    await openTrade(b, a.char).expect(201);
    await openTrade(c, a.char).expect(201);
  });
  it('lets allowGroupInvites block new group invites while pending ones stay valid', async () => {
    const [leader, other, target] = [
      await party(),
      await party(),
      await party(),
    ];
    const [g1, g2] = [await newGroup(leader), await newGroup(other)];
    const pending = (await groupInvite(leader, g1, target.char).expect(201))
      .body;
    await patch(target.session, { allowGroupInvites: false }).expect(200);
    const blocked = await groupInvite(other, g2, target.char).expect(404);
    expect(blocked.body).toMatchObject(unavailable);
    expect(shape(blocked.body)).toEqual(
      shape(
        (await groupInvite(other, g2, `char:${randomUUID()}`).expect(404)).body,
      ),
    );
    const joined = await post(
      target.session,
      `group-invites/${pending.inviteId}/accept`,
      {},
      false,
    ).expect(200);
    expect(
      joined.body.members.map((m: { characterId: string }) => m.characterId),
    ).toContain(target.char);
    // Turning it off later does not touch the membership.
    expect(
      (
        await http()
          .get(`/api/v1/player/groups/${g1}`)
          .auth(target.session.accessToken, { type: 'bearer' })
          .expect(200)
      ).body.id,
    ).toBe(g1);
  });
  it('lets allowGuildInvites block new guild invites while pending ones stay valid', async () => {
    const [master, other, target] = [
      await party(),
      await party(),
      await party(),
    ];
    const [g1, g2] = [await newGuild(master), await newGuild(other)];
    const pending = (await guildInvite(master, g1, target.char).expect(201))
      .body;
    await patch(target.session, { allowGuildInvites: false }).expect(200);
    const blocked = await guildInvite(other, g2, target.char).expect(404);
    expect(blocked.body).toMatchObject(unavailable);
    expect(shape(blocked.body)).toEqual(
      shape(
        (await guildInvite(other, g2, `char:${randomUUID()}`).expect(404)).body,
      ),
    );
    const joined = await post(
      target.session,
      `guild-invites/${pending.inviteId}/accept`,
      { characterLinkId: target.link },
      false,
    ).expect(200);
    expect(
      joined.body.members.map((m: { characterId: string }) => m.characterId),
    ).toContain(target.char);
    // Other flags are independent: DMs and trades still reach the target.
    const sender = await party();
    await dm(sender, target.char).expect(201);
    await openTrade(sender, target.char).expect(201);
  });
  it('applies the settings of whoever currently owns the character', async () => {
    const owner = await login();
    const [x, y] = [await party(owner), await party(owner)];
    const sender = await party();
    await patch(owner, {
      allowDirectMessages: false,
      allowTradeRequests: false,
    }).expect(200);
    // One account setting covers every character of the player.
    for (const target of [x.char, y.char]) {
      await dm(sender, target).expect(404);
      await openTrade(sender, target).expect(404);
    }
    // X moves to another player without settings: the defaults apply to X.
    await links.revoke(playerActor(owner.player.id), x.link);
    const heir = await login();
    await link(heir, x.char);
    await dm(sender, x.char, 'to the new owner').expect(201);
    await openTrade(sender, x.char).expect(201);
    await dm(sender, y.char).expect(404);
    expect(await rows(heir)).toEqual([]);
  });
  it('refuses to revert while settings exist', async () => {
    // No credentials or entitlements here: 11.3, 11.1 and 10.17 revert, then 10.16
    // refuses and is kept.
    await database.undoLastMigration(); // Etapa 11.3 Server Control Transport
    await database.undoLastMigration();
    await database.undoLastMigration();
    await expect(database.undoLastMigration()).rejects.toThrow(
      'player settings exist',
    );
    expect(await database.runMigrations()).toHaveLength(3);
    expect(await database.showMigrations()).toBe(false);
    expect(await database.query('SELECT * FROM migrations')).toHaveLength(24);
  });
});
