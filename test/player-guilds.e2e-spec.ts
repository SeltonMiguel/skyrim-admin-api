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
import type { GameServer } from '../src/game-bridge/entities/game-server.entity.js';
import { DiscordIdentityProvider } from '../src/player-auth/discord-identity.provider.js';
import { CharacterLinkService } from '../src/player-characters/character-link.service.js';
import { PlayerAuthRateLimiter } from '../src/player-auth/player-auth-rate-limit.js';
import { RealtimeConnectionRegistry } from '../src/realtime/realtime-connection.registry.js';
import { MAX_GUILD_MEMBERS } from '../src/player-guilds/player-guild.contracts.js';
import { FakeDiscordProvider } from './support/fake-discord-provider.js';
import { RealtimeTestClient } from './support/realtime-client.js';

const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;
interface Session {
  accessToken: string;
  player: { id: string };
}
interface Member {
  memberId: string;
  characterId: string;
  characterLinkId: string | null;
  role: string;
}
describeDatabase('Player guilds with real PostgreSQL', () => {
  let admin: DataSource, database: DataSource, app: INestApplication<App>;
  let links: CharacterLinkService, servers: GameServerService;
  let registry: RealtimeConnectionRegistry;
  let server: GameServer, staffToken: string, url: string;
  const discord = new FakeDiscordProvider();
  const clients: RealtimeTestClient[] = [];
  // Test-side map from a link to its public game id (what a real inviter knows).
  const characterIds = new Map<string, string>();
  const schema = `player_guilds_test_${randomUUID().replaceAll('-', '')}`;
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
  // Returns an ownership link in the requested state (internal setup).
  const character = async (
    session: Session,
    state: 'PENDING' | 'VERIFIED' | 'REVOKED' = 'VERIFIED',
    on: GameServer = server,
    characterExternalId = `char:${randomUUID()}`,
  ) => {
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
    characterIds.set(requested.link.id, characterExternalId);
    return requested.link.id;
  };
  const post = (session: Session | string, path: string, body: object = {}) =>
    http()
      .post(`/api/v1/player/${path}`)
      .auth(typeof session === 'string' ? session : session.accessToken, {
        type: 'bearer',
      })
      .send(body);
  const get = (session: Session, path: string) =>
    http()
      .get(`/api/v1/player/${path}`)
      .auth(session.accessToken, { type: 'bearer' });
  const uniqueName = () => `Guild ${randomUUID().slice(0, 8)}`;
  const create = async (session: Session, link: string, name = uniqueName()) =>
    (await post(session, 'guilds', { characterLinkId: link, name }).expect(201))
      .body;
  const detail = (session: Session, guildId: string, link: string) =>
    get(session, `guilds/${guildId}?characterLinkId=${link}`);
  const invite = (
    session: Session,
    guildId: string,
    actor: string,
    target: string,
  ) =>
    post(session, `guilds/${guildId}/invites`, {
      actorCharacterLinkId: actor,
      targetCharacterId: characterIds.get(target) ?? `char:${randomUUID()}`,
    });
  const accept = (session: Session, inviteId: string, link: string) =>
    post(session, `guild-invites/${inviteId}/accept`, {
      characterLinkId: link,
    });
  const decline = (session: Session, inviteId: string, link: string) =>
    post(session, `guild-invites/${inviteId}/decline`, {
      characterLinkId: link,
    });
  const memberAction = (
    session: Session,
    guildId: string,
    memberId: string,
    action: 'kick' | 'transfer-master' | 'role',
    actor: string,
    role?: string,
  ) =>
    post(session, `guilds/${guildId}/members/${memberId}/${action}`, {
      actorCharacterLinkId: actor,
      ...(role ? { role } : {}),
    });
  const disband = (session: Session, guildId: string, actor: string) =>
    post(session, `guilds/${guildId}/disband`, { actorCharacterLinkId: actor });
  const leave = (session: Session, guildId: string, link: string) =>
    post(session, `guilds/${guildId}/leave`, { characterLinkId: link });
  const memberOf = (view: { members: Member[] }, link: string) =>
    view.members.find((m) => m.characterLinkId === link)!;
  // A guild whose MASTER is `master`, with `extra` accepted MEMBERs.
  const guildWith = async (extra: number, name?: string) => {
    const master = await login();
    const masterLink = await character(master);
    const guild = await create(master, masterLink, name);
    const members: { session: Session; link: string; memberId: string }[] = [];
    for (let i = 0; i < extra; i++) {
      const session = await login();
      const link = await character(session);
      const invited = (
        await invite(master, guild.id, masterLink, link).expect(201)
      ).body;
      const joined = (await accept(session, invited.inviteId, link).expect(200))
        .body;
      members.push({
        session,
        link,
        memberId: memberOf(joined, link).memberId,
      });
    }
    return { master, masterLink, guild, members };
  };
  // Character identities without any owner: memberships need no link.
  const fill = (guildId: string, count: number) =>
    database.query(
      "INSERT INTO player_guild_members(guild_id, game_server_id, character_external_id, role, joined_at) SELECT $1, $2, 'filler:' || gen_random_uuid(), 'MEMBER', now() FROM generate_series(1, $3)",
      [guildId, server.id, count],
    );
  const audits = (guildId: string) =>
    database.query(
      'SELECT action, actor_type, actor_player_id, actor_role, resource_type, metadata FROM audit_logs WHERE resource_id = $1 ORDER BY created_at, action',
      [guildId],
    );
  const actions = async (guildId: string) =>
    (await audits(guildId)).map((e: { action: string }) => e.action);
  const activeMembers = async (guildId: string) =>
    (
      await database.query(
        'SELECT count(*)::int AS n FROM player_guild_members WHERE guild_id = $1 AND left_at IS NULL',
        [guildId],
      )
    )[0].n;
  const masters = async (guildId: string) =>
    (
      await database.query(
        "SELECT count(*)::int AS n FROM player_guild_members WHERE guild_id = $1 AND left_at IS NULL AND role = 'MASTER'",
        [guildId],
      )
    )[0].n;
  const inviteStatus = async (inviteId: string) =>
    (
      await database.query(
        'SELECT status FROM player_guild_invites WHERE id = $1',
        [inviteId],
      )
    )[0].status;
  const connected = async (session: Session) => {
    const socket = new RealtimeTestClient(`${url}/api/v1/realtime`);
    clients.push(socket);
    expect(
      await socket.authenticate('PLAYER', session.accessToken),
    ).toMatchObject({ type: 'AUTHENTICATED' });
    return socket;
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
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
    expect(await database.runMigrations()).toHaveLength(18);
    await database.undoLastMigration();
    expect(await database.runMigrations()).toHaveLength(1);
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
    registry = app.get(RealtimeConnectionRegistry);
    server = await servers.register({ code: randomUUID(), name: 'Guilds' });
    const password = 'Guilds-Staff-Password-42';
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
  beforeEach(() => app.get(PlayerAuthRateLimiter).reset());
  afterEach(async () => {
    const open = clients.splice(0);
    for (const socket of open) if (!socket.closed) await socket.close();
    if (open.length)
      await open[0].until(() => registry.count() === 0 || undefined);
  });
  afterAll(async () => {
    await app?.close();
    if (database?.isInitialized) await database.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  it('adds the three guild tables with database-enforced identity invariants', async () => {
    expect(database.options.synchronize).toBe(false);
    expect(await database.showMigrations()).toBe(false);
    expect(await database.query('SELECT * FROM migrations')).toHaveLength(18);
    const diff = await database.driver.createSchemaBuilder().log();
    expect([diff.upQueries, diff.downQueries]).toEqual([[], []]);
    const other = await servers.register({ code: randomUUID(), name: 'Other' });
    const guild = async (key: string, on = server.id) =>
      (
        await database.query(
          'INSERT INTO player_guilds(game_server_id, name, name_key) VALUES ($1, $2, $3) RETURNING id',
          [on, key, key],
        )
      )[0].id;
    const code = (promise: Promise<unknown>) =>
      promise.then(
        () => 'ok',
        (error: { driverError: { code: string } }) => error.driverError.code,
      );
    const key = `key ${randomUUID()}`;
    const [g1, g2] = [await guild(key), await guild(`${key} 2`)];
    expect(await code(guild(key))).toBe('23505');
    expect(await code(guild(key, other.id))).toBe('ok');
    expect(await code(guild('ab'))).toBe('23514');
    expect(await code(guild(' abc'))).toBe('23514');
    const member = (
      guildId: string,
      character: string,
      role: string,
      on = server.id,
    ) =>
      database.query(
        'INSERT INTO player_guild_members(guild_id, game_server_id, character_external_id, role, joined_at) VALUES ($1, $2, $3, $4, now())',
        [guildId, on, character, role],
      );
    await member(g1, 'char:x', 'MASTER');
    // One active membership per character identity, one MASTER per guild,
    // members pinned to the guild's own server, closed roles.
    expect(await code(member(g2, 'char:x', 'MEMBER'))).toBe('23505');
    expect(await code(member(g1, 'char:y', 'MASTER'))).toBe('23505');
    expect(await code(member(g1, 'char:y', 'MEMBER', other.id))).toBe('23503');
    expect(await code(member(g1, 'char:y', 'LEADER'))).toBe('23514');
    expect(await code(member(g1, ' ', 'MEMBER'))).toBe('23514');
    expect(await code(member(g2, 'char:x', 'MEMBER', other.id))).toBe('23503');
    await database.query(
      "UPDATE player_guild_members SET left_at = now() WHERE guild_id = $1 AND character_external_id = 'char:x'",
      [g1],
    );
    expect(await code(member(g2, 'char:x', 'MASTER'))).toBe('ok');
    expect(
      await code(
        database.query(
          "UPDATE player_guilds SET status = 'DISBANDED' WHERE id = $1",
          [g1],
        ),
      ),
    ).toBe('23514');
    await database.query(
      "UPDATE player_guilds SET status = 'DISBANDED', disbanded_at = now() WHERE id = $1",
      [g1],
    );
    // A disbanded guild frees its name for reuse on the server.
    expect(await code(guild(key))).toBe('ok');
    const pendingInvite = (on = server.id, target = 'char:t') =>
      database.query(
        "INSERT INTO player_guild_invites(guild_id, game_server_id, target_character_external_id, invited_by_character_external_id, expires_at) VALUES ($1, $2, $3, 'char:x', now() + interval '1 day')",
        [g2, on, target],
      );
    await pendingInvite();
    expect(await code(pendingInvite())).toBe('23505');
    expect(await code(pendingInvite(other.id, 'char:u'))).toBe('23503');
    expect(
      await code(
        database.query(
          "UPDATE player_guild_invites SET status = 'ACCEPTED' WHERE guild_id = $1",
          [g2],
        ),
      ),
    ).toBe('23514');
  });
  it('creates a guild with its MASTER atomically, audits it and shows it by character', async () => {
    const master = await login();
    const link = await character(master);
    expect(
      (await get(master, `me/characters/${link}/guild`).expect(200)).body,
    ).toEqual({ guild: null });
    const created = await post(master, 'guilds', {
      characterLinkId: link,
      name: '  Os Companheiros  ',
    }).expect(201);
    expect(created.body).toEqual({
      id: expect.any(String),
      gameServer: {
        id: server.id,
        code: server.code,
        name: server.name,
        enabled: true,
      },
      name: 'Os Companheiros',
      status: 'ACTIVE',
      members: [
        {
          memberId: expect.any(String),
          characterId: characterIds.get(link),
          characterLinkId: link,
          role: 'MASTER',
          joinedAt: expect.any(String),
        },
      ],
      createdAt: expect.any(String),
    });
    expect(
      (await detail(master, created.body.id, link).expect(200)).body,
    ).toEqual(created.body);
    expect(
      (await get(master, `me/characters/${link}/guild`).expect(200)).body,
    ).toEqual({ guild: created.body });
    // One active guild per character.
    expect(
      (
        await post(master, 'guilds', {
          characterLinkId: link,
          name: uniqueName(),
        }).expect(409)
      ).body.message,
    ).toBe('Character already in a guild');
    const [entry] = await audits(created.body.id);
    expect(entry).toMatchObject({
      action: 'PLAYER_GUILD_CREATED',
      actor_type: 'PLAYER',
      actor_player_id: master.player.id,
      actor_role: null,
      resource_type: 'PLAYER_GUILD',
    });
    expect(entry.metadata).toEqual({
      guildId: created.body.id,
      gameServerId: server.id,
      actorCharacterId: characterIds.get(link),
      memberId: created.body.members[0].memberId,
      name: 'Os Companheiros',
      role: 'MASTER',
    });
    const fresh = await character(master);
    for (const body of [
      {},
      { characterLinkId: fresh },
      { characterLinkId: 'x', name: uniqueName() },
      { characterLinkId: fresh, name: 'ab' },
      { characterLinkId: fresh, name: '  ab  ' },
      { characterLinkId: fresh, name: 'x'.repeat(49) },
      { characterLinkId: fresh, name: 'bad\u0000name' },
      { characterLinkId: fresh, name: 'bad\nname' },
      { characterLinkId: fresh, name: 'zero​width' },
      { characterLinkId: fresh, name: '\ud800abc' },
      { characterLinkId: fresh, name: 123 },
      { characterLinkId: fresh, name: uniqueName(), playerId: randomUUID() },
      { characterLinkId: fresh, name: uniqueName(), gameServerId: server.id },
    ])
      await post(master, 'guilds', body).expect(400);
    await post(staffToken, 'guilds', {
      characterLinkId: fresh,
      name: uniqueName(),
    }).expect(401);
    await detail(master, created.body.id, 'x').expect(400);
    await get(master, `guilds/${created.body.id}`).expect(400);
    const long = await create(master, fresh, 'ç'.repeat(48));
    expect(long.name).toBe('ç'.repeat(48));
  });
  it('keeps names unique per server, case- and width-insensitively, and reusable after disband', async () => {
    const a = await login();
    const name = `Companhia ${randomUUID().slice(0, 6)}`;
    const aLink = await character(a);
    const guild = await create(a, aLink, name);
    for (const variant of [
      name.toUpperCase(),
      name.toLowerCase(),
      name.replace(' ', '   '),
      name.replace('C', 'Ｃ'),
    ])
      expect(
        (
          await post(a, 'guilds', {
            characterLinkId: await character(a),
            name: variant,
          }).expect(409)
        ).body.message,
      ).toBe('Guild name unavailable');
    const other = await servers.register({ code: randomUUID(), name: 'Other' });
    const elsewhere = await create(
      a,
      await character(a, 'VERIFIED', other),
      name,
    );
    expect(elsewhere.gameServer.id).toBe(other.id);
    await disband(a, guild.id, aLink).expect(200);
    const reused = await create(a, await character(a), name.toUpperCase());
    expect(reused.name).toBe(name.toUpperCase());
    expect(reused.id).not.toBe(guild.id);
  });
  it('requires an own VERIFIED character: PENDING, REVOKED and foreign links give 404', async () => {
    const a = await login();
    const b = await login();
    for (const link of [
      await character(a, 'PENDING'),
      await character(a, 'REVOKED'),
      await character(b),
      randomUUID(),
    ]) {
      expect(
        (
          await post(a, 'guilds', {
            characterLinkId: link,
            name: uniqueName(),
          }).expect(404)
        ).body.message,
      ).toBe('Character not found');
      await get(a, `me/characters/${link}/guild`).expect(404);
      await get(a, `guild-invites?characterLinkId=${link}`).expect(404);
    }
    const off = await servers.register({ code: randomUUID(), name: 'Off' });
    const offLink = await character(a, 'VERIFIED', off);
    await database.query(
      'UPDATE game_servers SET enabled = false WHERE id = $1',
      [off.id],
    );
    await post(a, 'guilds', {
      characterLinkId: offLink,
      name: uniqueName(),
    }).expect(409);
  });
  it('shows details only to current members and hides other players', async () => {
    const { master, masterLink, guild, members } = await guildWith(2);
    const view = (
      await detail(members[0].session, guild.id, members[0].link).expect(200)
    ).body;
    expect(view.members.map((m: Member) => m.role)).toEqual([
      'MASTER',
      'MEMBER',
      'MEMBER',
    ]);
    expect(view.members.filter((m: Member) => m.characterLinkId)).toEqual([
      expect.objectContaining({ characterLinkId: members[0].link }),
    ]);
    for (const m of view.members)
      expect(Object.keys(m).sort()).toEqual([
        'characterId',
        'characterLinkId',
        'joinedAt',
        'memberId',
        'role',
      ]);
    const text = JSON.stringify(view);
    for (const secret of [
      masterLink,
      members[1].link,
      master.player.id,
      members[0].session.player.id,
    ])
      expect(text).not.toContain(secret);
    expect(text).not.toMatch(/playerId|providerSubject/);
    const outsider = await login();
    const outsiderLink = await character(outsider);
    await detail(outsider, guild.id, outsiderLink).expect(404);
    // A member's link used by someone else, or another own character: 404.
    await detail(outsider, guild.id, members[0].link).expect(404);
    await detail(master, guild.id, await character(master)).expect(404);
    await detail(master, randomUUID(), masterLink).expect(404);
  });
  it('lets MASTER and OFFICER invite idempotently while MEMBER and outsiders cannot', async () => {
    const { master, masterLink, guild, members } = await guildWith(2);
    const [officer, member] = members;
    await memberAction(
      master,
      guild.id,
      officer.memberId,
      'role',
      masterLink,
      'OFFICER',
    ).expect(200);
    const [t1, t2, t3] = [await login(), await login(), await login()];
    const [l1, l2, l3] = [
      await character(t1),
      await character(t2),
      await character(t3),
    ];
    const first = await invite(master, guild.id, masterLink, l1).expect(201);
    expect(first.body).toEqual({
      inviteId: expect.any(String),
      guildId: guild.id,
      guildName: guild.name,
      gameServerId: server.id,
      targetCharacterId: characterIds.get(l1),
      invitedByCharacterId: characterIds.get(masterLink),
      status: 'PENDING',
      expiresAt: expect.any(String),
      createdAt: expect.any(String),
      respondedAt: null,
    });
    // Default TTL: 7 days.
    const ttl =
      Date.parse(first.body.expiresAt) - Date.parse(first.body.createdAt);
    expect(ttl).toBe(7 * 86400 * 1000);
    const again = await invite(master, guild.id, masterLink, l1).expect(200);
    expect(again.body).toEqual(first.body);
    // Idempotent even when repeated by another inviter.
    expect(
      (await invite(officer.session, guild.id, officer.link, l1).expect(200))
        .body,
    ).toEqual(first.body);
    const byOfficer = (
      await invite(officer.session, guild.id, officer.link, l2).expect(201)
    ).body;
    expect(byOfficer.invitedByCharacterId).toBe(characterIds.get(officer.link));
    expect(
      (await invite(member.session, guild.id, member.link, l3).expect(403)).body
        .message,
    ).toBe('Guild role does not allow this');
    await invite(t3, guild.id, l3, l1).expect(404);
    await invite(master, guild.id, member.link, l3).expect(404);
    expect(
      (await actions(guild.id)).filter(
        (a: string) => a === 'PLAYER_GUILD_INVITED',
      ),
    ).toHaveLength(4);
    // Two from the setup plus l1 and l2: repeats added none.
    // Target must be VERIFIED on the guild server and not already guilded.
    const other = await servers.register({ code: randomUUID(), name: 'Other' });
    const misses = [
      await character(t3, 'PENDING'),
      await character(t3, 'REVOKED'),
      await character(t3, 'VERIFIED', other),
      randomUUID(),
    ];
    for (const target of misses)
      expect(
        (await invite(master, guild.id, masterLink, target).expect(404)).body
          .message,
      ).toBe('Character not available');
    expect(
      (await invite(master, guild.id, masterLink, member.link).expect(409)).body
        .message,
    ).toBe('Character already in this guild');
    const elsewhere = await guildWith(0);
    expect(
      (
        await invite(master, guild.id, masterLink, elsewhere.masterLink).expect(
          409,
        )
      ).body.message,
    ).toBe('Character unavailable');
    const path = `guilds/${guild.id}/invites`;
    for (const body of [
      { actorCharacterLinkId: masterLink, targetCharacterLinkId: l3 },
      {
        actorCharacterLinkId: masterLink,
        targetCharacterId: characterIds.get(l3),
        targetPlayerId: t3.player.id,
      },
      {
        actorCharacterLinkId: masterLink,
        targetCharacterId: characterIds.get(l3),
        gameServerId: server.id,
      },
      { actorCharacterLinkId: masterLink, targetCharacterId: '' },
      { actorCharacterLinkId: masterLink, targetCharacterId: 'x'.repeat(129) },
      { actorCharacterLinkId: masterLink, targetCharacterId: 'a\u0000b' },
      { targetCharacterId: characterIds.get(l3) },
    ])
      await post(master, path, body).expect(400);
    for (const text of [JSON.stringify(first.body), JSON.stringify(byOfficer)])
      for (const secret of [l1, masterLink, t1.player.id, master.player.id])
        expect(text).not.toContain(secret);
  });
  it('accepts and declines only through the target character, cancelling its other invites', async () => {
    const [g1, g2, g3] = [
      await guildWith(0),
      await guildWith(0),
      await guildWith(0),
    ];
    const target = await login();
    const targetLink = await character(target);
    const otherOwn = await character(target);
    const [i1, i2, i3] = [
      (
        await invite(g1.master, g1.guild.id, g1.masterLink, targetLink).expect(
          201,
        )
      ).body,
      (
        await invite(g2.master, g2.guild.id, g2.masterLink, targetLink).expect(
          201,
        )
      ).body,
      (
        await invite(g3.master, g3.guild.id, g3.masterLink, targetLink).expect(
          201,
        )
      ).body,
    ];
    const listed = (
      await get(target, `guild-invites?characterLinkId=${targetLink}`).expect(
        200,
      )
    ).body.items;
    expect(listed.map((i: { inviteId: string }) => i.inviteId)).toEqual([
      i1.inviteId,
      i2.inviteId,
      i3.inviteId,
    ]);
    expect(listed[0]).toEqual(i1);
    expect(
      (
        await get(target, `guild-invites?characterLinkId=${otherOwn}`).expect(
          200,
        )
      ).body.items,
    ).toEqual([]);
    await get(target, 'guild-invites').expect(400);
    // Wrong own character, a stranger, or the inviter: same 404.
    const stranger = await login();
    await accept(target, i1.inviteId, otherOwn).expect(404);
    await accept(stranger, i1.inviteId, await character(stranger)).expect(404);
    await accept(stranger, i1.inviteId, targetLink).expect(404);
    await decline(g1.master, i1.inviteId, g1.masterLink).expect(404);
    await accept(target, randomUUID(), targetLink).expect(404);
    const declined = await decline(target, i3.inviteId, targetLink).expect(200);
    expect(declined.body).toMatchObject({
      inviteId: i3.inviteId,
      status: 'DECLINED',
      respondedAt: expect.any(String),
    });
    await accept(target, i3.inviteId, targetLink).expect(409);
    const joined = (await accept(target, i1.inviteId, targetLink).expect(200))
      .body;
    expect(joined.id).toBe(g1.guild.id);
    expect(memberOf(joined, targetLink).role).toBe('MEMBER');
    expect(await inviteStatus(i1.inviteId)).toBe('ACCEPTED');
    expect(await inviteStatus(i2.inviteId)).toBe('CANCELLED');
    expect(await inviteStatus(i3.inviteId)).toBe('DECLINED');
    expect(
      (await accept(target, i2.inviteId, targetLink).expect(409)).body.message,
    ).toBe('Guild invite no longer pending');
    expect(
      (await get(target, `me/characters/${targetLink}/guild`).expect(200)).body
        .guild.id,
    ).toBe(g1.guild.id);
    const [acceptedAudit] = (await audits(g1.guild.id)).filter(
      (e: { action: string }) => e.action === 'PLAYER_GUILD_INVITE_ACCEPTED',
    );
    expect(acceptedAudit.metadata).toMatchObject({
      inviteId: i1.inviteId,
      actorCharacterId: characterIds.get(targetLink),
      cancelledInvites: 1,
    });
    expect(await actions(g3.guild.id)).toContain(
      'PLAYER_GUILD_INVITE_DECLINED',
    );
    for (const body of [
      {},
      { characterLinkId: 'x' },
      { characterLinkId: targetLink, playerId: 'p' },
    ])
      await post(target, `guild-invites/${i2.inviteId}/accept`, body).expect(
        400,
      );
  });
  it('expires stale invites lazily and lets a fresh one be issued', async () => {
    const { master, masterLink, guild } = await guildWith(0);
    const target = await login();
    const targetLink = await character(target);
    const stale = (
      await invite(master, guild.id, masterLink, targetLink).expect(201)
    ).body;
    await database.query(
      "UPDATE player_guild_invites SET created_at = now() - interval '8 days', expires_at = now() - interval '1 second' WHERE id = $1",
      [stale.inviteId],
    );
    expect(
      (
        await get(target, `guild-invites?characterLinkId=${targetLink}`).expect(
          200,
        )
      ).body.items,
    ).toEqual([]);
    expect(
      (await accept(target, stale.inviteId, targetLink).expect(409)).body
        .message,
    ).toBe('Guild invite expired');
    expect(await inviteStatus(stale.inviteId)).toBe('EXPIRED');
    const fresh = (
      await invite(master, guild.id, masterLink, targetLink).expect(201)
    ).body;
    expect(fresh.inviteId).not.toBe(stale.inviteId);
    // An expired pending invite is materialized when re-inviting.
    await database.query(
      "UPDATE player_guild_invites SET created_at = now() - interval '8 days', expires_at = now() - interval '1 second' WHERE id = $1",
      [fresh.inviteId],
    );
    const third = (
      await invite(master, guild.id, masterLink, targetLink).expect(201)
    ).body;
    expect(await inviteStatus(fresh.inviteId)).toBe('EXPIRED');
    await decline(target, third.inviteId, targetLink).expect(200);
    await database.query(
      "UPDATE player_guild_invites SET created_at = now() - interval '8 days', expires_at = now() - interval '1 second', status = 'PENDING', responded_at = NULL WHERE id = $1",
      [third.inviteId],
    );
    expect(
      (await decline(target, third.inviteId, targetLink).expect(409)).body
        .message,
    ).toBe('Guild invite expired');
  });
  it('caps a guild at 50 active members at invite and accept', async () => {
    const { master, masterLink, guild } = await guildWith(0);
    const early = await login();
    const earlyLink = await character(early);
    const pending = (
      await invite(master, guild.id, masterLink, earlyLink).expect(201)
    ).body;
    await fill(guild.id, MAX_GUILD_MEMBERS - 1);
    expect(await activeMembers(guild.id)).toBe(50);
    const late = await login();
    expect(
      (
        await invite(
          master,
          guild.id,
          masterLink,
          await character(late),
        ).expect(409)
      ).body.message,
    ).toBe('Guild full');
    // A pending invite issued earlier cannot overflow the guild either.
    expect(
      (await accept(early, pending.inviteId, earlyLink).expect(409)).body
        .message,
    ).toBe('Guild full');
    const full = (await detail(master, guild.id, masterLink).expect(200)).body;
    expect(full.members).toHaveLength(50);
    expect(full.members.filter((m: Member) => m.characterLinkId)).toHaveLength(
      1,
    );
    expect(MAX_GUILD_MEMBERS).toBe(50);
  });
  it('enforces role boundaries, promote/demote and master transfer', async () => {
    const { master, masterLink, guild, members } = await guildWith(3);
    const [a, b, c] = members;
    const promoted = (
      await memberAction(
        master,
        guild.id,
        a.memberId,
        'role',
        masterLink,
        'OFFICER',
      ).expect(200)
    ).body;
    expect(memberOf(promoted, masterLink).role).toBe('MASTER');
    expect(
      promoted.members.find((m: Member) => m.memberId === a.memberId).role,
    ).toBe('OFFICER');
    // Same role again is a no-op without Audit.
    await memberAction(
      master,
      guild.id,
      a.memberId,
      'role',
      masterLink,
      'OFFICER',
    ).expect(200);
    expect(
      (await actions(guild.id)).filter(
        (x: string) => x === 'PLAYER_GUILD_MEMBER_ROLE_CHANGED',
      ),
    ).toHaveLength(1);
    const masterMember = memberOf(promoted, masterLink).memberId;
    // MASTER is never changed through the role endpoint; MASTER is no role input.
    await memberAction(
      master,
      guild.id,
      masterMember,
      'role',
      masterLink,
      'MEMBER',
    ).expect(400);
    await memberAction(
      master,
      guild.id,
      b.memberId,
      'role',
      masterLink,
      'MASTER',
    ).expect(400);
    await memberAction(
      master,
      guild.id,
      b.memberId,
      'role',
      masterLink,
      'LEADER',
    ).expect(400);
    // OFFICER: invite only.
    for (const response of [
      memberAction(a.session, guild.id, c.memberId, 'kick', a.link),
      memberAction(a.session, guild.id, b.memberId, 'role', a.link, 'OFFICER'),
      memberAction(a.session, guild.id, a.memberId, 'transfer-master', a.link),
      disband(a.session, guild.id, a.link),
    ])
      await response.expect(403);
    // MEMBER: read and leave only.
    for (const response of [
      memberAction(b.session, guild.id, c.memberId, 'kick', b.link),
      memberAction(b.session, guild.id, c.memberId, 'role', b.link, 'OFFICER'),
      memberAction(b.session, guild.id, b.memberId, 'transfer-master', b.link),
      disband(b.session, guild.id, b.link),
    ])
      await response.expect(403);
    await detail(b.session, guild.id, b.link).expect(200);
    const demoted = (
      await memberAction(
        master,
        guild.id,
        a.memberId,
        'role',
        masterLink,
        'MEMBER',
      ).expect(200)
    ).body;
    expect(
      demoted.members.find((m: Member) => m.memberId === a.memberId).role,
    ).toBe('MEMBER');
    // The MASTER cannot leave directly, nor kick or transfer to itself.
    expect(
      (await leave(master, guild.id, masterLink).expect(409)).body.message,
    ).toBe('Guild master must transfer mastership or disband the guild');
    await memberAction(
      master,
      guild.id,
      masterMember,
      'kick',
      masterLink,
    ).expect(400);
    await memberAction(
      master,
      guild.id,
      masterMember,
      'transfer-master',
      masterLink,
    ).expect(400);
    await memberAction(
      master,
      guild.id,
      randomUUID(),
      'transfer-master',
      masterLink,
    ).expect(404);
    const transferred = (
      await memberAction(
        master,
        guild.id,
        b.memberId,
        'transfer-master',
        masterLink,
      ).expect(200)
    ).body;
    expect(memberOf(transferred, masterLink).role).toBe('OFFICER');
    expect(
      transferred.members.find((m: Member) => m.memberId === b.memberId).role,
    ).toBe('MASTER');
    expect(await masters(guild.id)).toBe(1);
    // Old master is now an OFFICER: can invite, cannot manage.
    await memberAction(master, guild.id, c.memberId, 'kick', masterLink).expect(
      403,
    );
    const outsider = await login();
    await invite(
      master,
      guild.id,
      masterLink,
      await character(outsider),
    ).expect(201);
    // New master has full permissions and the old one may now leave.
    await memberAction(
      b.session,
      guild.id,
      a.memberId,
      'role',
      b.link,
      'OFFICER',
    ).expect(200);
    await memberAction(b.session, guild.id, c.memberId, 'kick', b.link).expect(
      200,
    );
    await leave(master, guild.id, masterLink).expect(200);
    await leave(b.session, guild.id, b.link).expect(409);
    const [transferAudit] = (await audits(guild.id)).filter(
      (e: { action: string }) => e.action === 'PLAYER_GUILD_MASTER_TRANSFERRED',
    );
    expect(transferAudit.metadata).toEqual({
      guildId: guild.id,
      gameServerId: server.id,
      actorCharacterId: characterIds.get(masterLink),
      memberId: b.memberId,
      targetCharacterId: characterIds.get(b.link),
      previousRole: 'MEMBER',
      previousMasterMemberId: masterMember,
      role: 'MASTER',
    });
  });
  it('handles leave, kick and disband keeping all history', async () => {
    const { master, masterLink, guild, members } = await guildWith(3);
    const [a, b, c] = members;
    const left = (await leave(a.session, guild.id, a.link).expect(200)).body;
    expect(left).toEqual({
      guildId: guild.id,
      memberId: a.memberId,
      leftAt: expect.any(String),
    });
    await detail(a.session, guild.id, a.link).expect(404);
    expect(
      (await get(a.session, `me/characters/${a.link}/guild`).expect(200)).body,
    ).toEqual({ guild: null });
    await leave(a.session, guild.id, a.link).expect(404);
    const kicked = (
      await memberAction(
        master,
        guild.id,
        b.memberId,
        'kick',
        masterLink,
      ).expect(200)
    ).body;
    expect(kicked.members).toHaveLength(2);
    await detail(b.session, guild.id, b.link).expect(404);
    await memberAction(master, guild.id, b.memberId, 'kick', masterLink).expect(
      404,
    );
    await memberAction(
      master,
      guild.id,
      randomUUID(),
      'kick',
      masterLink,
    ).expect(404);
    // The kicked character is free to join another guild.
    const elsewhere = await guildWith(0);
    const again = (
      await invite(
        elsewhere.master,
        elsewhere.guild.id,
        elsewhere.masterLink,
        b.link,
      ).expect(201)
    ).body;
    await accept(b.session, again.inviteId, b.link).expect(200);
    const target = await login();
    const targetLink = await character(target);
    const pendingInvite = (
      await invite(master, guild.id, masterLink, targetLink).expect(201)
    ).body;
    await disband(c.session, guild.id, c.link).expect(403);
    expect(
      (await disband(master, guild.id, masterLink).expect(200)).body,
    ).toEqual({
      status: 'DISBANDED',
    });
    const [row] = await database.query(
      'SELECT status, disbanded_at, name FROM player_guilds WHERE id = $1',
      [guild.id],
    );
    expect(row).toMatchObject({ status: 'DISBANDED', name: guild.name });
    expect(row.disbanded_at).not.toBeNull();
    expect(await activeMembers(guild.id)).toBe(0);
    expect(await inviteStatus(pendingInvite.inviteId)).toBe('CANCELLED');
    expect(
      (
        await database.query(
          'SELECT count(*)::int AS n FROM player_guild_members WHERE guild_id = $1',
          [guild.id],
        )
      )[0].n,
    ).toBe(4);
    // Every later action sees a missing guild.
    await detail(master, guild.id, masterLink).expect(404);
    await disband(master, guild.id, masterLink).expect(404);
    await invite(master, guild.id, masterLink, targetLink).expect(404);
    await accept(target, pendingInvite.inviteId, targetLink).expect(409);
    await create(master, masterLink);
    expect(await actions(guild.id)).toEqual(
      expect.arrayContaining([
        'PLAYER_GUILD_CREATED',
        'PLAYER_GUILD_INVITED',
        'PLAYER_GUILD_INVITE_ACCEPTED',
        'PLAYER_GUILD_MEMBER_LEFT',
        'PLAYER_GUILD_MEMBER_KICKED',
        'PLAYER_GUILD_DISBANDED',
      ]),
    );
  });
  it('keeps membership and role with the character when ownership changes', async () => {
    const [a, b] = [await login(), await login()];
    const characterId = `char:${randomUUID()}`;
    const aLink = await character(a, 'VERIFIED', server, characterId);
    const guild = await create(a, aLink);
    const helper = await login();
    const helperLink = await character(helper);
    const helperInvite = (
      await invite(a, guild.id, aLink, helperLink).expect(201)
    ).body;
    await accept(helper, helperInvite.inviteId, helperLink).expect(200);
    const aSocket = await connected(a);
    await links.revoke(playerActor(a.player.id), aLink);
    // A loses access immediately; the membership stays.
    await detail(a, guild.id, aLink).expect(404);
    await get(a, `me/characters/${aLink}/guild`).expect(404);
    await invite(a, guild.id, aLink, await character(a)).expect(404);
    await disband(a, guild.id, aLink).expect(404);
    expect(await masters(guild.id)).toBe(1);
    expect(await activeMembers(guild.id)).toBe(2);
    const helperView = (await detail(helper, guild.id, helperLink).expect(200))
      .body;
    expect(
      helperView.members.find((m: Member) => m.role === 'MASTER'),
    ).toMatchObject({ characterId, characterLinkId: null });
    // B verifies the same character and inherits its membership and role.
    const bLink = await character(b, 'VERIFIED', server, characterId);
    const bSocket = await connected(b);
    const inherited = (await get(b, `me/characters/${bLink}/guild`).expect(200))
      .body.guild;
    expect(inherited.id).toBe(guild.id);
    expect(memberOf(inherited, bLink)).toMatchObject({
      characterId,
      role: 'MASTER',
    });
    expect(JSON.stringify(inherited)).not.toContain(aLink);
    const newcomer = await login();
    const newcomerLink = await character(newcomer);
    const byB = (await invite(b, guild.id, bLink, newcomerLink).expect(201))
      .body;
    expect(byB.invitedByCharacterId).toBe(characterId);
    await bSocket.event('GUILD_INVITE_CREATED');
    await settle();
    // Realtime stops for the former owner.
    expect(aSocket.events()).toEqual([]);
    const [invitedAudit] = (await audits(guild.id)).filter(
      (e: { action: string; actor_player_id: string }) =>
        e.action === 'PLAYER_GUILD_INVITED' &&
        e.actor_player_id === b.player.id,
    );
    expect(invitedAudit.metadata.actorCharacterId).toBe(characterId);
  });
  it('fans guild events out to current owners on every connection, never to strangers', async () => {
    const [master, target, stranger] = [
      await login(),
      await login(),
      await login(),
    ];
    const [masterLink, targetLink] = [
      await character(master),
      await character(target),
    ];
    const masterSockets = [await connected(master), await connected(master)];
    const targetSocket = await connected(target);
    const strangerSocket = await connected(stranger);
    const staffSocket = new RealtimeTestClient(`${url}/api/v1/realtime`);
    clients.push(staffSocket);
    await staffSocket.authenticate('STAFF', staffToken);
    const guild = await create(master, masterLink);
    for (const socket of masterSockets)
      expect((await socket.event('GUILD_CREATED')).data).toEqual({
        guildId: guild.id,
        gameServerId: server.id,
        name: guild.name,
        memberId: guild.members[0].memberId,
      });
    const invited = (
      await invite(master, guild.id, masterLink, targetLink).expect(201)
    ).body;
    const received = await targetSocket.event('GUILD_INVITE_CREATED');
    expect(received.data).toEqual({
      guildId: guild.id,
      gameServerId: server.id,
      guildName: guild.name,
      inviteId: invited.inviteId,
      targetCharacterId: characterIds.get(targetLink),
      invitedByCharacterId: characterIds.get(masterLink),
      expiresAt: invited.expiresAt,
    });
    const joined = (
      await accept(target, invited.inviteId, targetLink).expect(200)
    ).body;
    const memberId = memberOf(joined, targetLink).memberId;
    for (const socket of [...masterSockets, targetSocket]) {
      await socket.event('GUILD_INVITE_ACCEPTED');
      expect((await socket.event('GUILD_MEMBER_JOINED')).data).toMatchObject({
        memberId,
        characterId: characterIds.get(targetLink),
        role: 'MEMBER',
      });
    }
    await memberAction(
      master,
      guild.id,
      memberId,
      'role',
      masterLink,
      'OFFICER',
    ).expect(200);
    await memberAction(
      master,
      guild.id,
      memberId,
      'transfer-master',
      masterLink,
    ).expect(200);
    for (const socket of [...masterSockets, targetSocket]) {
      expect(
        (await socket.event('GUILD_MEMBER_ROLE_CHANGED')).data,
      ).toMatchObject({
        memberId,
        previousRole: 'MEMBER',
        role: 'OFFICER',
      });
      expect(
        (await socket.event('GUILD_MASTER_TRANSFERRED')).data,
      ).toMatchObject({
        memberId,
        previousMasterMemberId: guild.members[0].memberId,
      });
    }
    // Declines reach the guild and the declining target only.
    const second = await login();
    const secondLink = await character(second);
    const secondSocket = await connected(second);
    const secondInvite = (
      await invite(target, guild.id, targetLink, secondLink).expect(201)
    ).body;
    await secondSocket.event('GUILD_INVITE_CREATED');
    await decline(second, secondInvite.inviteId, secondLink).expect(200);
    for (const socket of [...masterSockets, targetSocket, secondSocket])
      await socket.event('GUILD_INVITE_DECLINED');
    await memberAction(
      target,
      guild.id,
      guild.members[0].memberId,
      'kick',
      targetLink,
    ).expect(200);
    for (const socket of [...masterSockets, targetSocket])
      await socket.event('GUILD_MEMBER_KICKED');
    const pendingThird = await login();
    const thirdLink = await character(pendingThird);
    const thirdSocket = await connected(pendingThird);
    await invite(target, guild.id, targetLink, thirdLink).expect(201);
    await thirdSocket.event('GUILD_INVITE_CREATED');
    await disband(target, guild.id, targetLink).expect(200);
    for (const socket of [targetSocket, thirdSocket])
      await socket.event('GUILD_DISBANDED');
    await settle();
    // The kicked former master saw nothing after its removal.
    expect(masterSockets[0].events().map((e) => e.type)).not.toContain(
      'GUILD_DISBANDED',
    );
    const ids = masterSockets[0].events().map((e) => e.eventId);
    expect(masterSockets[1].events().map((e) => e.eventId)).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(strangerSocket.events()).toEqual([]);
    expect(staffSocket.events()).toEqual([]);
    const everything = JSON.stringify(
      [...masterSockets, targetSocket, secondSocket, thirdSocket].flatMap((s) =>
        s.events(),
      ),
    );
    for (const secret of [
      master.player.id,
      target.player.id,
      second.player.id,
      masterLink,
      targetLink,
      secondLink,
      thirdLink,
      master.accessToken,
    ])
      expect(everything).not.toContain(secret);
  });
  it('announces invites cancelled because the target joined another guild', async () => {
    const [a, b, c] = [
      await guildWith(0),
      await guildWith(1),
      await guildWith(0),
    ];
    const target = await login();
    const targetLink = await character(target);
    const stranger = await login();
    await character(stranger);
    const [ia, ib, ic] = [
      (await invite(a.master, a.guild.id, a.masterLink, targetLink).expect(201))
        .body,
      (await invite(b.master, b.guild.id, b.masterLink, targetLink).expect(201))
        .body,
      (await invite(c.master, c.guild.id, c.masterLink, targetLink).expect(201))
        .body,
    ];
    // Already DECLINED: not PENDING, so it must not produce a cancellation.
    await decline(target, ic.inviteId, targetLink).expect(200);
    const [targetSocket, aSocket, bMaster, bMember, cSocket, strangerSocket] = [
      await connected(target),
      await connected(a.master),
      await connected(b.master),
      await connected(b.members[0].session),
      await connected(c.master),
      await connected(stranger),
    ];
    await accept(target, ia.inviteId, targetLink).expect(200);
    expect(await inviteStatus(ib.inviteId)).toBe('CANCELLED');
    expect(await inviteStatus(ic.inviteId)).toBe('DECLINED');
    const expected = {
      guildId: b.guild.id,
      gameServerId: server.id,
      inviteId: ib.inviteId,
      targetCharacterId: characterIds.get(targetLink),
      reason: 'TARGET_JOINED_ANOTHER_GUILD',
    };
    for (const socket of [targetSocket, bMaster, bMember])
      expect((await socket.event('GUILD_INVITE_CANCELLED')).data).toEqual(
        expected,
      );
    await aSocket.event('GUILD_MEMBER_JOINED');
    await settle();
    const cancellations = (socket: RealtimeTestClient) =>
      socket.events().filter((e) => e.type === 'GUILD_INVITE_CANCELLED');
    for (const socket of [targetSocket, bMaster, bMember])
      expect(cancellations(socket)).toHaveLength(1);
    // A's members see the join, not B's cancellation; C's invite was declined.
    expect(cancellations(aSocket)).toEqual([]);
    expect(cSocket.events()).toEqual([]);
    expect(strangerSocket.events()).toEqual([]);
    const everything = JSON.stringify(
      [targetSocket, bMaster, bMember].flatMap(cancellations),
    );
    for (const secret of [
      targetLink,
      b.masterLink,
      b.members[0].link,
      target.player.id,
      b.master.player.id,
      b.members[0].session.player.id,
    ])
      expect(everything).not.toContain(secret);
    // No Audit per indirect cancellation: only the accept records it.
    expect(await actions(b.guild.id)).not.toContain(
      'PLAYER_GUILD_INVITE_CANCELLED',
    );
    const [accepted] = (await audits(a.guild.id)).filter(
      (e: { action: string }) => e.action === 'PLAYER_GUILD_INVITE_ACCEPTED',
    );
    expect(accepted.metadata.cancelledInvites).toBe(1);
    // Realtime is not the source of truth: HTTP shows the same state.
    expect(
      (
        await get(target, `guild-invites?characterLinkId=${targetLink}`).expect(
          200,
        )
      ).body.items,
    ).toEqual([]);
  });
  it('announces invites cancelled by disband exactly once, with reason GUILD_DISBANDED', async () => {
    const { master, masterLink, guild } = await guildWith(0);
    const [target, declined] = [await login(), await login()];
    const [targetLink, declinedLink] = [
      await character(target),
      await character(declined),
    ];
    const pending = (
      await invite(master, guild.id, masterLink, targetLink).expect(201)
    ).body;
    const answered = (
      await invite(master, guild.id, masterLink, declinedLink).expect(201)
    ).body;
    await decline(declined, answered.inviteId, declinedLink).expect(200);
    const [targetSocket, declinedSocket, masterSocket] = [
      await connected(target),
      await connected(declined),
      await connected(master),
    ];
    await disband(master, guild.id, masterLink).expect(200);
    expect(await inviteStatus(pending.inviteId)).toBe('CANCELLED');
    expect(await inviteStatus(answered.inviteId)).toBe('DECLINED');
    const expected = {
      guildId: guild.id,
      gameServerId: server.id,
      inviteId: pending.inviteId,
      targetCharacterId: characterIds.get(targetLink),
      reason: 'GUILD_DISBANDED',
    };
    expect((await targetSocket.event('GUILD_INVITE_CANCELLED')).data).toEqual(
      expected,
    );
    expect((await masterSocket.event('GUILD_INVITE_CANCELLED')).data).toEqual(
      expected,
    );
    await disband(master, guild.id, masterLink).expect(404);
    await settle();
    for (const socket of [targetSocket, masterSocket])
      expect(
        socket.events().filter((e) => e.type === 'GUILD_INVITE_CANCELLED'),
      ).toHaveLength(1);
    expect(
      declinedSocket
        .events()
        .filter((e) => e.type === 'GUILD_INVITE_CANCELLED'),
    ).toEqual([]);
    expect(JSON.stringify(targetSocket.events())).not.toContain(masterLink);
    const [disbanded] = (await audits(guild.id)).filter(
      (e: { action: string }) => e.action === 'PLAYER_GUILD_DISBANDED',
    );
    expect(disbanded.metadata.cancelledInvites).toBe(1);
  });
  it('publishes no cancellation when the accept rolls back', async () => {
    const [a, b] = [await guildWith(0), await guildWith(0)];
    const target = await login();
    const targetLink = await character(target);
    const ia = (
      await invite(a.master, a.guild.id, a.masterLink, targetLink).expect(201)
    ).body;
    const ib = (
      await invite(b.master, b.guild.id, b.masterLink, targetLink).expect(201)
    ).body;
    const [targetSocket, bSocket] = [
      await connected(target),
      await connected(b.master),
    ];
    // Audit fails after the cancellation ran inside the transaction.
    await database.query(`
      CREATE FUNCTION fail_guild_accept_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'PLAYER_GUILD_INVITE_ACCEPTED' THEN
          RAISE EXCEPTION 'audit down';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_guild_accept_audit BEFORE INSERT ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION fail_guild_accept_audit();
    `);
    try {
      await accept(target, ia.inviteId, targetLink).expect(503);
    } finally {
      await database.query(`
        DROP TRIGGER fail_guild_accept_audit ON audit_logs;
        DROP FUNCTION fail_guild_accept_audit();
      `);
    }
    expect(await inviteStatus(ia.inviteId)).toBe('PENDING');
    expect(await inviteStatus(ib.inviteId)).toBe('PENDING');
    await settle();
    expect(targetSocket.events()).toEqual([]);
    expect(bSocket.events()).toEqual([]);
    await accept(target, ia.inviteId, targetLink).expect(200);
    expect((await bSocket.event('GUILD_INVITE_CANCELLED')).data).toMatchObject({
      inviteId: ib.inviteId,
    });
  });
  it('lets PostgreSQL decide concurrent creations and name races', async () => {
    const solo = await login();
    const soloLink = await character(solo);
    const creations = await Promise.all(
      Array.from({ length: 6 }, () =>
        post(solo, 'guilds', { characterLinkId: soloLink, name: uniqueName() }),
      ),
    );
    expect(creations.map((r) => r.status).sort()).toEqual([
      201, 409, 409, 409, 409, 409,
    ]);
    expect(
      (
        await database.query(
          'SELECT count(*)::int AS n FROM player_guild_members WHERE character_external_id = $1 AND left_at IS NULL',
          [characterIds.get(soloLink)],
        )
      )[0].n,
    ).toBe(1);
    const racers = await login();
    const racerLinks: string[] = [];
    for (let i = 0; i < 5; i++) racerLinks.push(await character(racers));
    const name = `Race ${randomUUID().slice(0, 8)}`;
    const variants = [name, name.toUpperCase(), name.toLowerCase(), name, name];
    const names = await Promise.all(
      racerLinks.map((link, i) =>
        post(racers, 'guilds', { characterLinkId: link, name: variants[i] }),
      ),
    );
    expect(names.map((r) => r.status).sort()).toEqual([
      201, 409, 409, 409, 409,
    ]);
    for (const response of names.filter((r) => r.status === 409))
      expect(response.body.message).toBe('Guild name unavailable');
    const [s1, s2] = [
      await servers.register({ code: randomUUID(), name: 'S1' }),
      await servers.register({ code: randomUUID(), name: 'S2' }),
    ];
    const shared = `Shared ${randomUUID().slice(0, 8)}`;
    const acrossServers = await Promise.all([
      post(racers, 'guilds', {
        characterLinkId: await character(racers, 'VERIFIED', s1),
        name: shared,
      }),
      post(racers, 'guilds', {
        characterLinkId: await character(racers, 'VERIFIED', s2),
        name: shared,
      }),
    ]);
    expect(acrossServers.map((r) => r.status)).toEqual([201, 201]);
  });
  it('lets PostgreSQL decide double joins and the last slot', async () => {
    const [g1, g2] = [await guildWith(0), await guildWith(0)];
    const both = await login();
    const bothLink = await character(both);
    const [i1, i2] = [
      (
        await invite(g1.master, g1.guild.id, g1.masterLink, bothLink).expect(
          201,
        )
      ).body,
      (
        await invite(g2.master, g2.guild.id, g2.masterLink, bothLink).expect(
          201,
        )
      ).body,
    ];
    const joins = await Promise.all([
      accept(both, i1.inviteId, bothLink),
      accept(both, i2.inviteId, bothLink),
    ]);
    expect(joins.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      (
        await database.query(
          'SELECT count(*)::int AS n FROM player_guild_members WHERE character_external_id = $1 AND left_at IS NULL',
          [characterIds.get(bothLink)],
        )
      )[0].n,
    ).toBe(1);
    const losing = joins[0].status === 200 ? i2 : i1;
    expect(await inviteStatus(losing.inviteId)).toBe('CANCELLED');
    const { master, masterLink, guild } = await guildWith(0);
    await fill(guild.id, MAX_GUILD_MEMBERS - 2);
    const racers = [await login(), await login(), await login()];
    const racerLinks = [
      await character(racers[0]),
      await character(racers[1]),
      await character(racers[2]),
    ];
    const invites: { inviteId: string }[] = [];
    for (const link of racerLinks)
      invites.push(
        (await invite(master, guild.id, masterLink, link).expect(201)).body,
      );
    const lastSlot = await Promise.all(
      racers.map((session, i) =>
        accept(session, invites[i].inviteId, racerLinks[i]),
      ),
    );
    expect(lastSlot.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(await activeMembers(guild.id)).toBe(MAX_GUILD_MEMBERS);
  });
  it('serializes role changes, kicks, transfers and disband on the guild row', async () => {
    const { master, masterLink, guild, members } = await guildWith(3);
    const [a, b, c] = members;
    const [role, kick] = await Promise.all([
      memberAction(master, guild.id, a.memberId, 'role', masterLink, 'OFFICER'),
      memberAction(master, guild.id, a.memberId, 'kick', masterLink),
    ]);
    expect(kick.status).toBe(200);
    expect([200, 404]).toContain(role.status);
    const [kicked] = await database.query(
      'SELECT left_at FROM player_guild_members WHERE id = $1',
      [a.memberId],
    );
    expect(kicked.left_at).not.toBeNull();
    // Two transfers at once: exactly one wins, never two MASTERs.
    const transfers = await Promise.all([
      memberAction(master, guild.id, b.memberId, 'transfer-master', masterLink),
      memberAction(master, guild.id, c.memberId, 'transfer-master', masterLink),
    ]);
    expect(transfers.map((r) => r.status).sort()).toEqual([200, 403]);
    expect(await masters(guild.id)).toBe(1);
    const winner = transfers[0].status === 200 ? b : c;
    const loser = winner === b ? c : b;
    const [transfer, disbanded] = await Promise.all([
      memberAction(
        winner.session,
        guild.id,
        loser.memberId,
        'transfer-master',
        winner.link,
      ),
      disband(winner.session, guild.id, winner.link),
    ]);
    const outcome = [transfer.status, disbanded.status];
    expect([
      [200, 403],
      [404, 200],
    ]).toContainEqual(outcome);
    const [row] = await database.query(
      'SELECT status FROM player_guilds WHERE id = $1',
      [guild.id],
    );
    if (outcome[0] === 200) {
      expect(row.status).toBe('ACTIVE');
      expect(await masters(guild.id)).toBe(1);
    } else {
      expect(row.status).toBe('DISBANDED');
      expect(await masters(guild.id)).toBe(0);
    }
    expect(
      (
        await database.query(
          "SELECT count(*)::int AS n FROM audit_logs WHERE resource_id = $1 AND action = 'PLAYER_GUILD_MASTER_TRANSFERRED'",
          [guild.id],
        )
      )[0].n,
    ).toBe(outcome[0] === 200 ? 2 : 1);
  });
  it('audits every effective mutation as PLAYER with safe metadata only', async () => {
    const { master, masterLink, guild, members } = await guildWith(1);
    await memberAction(
      master,
      guild.id,
      members[0].memberId,
      'role',
      masterLink,
      'OFFICER',
    ).expect(200);
    await memberAction(
      master,
      guild.id,
      members[0].memberId,
      'role',
      masterLink,
      'OFFICER',
    ).expect(200);
    const target = await login();
    const targetLink = await character(target);
    await invite(master, guild.id, masterLink, targetLink).expect(201);
    await invite(master, guild.id, masterLink, targetLink).expect(200);
    const entries = await audits(guild.id);
    expect(entries.map((e: { action: string }) => e.action).sort()).toEqual([
      'PLAYER_GUILD_CREATED',
      'PLAYER_GUILD_INVITED',
      'PLAYER_GUILD_INVITED',
      'PLAYER_GUILD_INVITE_ACCEPTED',
      'PLAYER_GUILD_MEMBER_ROLE_CHANGED',
    ]);
    const allowed = new Set([
      'guildId',
      'gameServerId',
      'actorCharacterId',
      'targetCharacterId',
      'memberId',
      'role',
      'previousRole',
      'previousMasterMemberId',
      'inviteId',
      'name',
      'cancelledInvites',
      'memberCount',
    ]);
    for (const entry of entries) {
      expect(entry).toMatchObject({
        actor_type: 'PLAYER',
        actor_role: null,
        resource_type: 'PLAYER_GUILD',
      });
      expect(entry.metadata).toMatchObject({
        guildId: guild.id,
        gameServerId: server.id,
      });
      for (const key of Object.keys(entry.metadata))
        expect(allowed.has(key)).toBe(true);
      const text = JSON.stringify(entry.metadata);
      expect(text).not.toMatch(/token|subject|playerId/i);
      for (const secret of [masterLink, members[0].link, targetLink])
        expect(text).not.toContain(secret);
    }
  });
  it('reverts only the guild tables and reapplies cleanly', async () => {
    await database.undoLastMigration(); // Etapa 10.13 Player Trades
    await database.undoLastMigration(); // Etapa 10.12 Economy
    await database.undoLastMigration();
    expect(
      await database.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename LIKE 'player_guild%'",
        [schema],
      ),
    ).toEqual([]);
    expect(
      await database.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename LIKE 'player_group%' ORDER BY tablename",
        [schema],
      ),
    ).toHaveLength(3);
    expect(await database.runMigrations()).toHaveLength(3);
    expect(await database.runMigrations()).toHaveLength(0);
    expect(
      (await database.driver.createSchemaBuilder().log()).upQueries,
    ).toEqual([]);
  });
});
