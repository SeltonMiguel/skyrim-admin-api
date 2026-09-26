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
import { ChatRateLimiter } from '../src/player-chat/chat-rate-limiter.js';
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
interface Message {
  messageId: string;
  channelType: string;
  senderCharacterId: string;
  message: string;
  targetCharacterId: string | null;
}
const MESSAGE_KEYS = [
  'channelType',
  'createdAt',
  'gameServerId',
  'groupId',
  'guildId',
  'message',
  'messageId',
  'senderCharacterId',
  'targetCharacterId',
];
describeDatabase('Player chat with real PostgreSQL', () => {
  let admin: DataSource, database: DataSource, app: INestApplication<App>;
  let links: CharacterLinkService, servers: GameServerService;
  let registry: RealtimeConnectionRegistry;
  let server: GameServer, staffToken: string, url: string;
  const discord = new FakeDiscordProvider();
  const clients: RealtimeTestClient[] = [];
  const schema = `player_chat_test_${randomUUID().replaceAll('-', '')}`;
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
    char = `char:${randomUUID()}`,
    on: GameServer = server,
  ) => {
    const actor = playerActor(session.player.id);
    const requested = await links.request(actor, {
      gameServerId: on.id,
      characterExternalId: char,
    });
    if (state !== 'PENDING')
      await links.confirmFromAgent({
        challenge: requested.challenge,
        gameServerId: on.id,
        characterExternalId: char,
      });
    if (state === 'REVOKED') await links.revoke(actor, requested.link.id);
    return requested.link.id;
  };
  const party = async (on = server): Promise<Party> => {
    const session = await login();
    const char = `char:${randomUUID()}`;
    return { session, link: await link(session, 'VERIFIED', char, on), char };
  };
  const heirOf = async (char: string, on = server): Promise<Party> => {
    const session = await login();
    return { session, link: await link(session, 'VERIFIED', char, on), char };
  };
  const revoke = (p: Party) =>
    links.revoke(playerActor(p.session.player.id), p.link);
  const token = (session: Session | string) =>
    typeof session === 'string' ? session : session.accessToken;
  const post = (
    session: Session | string,
    path: string,
    body: object,
    key: string | null = randomUUID(),
  ) => {
    const call = http()
      .post(`/api/v1/player/${path}`)
      .auth(token(session), { type: 'bearer' });
    return (key === null ? call : call.set('Idempotency-Key', key)).send(body);
  };
  const get = (session: Session | string, path: string) =>
    http()
      .get(`/api/v1/player/${path}`)
      .auth(token(session), { type: 'bearer' });
  const say = (p: Party, path: string, message: string, key?: string | null) =>
    post(p.session, path, { characterLinkId: p.link, message }, key);
  const global = (p: Party, message: string, key?: string | null) =>
    say(p, 'chat/global', message, key);
  const direct = (p: Party, to: string, message: string, key?: string) =>
    say(p, `chat/direct/${encodeURIComponent(to)}`, message, key);
  const toGroup = (p: Party, groupId: string, message: string, key?: string) =>
    say(p, `groups/${groupId}/chat`, message, key);
  const toGuild = (p: Party, guildId: string, message: string, key?: string) =>
    say(p, `guilds/${guildId}/chat`, message, key);
  const globalHistory = (p: Party, query = '') =>
    get(p.session, `me/characters/${p.link}/chat/global${query}`);
  const directHistory = (p: Party, with_: string) =>
    get(
      p.session,
      `me/characters/${p.link}/chat/direct/${encodeURIComponent(with_)}`,
    );
  const groupHistory = (p: Party, groupId: string) =>
    get(p.session, `groups/${groupId}/chat?characterLinkId=${p.link}`);
  const guildHistory = (p: Party, guildId: string) =>
    get(p.session, `guilds/${guildId}/chat?characterLinkId=${p.link}`);
  const texts = (body: { items: Message[] }) =>
    body.items.map((m) => m.message);
  // A group led by `leader` with `members` joined.
  const groupOf = async (leader: Party, ...members: Party[]) => {
    const groupId = (
      await post(
        leader.session,
        'groups',
        { characterLinkId: leader.link },
        null,
      ).expect(201)
    ).body.id as string;
    let view: { members: { memberId: string; characterId: string }[] } = {
      members: [],
    };
    for (const member of members) {
      const { inviteId } = (
        await post(
          leader.session,
          `groups/${groupId}/invites`,
          { actorCharacterLinkId: leader.link, targetCharacterId: member.char },
          null,
        ).expect(201)
      ).body;
      view = (
        await post(
          member.session,
          `group-invites/${inviteId}/accept`,
          {},
          null,
        ).expect(200)
      ).body;
    }
    const memberId = (p: Party) =>
      view.members.find((m) => m.characterId === p.char)!.memberId;
    return { groupId, memberId };
  };
  const guildOf = async (master: Party, ...members: Party[]) => {
    const guildId = (
      await post(
        master.session,
        'guilds',
        {
          characterLinkId: master.link,
          name: `Guild ${randomUUID().slice(0, 8)}`,
        },
        null,
      ).expect(201)
    ).body.id as string;
    let view: { members: { memberId: string; characterId: string }[] } = {
      members: [],
    };
    for (const member of members) {
      const { inviteId } = (
        await post(
          master.session,
          `guilds/${guildId}/invites`,
          { actorCharacterLinkId: master.link, targetCharacterId: member.char },
          null,
        ).expect(201)
      ).body;
      view = (
        await post(
          member.session,
          `guild-invites/${inviteId}/accept`,
          { characterLinkId: member.link },
          null,
        ).expect(200)
      ).body;
    }
    const memberId = (p: Party) =>
      view.members.find((m) => m.characterId === p.char)!.memberId;
    return { guildId, memberId };
  };
  const count = async (sql: string, params: unknown[] = []) =>
    (await database.query(sql, params))[0].n as number;
  const messageCount = (content: string) =>
    count(
      'SELECT count(*)::int AS n FROM player_chat_messages WHERE content = $1',
      [content],
    );
  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => 'ok',
      (error: { driverError?: { code: string } }) => error.driverError?.code,
    );
  const connected = async (session: Session | string) => {
    const socket = new RealtimeTestClient(`${url}/api/v1/realtime`);
    clients.push(socket);
    await socket.authenticate(
      typeof session === 'string' ? 'STAFF' : 'PLAYER',
      token(session),
    );
    return socket;
  };
  const chatEvents = (socket: RealtimeTestClient, messageId?: string) =>
    socket
      .events()
      .filter(
        (e) =>
          e.type === 'CHAT_MESSAGE_CREATED' &&
          (!messageId ||
            (e.data as { messageId: string }).messageId === messageId),
      );
  const received = (socket: RealtimeTestClient, messageId: string) =>
    socket.until(() => chatEvents(socket, messageId)[0]);
  const quiet = () => new Promise((resolve) => setTimeout(resolve, 200));
  const insertMessage = (
    p: Party,
    content: string,
    createdAgo: string,
    expiresIn: string,
  ) =>
    database.query(
      `INSERT INTO player_chat_messages(game_server_id, channel_type, sender_character_id, sender_player_character_id, content, created_at, expires_at)
       VALUES ($1, 'GLOBAL', $2, $3, $4, now() - $5::interval, now() + $6::interval) RETURNING id`,
      [server.id, p.char, p.link, content, createdAgo, expiresIn],
    );
  const enable = (on: GameServer, enabled: boolean) =>
    database.query('UPDATE game_servers SET enabled = $2 WHERE id = $1', [
      on.id,
      enabled,
    ]);
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
    // Apply, revert (no messages) and reapply the 10.15 migration.
    expect(await database.runMigrations()).toHaveLength(27);
    await database.undoLastMigration(); // Etapa 12.5 Multi-instance
    await database.undoLastMigration(); // Etapa 12.4 Operational Recovery
    await database.undoLastMigration(); // Etapa 11.4 Agent Domain Events
    await database.undoLastMigration(); // Etapa 11.3 Server Control Transport
    await database.undoLastMigration(); // Etapa 11.1 Game Agent Transport
    await database.undoLastMigration(); // Etapa 10.17 VIP Entitlements
    await database.undoLastMigration(); // Etapa 10.16 Player Settings
    await database.undoLastMigration();
    expect(
      await database.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename LIKE 'player_chat%'",
        [schema],
      ),
    ).toEqual([]);
    expect(await database.runMigrations()).toHaveLength(8);
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
    server = await servers.register({ code: randomUUID(), name: 'Chat' });
    const password = 'Chat-Staff-Password-42';
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

  it('adds the chat tables with database-enforced shape, immutability and purge-only deletes', async () => {
    expect(database.options.synchronize).toBe(false);
    expect(await database.showMigrations()).toBe(false);
    expect(await database.query('SELECT * FROM migrations')).toHaveLength(27);
    const diff = await database.driver.createSchemaBuilder().log();
    expect([diff.upQueries, diff.downQueries]).toEqual([[], []]);
    const [a, b] = [await party(), await party()];
    const insert = (columns: string, values: string, params: unknown[]) =>
      database.query(
        `INSERT INTO player_chat_messages(game_server_id, sender_character_id, sender_player_character_id, expires_at, ${columns}) VALUES ($1, $2, $3, now() + interval '1 day', ${values}) RETURNING id`,
        [server.id, a.char, a.link, ...params],
      );
    // Channel shape, content and sender consistency.
    for (const [columns, values, params] of [
      ['channel_type, content, group_id', "'GLOBAL', 'x', $4", [randomUUID()]],
      ['channel_type, content', "'GROUP', 'x'", []],
      ['channel_type, content', "'DIRECT', 'x'", []],
      ['channel_type, content', "'GLOBAL', $4", ['x'.repeat(501)]],
      ['channel_type, content', "'GLOBAL', $4", [' padded ']],
      ['channel_type, content', "'GLOBAL', $4", ['a\nb']],
      ['channel_type, content', "'GLOBAL', ''", []],
    ] as const)
      expect(await code(insert(columns, values, [...params]))).toMatch(
        /^23(514|503)$/,
      );
    expect(
      await code(
        database.query(
          "INSERT INTO player_chat_messages(game_server_id, channel_type, sender_character_id, sender_player_character_id, content, expires_at) VALUES ($1, 'GLOBAL', $2, $3, 'x', now() + interval '1 day')",
          [server.id, b.char, a.link],
        ),
      ),
    ).toBe('23514');
    // Threads: canonical pair on one server.
    const [low, high] = [a.link, b.link].sort();
    expect(
      await code(
        database.query(
          'INSERT INTO player_chat_direct_threads(game_server_id, participant_a_player_character_id, participant_b_player_character_id) VALUES ($1, $2, $3)',
          [server.id, high, low],
        ),
      ),
    ).toBe('23514');
    const other = await servers.register({ code: randomUUID(), name: 'Other' });
    expect(
      await code(
        database.query(
          'INSERT INTO player_chat_direct_threads(game_server_id, participant_a_player_character_id, participant_b_player_character_id) VALUES ($1, $2, $3)',
          [other.id, low, high],
        ),
      ),
    ).toBe('23514');
    // Messages are never edited; live ones are never deleted; expired ones
    // can be purged (future retention cleanup).
    const [{ id: live }] = await insert(
      'channel_type, content',
      "'GLOBAL', 'live'",
      [],
    );
    for (const statement of [
      "UPDATE player_chat_messages SET content = 'edited' WHERE id = $1",
      'UPDATE player_chat_messages SET expires_at = now() WHERE id = $1',
      'DELETE FROM player_chat_messages WHERE id = $1',
    ])
      expect(await code(database.query(statement, [live]))).toBe('55000');
    for (const statement of [
      'TRUNCATE player_chat_messages CASCADE',
      'TRUNCATE player_chat_requests',
      'TRUNCATE player_chat_direct_threads CASCADE',
    ])
      expect(await code(database.query(statement))).toBe('55000');
    const [{ id: expired }] = await insertMessage(
      a,
      'purgeable',
      '8 days',
      '-1 day',
    );
    await database.query('DELETE FROM player_chat_messages WHERE id = $1', [
      expired,
    ]);
    expect(await messageCount('purgeable')).toBe(0);
  });
  it('sends GLOBAL plain text to the server of the character and serves history newest first', async () => {
    const [a, b] = [await party(), await party()];
    const elsewhere = await servers.register({
      code: randomUUID(),
      name: 'Far',
    });
    const far = await party(elsewhere);
    const html = '<script>alert("x")</script> **not bold** &amp;';
    const first = await global(a, `  ${html}  `).expect(201);
    expect(Object.keys(first.body).sort()).toEqual(MESSAGE_KEYS);
    expect(first.body).toMatchObject({
      channelType: 'GLOBAL',
      gameServerId: server.id,
      senderCharacterId: a.char,
      message: html,
      groupId: null,
      guildId: null,
      targetCharacterId: null,
    });
    // Stored verbatim as text, never rendered.
    expect(
      await database.query(
        'SELECT content, expires_at - created_at AS retention FROM player_chat_messages WHERE id = $1',
        [first.body.messageId],
      ),
    ).toEqual([{ content: html, retention: { days: 7 } }]);
    await global(b, 'second 😀 ação').expect(201);
    await global(far, 'far away').expect(201);
    const history = (await globalHistory(a).expect(200)).body;
    expect(history).toMatchObject({ page: 1, limit: 50 });
    expect(texts(history).slice(0, 2)).toEqual(['second 😀 ação', html]);
    expect(texts(history)).not.toContain('far away');
    expect(texts((await globalHistory(far).expect(200)).body)).toEqual([
      'far away',
    ]);
    // Pagination: limit up to 100, page and total.
    const paged = (await globalHistory(a, '?limit=1&page=2').expect(200)).body;
    expect(paged).toMatchObject({ limit: 1, page: 2 });
    expect(texts(paged)).toEqual([html]);
    for (const query of ['?limit=101', '?limit=0', '?page=0', '?before=x'])
      await globalHistory(a, query).expect(400);
  });
  it('validates senders, bodies and messages strictly', async () => {
    const [p, stranger] = [await party(), await party()];
    const body = (extra: object) => ({
      characterLinkId: p.link,
      message: 'hello',
      ...extra,
    });
    for (const extra of [
      { message: '' },
      { message: '   ' },
      { message: 'x'.repeat(501) },
      { message: 'line\nbreak' },
      { message: 'nul\u0000' },
      { message: `bidi${String.fromCharCode(0x202e)}evil` },
      { message: 'lone\ud800' },
      { message: 42 },
      { message: undefined },
      { characterLinkId: 'nope' },
      { gameServerId: server.id },
      { senderCharacterId: 'char:x' },
      { channelType: 'GUILD' },
    ])
      await post(p.session, 'chat/global', body(extra)).expect(400);
    expect(
      (await global(p, '😀'.repeat(500)).expect(201)).body.message,
    ).toHaveLength(1000);
    for (const extra of [
      { targetPlayerId: randomUUID() },
      { targetCharacterLinkId: stranger.link },
      { gameServerId: server.id },
    ])
      await post(p.session, `chat/direct/${stranger.char}`, body(extra)).expect(
        400,
      );
    await global(p, 'no key', null).expect(400);
    await global(p, 'bad key', 'bad key').expect(400);
    // Never as another character: foreign, PENDING or REVOKED links.
    for (const characterLinkId of [
      stranger.link,
      await link(p.session, 'PENDING'),
      await link(p.session, 'REVOKED'),
      randomUUID(),
    ])
      await post(p.session, 'chat/global', body({ characterLinkId })).expect(
        404,
      );
    await post(staffToken, 'chat/global', body({})).expect(401);
    await get(staffToken, `me/characters/${p.link}/chat/global`).expect(401);
    await http()
      .get(`/api/v1/player/me/characters/${p.link}/chat/global`)
      .expect(401);
    await get(p.session, `me/characters/${stranger.link}/chat/global`).expect(
      404,
    );
    await database.query(
      "UPDATE players SET status = 'SUSPENDED' WHERE id = $1",
      [p.session.player.id],
    );
    try {
      await global(p, 'suspended').expect(403);
      await globalHistory(p).expect(403);
    } finally {
      await database.query(
        "UPDATE players SET status = 'ACTIVE' WHERE id = $1",
        [p.session.player.id],
      );
    }
    // No edit or delete surface.
    for (const method of ['put', 'patch', 'delete'] as const)
      await http()
        [method](`/api/v1/player/chat/global`)
        .auth(p.session.accessToken, { type: 'bearer' })
        .expect(404);
  });
  it('fans GLOBAL messages out to every current player of the server, after commit', async () => {
    const [a, b] = [await party(), await party()];
    const elsewhere = await servers.register({
      code: randomUUID(),
      name: 'Iso',
    });
    const far = await party(elsewhere);
    const pendingOnly = await login();
    await link(pendingOnly, 'PENDING');
    // A player with two characters on the server gets one event per socket.
    const twoChars = await party();
    await link(twoChars.session);
    const [sa1, sa2, sb, sfar, spending, stwo, staff] = [
      await connected(a.session),
      await connected(a.session),
      await connected(b.session),
      await connected(far.session),
      await connected(pendingOnly),
      await connected(twoChars.session),
      await connected(staffToken),
    ];
    const sent = (await global(a, 'hello server').expect(201)).body;
    for (const socket of [sa1, sa2, sb, stwo])
      expect((await received(socket, sent.messageId)).data).toEqual({
        ...sent,
      });
    // A rolled-back send publishes nothing.
    await post(a.session, 'chat/global', {
      characterLinkId: randomUUID(),
      message: 'lost',
    }).expect(404);
    await quiet();
    expect(chatEvents(stwo, sent.messageId)).toHaveLength(1);
    for (const socket of [sfar, spending, staff])
      expect(chatEvents(socket)).toEqual([]);
    expect(chatEvents(sb).map((e) => (e.data as Message).message)).toEqual([
      'hello server',
    ]);
    const payload = JSON.stringify(chatEvents(sb));
    for (const secret of [a.session.player.id, a.link, b.link])
      expect(payload).not.toContain(secret);
  });
  it('limits GROUP chat to current active members, before and after leave, kick and disband', async () => {
    const [leader, member, kicked, outsider] = [
      await party(),
      await party(),
      await party(),
      await party(),
    ];
    const { groupId, memberId } = await groupOf(leader, member, kicked);
    const [sl, sm, sk, so] = [
      await connected(leader.session),
      await connected(member.session),
      await connected(kicked.session),
      await connected(outsider.session),
    ];
    const hi = (await toGroup(leader, groupId, 'group hi').expect(201)).body;
    expect(hi).toMatchObject({ channelType: 'GROUP', groupId, guildId: null });
    await toGroup(member, groupId, 'member reply').expect(201);
    expect(
      texts((await groupHistory(kicked, groupId).expect(200)).body),
    ).toEqual(['member reply', 'group hi']);
    for (const socket of [sl, sm, sk]) await received(socket, hi.messageId);
    // Outsiders can neither send nor read.
    await toGroup(outsider, groupId, 'intruder').expect(404);
    await groupHistory(outsider, groupId).expect(404);
    await get(
      outsider.session,
      `groups/${groupId}/chat?characterLinkId=${leader.link}`,
    ).expect(404);
    await get(leader.session, `groups/${groupId}/chat`).expect(400);
    await groupHistory(leader, randomUUID()).expect(404);
    // Kicked: access ends at once and later messages do not reach it.
    await post(
      leader.session,
      `groups/${groupId}/members/${memberId(kicked)}/kick`,
      {},
      null,
    ).expect(200);
    await groupHistory(kicked, groupId).expect(404);
    await toGroup(kicked, groupId, 'still here?').expect(404);
    const after = (await toGroup(leader, groupId, 'after kick').expect(201))
      .body;
    await received(sm, after.messageId);
    await quiet();
    expect(chatEvents(sk, after.messageId)).toEqual([]);
    expect(chatEvents(so)).toEqual([]);
    // Leaving ends access; disband ends it for everyone.
    await post(
      member.session,
      `groups/${groupId}/leave`,
      { characterLinkId: member.link },
      null,
    ).expect(200);
    await groupHistory(member, groupId).expect(404);
    await post(leader.session, `groups/${groupId}/disband`, {}, null).expect(
      200,
    );
    await groupHistory(leader, groupId).expect(404);
    await toGroup(leader, groupId, 'disbanded').expect(404);
    // A revoked leader link loses access too.
    const [l2, m2] = [await party(), await party()];
    const second = await groupOf(l2, m2);
    await toGroup(m2, second.groupId, 'before revoke').expect(201);
    await revoke(m2);
    await groupHistory(m2, second.groupId).expect(404);
  });
  it('keeps GUILD chat with the character identity, including across an ownership change', async () => {
    const [master, member, outsider] = [
      await party(),
      await party(),
      await party(),
    ];
    const { guildId, memberId } = await guildOf(master, member);
    const [sm, sb, so] = [
      await connected(master.session),
      await connected(member.session),
      await connected(outsider.session),
    ];
    const hello = (await toGuild(master, guildId, 'guild hello').expect(201))
      .body;
    expect(hello).toMatchObject({
      channelType: 'GUILD',
      guildId,
      groupId: null,
    });
    await toGuild(member, guildId, 'guild reply').expect(201);
    for (const socket of [sm, sb]) await received(socket, hello.messageId);
    await toGuild(outsider, guildId, 'intruder').expect(404);
    await guildHistory(outsider, guildId).expect(404);
    await quiet();
    expect(chatEvents(so)).toEqual([]);
    // The member character changes owner: the old owner loses access, the
    // new owner reads the current guild history and can talk.
    await revoke(member);
    await guildHistory(member, guildId).expect(404);
    await toGuild(member, guildId, 'old owner').expect(404);
    const heir = await heirOf(member.char);
    const sh = await connected(heir.session);
    expect(texts((await guildHistory(heir, guildId).expect(200)).body)).toEqual(
      ['guild reply', 'guild hello'],
    );
    const fromHeir = (await toGuild(heir, guildId, 'heir here').expect(201))
      .body;
    expect(fromHeir.senderCharacterId).toBe(member.char);
    await received(sm, fromHeir.messageId);
    await received(sh, fromHeir.messageId);
    // Kicked from the guild: no more access.
    await post(
      master.session,
      `guilds/${guildId}/members/${memberId(member)}/kick`,
      { actorCharacterLinkId: master.link },
      null,
    ).expect(200);
    await guildHistory(heir, guildId).expect(404);
    await toGuild(heir, guildId, 'kicked').expect(404);
  });
  it('sends DIRECT messages between the current owners only, with generic 404s for unknown targets', async () => {
    const [a, b, stranger] = [await party(), await party(), await party()];
    const [sa, sb, ss] = [
      await connected(a.session),
      await connected(b.session),
      await connected(stranger.session),
    ];
    const hi = (await direct(a, b.char, 'hi b').expect(201)).body;
    expect(Object.keys(hi).sort()).toEqual(MESSAGE_KEYS);
    expect(hi).toMatchObject({
      channelType: 'DIRECT',
      senderCharacterId: a.char,
      targetCharacterId: b.char,
      groupId: null,
      guildId: null,
    });
    const reply = (await direct(b, a.char, 'hi a').expect(201)).body;
    expect(reply).toMatchObject({
      senderCharacterId: b.char,
      targetCharacterId: a.char,
    });
    for (const socket of [sa, sb]) {
      await received(socket, hi.messageId);
      await received(socket, reply.messageId);
    }
    // One thread, the same history from both sides.
    const fromA = (await directHistory(a, b.char).expect(200)).body;
    const fromB = (await directHistory(b, a.char).expect(200)).body;
    expect(texts(fromA)).toEqual(['hi a', 'hi b']);
    expect(fromB).toEqual(fromA);
    expect(
      await count(
        'SELECT count(*)::int AS n FROM player_chat_direct_threads WHERE $1 IN (participant_a_player_character_id, participant_b_player_character_id)',
        [a.link],
      ),
    ).toBe(1);
    // A stranger sees none of it and receives nothing.
    expect((await directHistory(stranger, a.char).expect(200)).body.total).toBe(
      0,
    );
    await quiet();
    expect(chatEvents(ss)).toEqual([]);
    // Unknown, PENDING-only, REVOKED, other-server and unavailable targets
    // are the same 404; yourself is 400.
    const pendingOwner = await login();
    const pendingChar = `char:${randomUUID()}`;
    await link(pendingOwner, 'PENDING', pendingChar);
    const revokedChar = `char:${randomUUID()}`;
    await link(await login(), 'REVOKED', revokedChar);
    const elsewhere = await servers.register({
      code: randomUUID(),
      name: 'DM',
    });
    const far = await party(elsewhere);
    for (const target of [
      `char:${randomUUID()}`,
      pendingChar,
      revokedChar,
      far.char,
    ]) {
      expect(
        (await direct(a, target, 'anyone?').expect(404)).body.message,
      ).toBe('Character not available');
      await directHistory(a, target).expect(404);
    }
    const banned = await party();
    await database.query("UPDATE players SET status = 'BANNED' WHERE id = $1", [
      banned.session.player.id,
    ]);
    await direct(a, banned.char, 'banned?').expect(404);
    await direct(a, a.char, 'me').expect(400);
    await directHistory(a, a.char).expect(400);
    // Nothing internal leaks: ownership links, thread or player ids.
    const [{ id: threadId }] = await database.query(
      'SELECT id FROM player_chat_direct_threads WHERE $1 IN (participant_a_player_character_id, participant_b_player_character_id)',
      [a.link],
    );
    const everything = JSON.stringify([
      fromA,
      fromB,
      hi,
      reply,
      ...sa.events(),
      ...sb.events(),
    ]);
    for (const secret of [
      a.link,
      b.link,
      threadId,
      a.session.player.id,
      b.session.player.id,
    ])
      expect(everything).not.toContain(secret);
  });
  it('never hands old DIRECT messages to a new owner of either character', async () => {
    const [a, b] = [await party(), await party()];
    await direct(a, b.char, 'private from A').expect(201);
    await direct(b, a.char, 'private from B').expect(201);
    // A's character X changes owner.
    await revoke(a);
    await directHistory(a, b.char).expect(404);
    await direct(a, b.char, 'old owner').expect(404);
    const heir = await heirOf(a.char);
    const sb = await connected(b.session);
    const sheir = await connected(heir.session);
    expect((await directHistory(heir, b.char).expect(200)).body).toMatchObject({
      total: 0,
      items: [],
    });
    // B, looking at the character, only sees the current owners' thread.
    expect((await directHistory(b, a.char).expect(200)).body.total).toBe(0);
    // The heir starts a new conversation under the new ownership link.
    const fresh = (
      await direct(heir, b.char, 'hello, new owner here').expect(201)
    ).body;
    await received(sb, fresh.messageId);
    await received(sheir, fresh.messageId);
    expect(texts((await directHistory(b, a.char).expect(200)).body)).toEqual([
      'hello, new owner here',
    ]);
    expect(texts((await directHistory(heir, b.char).expect(200)).body)).toEqual(
      ['hello, new owner here'],
    );
    expect(
      await count(
        'SELECT count(*)::int AS n FROM player_chat_direct_threads WHERE $1 IN (participant_a_player_character_id, participant_b_player_character_id)',
        [b.link],
      ),
    ).toBe(2);
    // The other side changing owner also cuts the thread.
    await revoke(b);
    const bHeir = await heirOf(b.char);
    expect((await directHistory(bHeir, a.char).expect(200)).body.total).toBe(0);
    expect((await directHistory(heir, b.char).expect(200)).body.total).toBe(0);
    // Old messages still exist for their own participants' links only.
    expect(await messageCount('private from A')).toBe(1);
  });
  it('replays sends by Idempotency-Key without duplicates, conflicts on other content', async () => {
    const [p, other, peer] = [await party(), await party(), await party()];
    const key = randomUUID();
    const first = await global(p, 'once', key).expect(201);
    const again = await global(p, 'once', key).expect(201);
    expect(again.body).toEqual(first.body);
    // Leave exactly one free slot: the concurrent retries below share it.
    for (let i = 0; i < 3; i++) await global(p, `filler ${i}`).expect(201);
    // Eight concurrent retries of one new key: one message. Holding the
    // sender link makes them truly overlap: all pass the quota check before
    // any commits, so they must share the one free slot.
    const burstKey = randomUUID();
    const blocker = database.createQueryRunner();
    await blocker.connect();
    await blocker.startTransaction();
    await blocker.query(
      'SELECT 1 FROM player_characters WHERE id = $1 FOR UPDATE',
      [p.link],
    );
    const pending = Array.from({ length: 8 }, () =>
      global(p, 'burst', burstKey).then((r) => r),
    );
    await quiet();
    await blocker.rollbackTransaction();
    await blocker.release();
    const burst = await Promise.all(pending);
    expect(burst.map((r) => r.status)).toEqual(Array(8).fill(201));
    expect(new Set(burst.map((r) => r.body.messageId)).size).toBe(1);
    expect(await messageCount('burst')).toBe(1);
    // Same key, other content, channel or target: 409.
    await global(p, 'different', key).expect(409);
    await direct(p, peer.char, 'once', key).expect(409);
    await post(
      p.session,
      'chat/global',
      { characterLinkId: (await party()).link, message: 'once' },
      key,
    ).expect(409);
    expect(await messageCount('different')).toBe(0);
    // Keys are per player: another player's same key is independent.
    const theirs = await global(other, 'once', key).expect(201);
    expect(theirs.body.messageId).not.toBe(first.body.messageId);
    // Concurrent sends with different keys are distinct messages.
    const distinct = await Promise.all(
      [1, 2, 3].map((n) => global(peer, `distinct ${n}`)),
    );
    expect(new Set(distinct.map((r) => r.body.messageId)).size).toBe(3);
    // DIRECT replays answer with the same message and target.
    const dmKey = randomUUID();
    const dm = await direct(peer, p.char, 'dm once', dmKey).expect(201);
    expect(
      (await direct(peer, p.char, 'dm once', dmKey).expect(201)).body,
    ).toEqual(dm.body);
    // A replay only answers while the player still owns the sender link.
    await revoke(p);
    await global(p, 'once', key).expect(404);
    const [row] = await database.query(
      'SELECT idempotency_scope FROM player_chat_requests WHERE idempotency_key = $1 AND player_id = $2',
      [key, p.session.player.id],
    );
    expect(row.idempotency_scope).toBe(`PLAYER:${p.session.player.id}`);
    expect(JSON.stringify(first.body)).not.toContain('PLAYER:');
  });
  it('rate limits sends per player and character, sparing idempotent retries and failed sends', async () => {
    const p = await party();
    const keys = Array.from({ length: 5 }, () => randomUUID());
    for (const [i, key] of keys.entries())
      await global(p, `quota ${i}`, key).expect(201);
    const limited = await global(p, 'one too many').expect(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(10);
    expect(await messageCount('one too many')).toBe(0);
    // Retrying an accepted message is not a new send.
    await global(p, 'quota 0', keys[0]).expect(201);
    expect(await messageCount('quota 0')).toBe(1);
    // Another character of the same player has its own budget.
    const second = { ...p, link: await link(p.session) };
    await global(second, 'other character').expect(201);
    // Failed sends give their slot back.
    const q = await party();
    const nowhere = randomUUID();
    for (let i = 0; i < 4; i++) await global(q, `ok ${i}`).expect(201);
    for (let i = 0; i < 3; i++)
      await toGroup(q, nowhere, 'no group').expect(404);
    await global(q, 'fifth').expect(201);
    await global(q, 'sixth').expect(429);
  });
  it('hides expired messages without deleting them and keeps live ones', async () => {
    const p = await party();
    await insertMessage(p, 'expired long ago', '8 days', '-1 day');
    await insertMessage(p, 'expired just now', '7 days', '-1 second');
    await insertMessage(p, 'still live', '6 days', '1 day');
    const history = (await globalHistory(p, '?limit=100').expect(200)).body;
    expect(texts(history)).toContain('still live');
    expect(texts(history)).not.toContain('expired long ago');
    expect(texts(history)).not.toContain('expired just now');
    expect(await messageCount('expired long ago')).toBe(1);
  });
  it('blocks new messages on a disabled server while history stays readable', async () => {
    const closed = await servers.register({
      code: randomUUID(),
      name: 'Closed',
    });
    const [a, b] = [await party(closed), await party(closed)];
    const { groupId } = await groupOf(a, b);
    const { guildId } = await guildOf(a, b);
    await global(a, 'g').expect(201);
    await direct(a, b.char, 'd').expect(201);
    await toGroup(a, groupId, 'gr').expect(201);
    await toGuild(a, guildId, 'gu').expect(201);
    const sb = await connected(b.session);
    await enable(closed, false);
    try {
      for (const send of [
        global(a, 'blocked'),
        direct(a, b.char, 'blocked'),
        toGroup(a, groupId, 'blocked'),
        toGuild(a, guildId, 'blocked'),
      ])
        expect((await send.expect(409)).body.message).toBe(
          'Game server disabled',
        );
      expect(await messageCount('blocked')).toBe(0);
      expect(texts((await globalHistory(b).expect(200)).body)).toEqual(['g']);
      expect(texts((await directHistory(b, a.char).expect(200)).body)).toEqual([
        'd',
      ]);
      expect(texts((await groupHistory(b, groupId).expect(200)).body)).toEqual([
        'gr',
      ]);
      expect(texts((await guildHistory(b, guildId).expect(200)).body)).toEqual([
        'gu',
      ]);
      await quiet();
      expect(chatEvents(sb)).toEqual([]);
    } finally {
      await enable(closed, true);
    }
  });
  it('decides authorization in the database when revokes, leaves and kicks race sends', async () => {
    // Ownership revoke racing a GLOBAL send: either it was sent, or 404.
    for (let i = 0; i < 3; i++) {
      const p = await party();
      const content = `race revoke ${randomUUID()}`;
      const [sent] = await Promise.all([global(p, content), revoke(p)]);
      expect([201, 404]).toContain(sent.status);
      expect(await messageCount(content)).toBe(sent.status === 201 ? 1 : 0);
      await global(p, 'after revoke').expect(404);
    }
    // Leave racing a GROUP send.
    for (let i = 0; i < 3; i++) {
      const [leader, member] = [await party(), await party()];
      const { groupId } = await groupOf(leader, member);
      const content = `race leave ${randomUUID()}`;
      const [sent, left] = await Promise.all([
        toGroup(member, groupId, content),
        post(
          member.session,
          `groups/${groupId}/leave`,
          { characterLinkId: member.link },
          null,
        ),
      ]);
      expect(left.status).toBe(200);
      expect([201, 404]).toContain(sent.status);
      expect(await messageCount(content)).toBe(sent.status === 201 ? 1 : 0);
      await toGroup(member, groupId, 'after leave').expect(404);
    }
    // Kick racing a GUILD send.
    for (let i = 0; i < 3; i++) {
      const [master, member] = [await party(), await party()];
      const { guildId, memberId } = await guildOf(master, member);
      const content = `race kick ${randomUUID()}`;
      const [sent, kicked] = await Promise.all([
        toGuild(member, guildId, content),
        post(
          master.session,
          `guilds/${guildId}/members/${memberId(member)}/kick`,
          { actorCharacterLinkId: master.link },
          null,
        ),
      ]);
      expect(kicked.status).toBe(200);
      expect([201, 404]).toContain(sent.status);
      expect(await messageCount(content)).toBe(sent.status === 201 ? 1 : 0);
      await toGuild(member, guildId, 'after kick').expect(404);
    }
    // Concurrent first DIRECT messages from both sides share one thread.
    const [a, b] = [await party(), await party()];
    const both = await Promise.all([
      direct(a, b.char, 'a first'),
      direct(b, a.char, 'b first'),
    ]);
    expect(both.map((r) => r.status)).toEqual([201, 201]);
    expect(
      texts((await directHistory(a, b.char).expect(200)).body).sort(),
    ).toEqual(['a first', 'b first']);
  });
  it('records no Audit for chat messages', async () => {
    const [a, b] = [await party(), await party()];
    const before = await count('SELECT count(*)::int AS n FROM audit_logs');
    await global(a, 'not audited').expect(201);
    await direct(a, b.char, 'not audited either').expect(201);
    expect(await count('SELECT count(*)::int AS n FROM audit_logs')).toBe(
      before,
    );
    const { body: docs } = await http().get('/docs-json').expect(200);
    expect(
      Object.keys(docs.components.schemas.SendChatBodyDto.properties).sort(),
    ).toEqual(['characterLinkId', 'message']);
    expect(
      Object.keys(docs.components.schemas.ChatMessageDto.properties).sort(),
    ).toEqual(MESSAGE_KEYS);
    // Player chat routes; Staff moderation (12.4) lives under /operations.
    expect(
      Object.keys(docs.paths)
        .filter(
          (p) => p.includes('chat') && !p.startsWith('/api/v1/operations/'),
        )
        .sort(),
    ).toEqual([
      '/api/v1/player/chat/direct/{targetCharacterId}',
      '/api/v1/player/chat/global',
      '/api/v1/player/groups/{groupId}/chat',
      '/api/v1/player/guilds/{guildId}/chat',
      '/api/v1/player/me/characters/{characterLinkId}/chat/direct/{targetCharacterId}',
      '/api/v1/player/me/characters/{characterLinkId}/chat/global',
    ]);
  });
  it('refuses to revert while chat messages exist', async () => {
    // No credentials, entitlements or settings here: 11.3, 11.1, 10.17 and 10.16
    // revert, then 10.15 refuses and is kept.
    await database.undoLastMigration(); // Etapa 12.5 Multi-instance
    await database.undoLastMigration(); // Etapa 12.4 Operational Recovery
    await database.undoLastMigration(); // Etapa 11.4 Agent Domain Events
    await database.undoLastMigration(); // Etapa 11.3 Server Control Transport
    await database.undoLastMigration();
    await database.undoLastMigration();
    await database.undoLastMigration();
    await expect(database.undoLastMigration()).rejects.toThrow(
      'chat messages exist',
    );
    expect(await database.runMigrations()).toHaveLength(7);
    expect(await database.showMigrations()).toBe(false);
    expect(await database.query('SELECT * FROM migrations')).toHaveLength(27);
  });
});
