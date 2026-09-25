import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { DataSource } from 'typeorm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { decodeJwt, SignJWT } from 'jose';
import { compiledDatabaseArtifacts } from './compiled-database.js';
import { loadEnvironment } from '../src/config/environment.js';
import type { ApplicationConfig } from '../src/config/environment.js';
import { createDatabaseOptions } from '../src/database/database.options.js';
import { setupApp } from '../src/setup-app.js';
import { AppExpressAdapter } from '../src/common/http/app-express.adapter.js';
import { PasswordService } from '../src/auth/password.service.js';
import { playerActor } from '../src/actors/actor.contracts.js';
import { GameServerService } from '../src/game-bridge/game-server.service.js';
import type { GameServer } from '../src/game-bridge/entities/game-server.entity.js';
import { DiscordIdentityProvider } from '../src/player-auth/discord-identity.provider.js';
import { PlayerAuthRateLimiter } from '../src/player-auth/player-auth-rate-limit.js';
import { CharacterLinkService } from '../src/player-characters/character-link.service.js';
import { RealtimeConnectionRegistry } from '../src/realtime/realtime-connection.registry.js';
import { FakeDiscordProvider } from './support/fake-discord-provider.js';
import { RealtimeTestClient } from './support/realtime-client.js';

const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;
interface Session {
  accessToken: string;
  refreshToken: string;
  player: { id: string };
}
describeDatabase('Realtime WebSocket foundation with real PostgreSQL', () => {
  let admin: DataSource, database: DataSource, app: INestApplication<App>;
  let links: CharacterLinkService, registry: RealtimeConnectionRegistry;
  let server: GameServer, url: string;
  let staff: {
    accessToken: string;
    refreshToken: string;
    staff: { id: string };
  };
  const clients: RealtimeTestClient[] = [];
  const discord = new FakeDiscordProvider();
  const characterIds = new Map<string, string>();
  const schema = `realtime_test_${randomUUID().replaceAll('-', '')}`;
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
  const character = async (session: Session) => {
    const characterExternalId = `char:${randomUUID()}`;
    const requested = await links.request(playerActor(session.player.id), {
      gameServerId: server.id,
      characterExternalId,
    });
    await links.confirmFromAgent({
      challenge: requested.challenge,
      gameServerId: server.id,
      characterExternalId,
    });
    characterIds.set(requested.link.id, characterExternalId);
    return requested.link.id;
  };
  const client = (path = '/api/v1/realtime') => {
    const created = new RealtimeTestClient(`${url}${path}`);
    clients.push(created);
    return created;
  };
  const connected = async (session: Session) => {
    const socket = client();
    expect(
      await socket.authenticate('PLAYER', session.accessToken),
    ).toMatchObject({
      type: 'AUTHENTICATED',
      surface: 'PLAYER',
    });
    return socket;
  };
  const post = (session: Session, path: string, body: object = {}) =>
    http()
      .post(`/api/v1/player/${path}`)
      .auth(session.accessToken, { type: 'bearer' })
      .send(body);
  beforeAll(async () => {
    // Short AUTH window for the timeout test; read when the app config loads.
    process.env.REALTIME_AUTH_TIMEOUT_MS = '300';
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
    registry = app.get(RealtimeConnectionRegistry);
    server = await app
      .get(GameServerService)
      .register({ code: randomUUID(), name: 'Realtime' });
    const password = 'Realtime-Staff-Password-42';
    await database.query(
      "INSERT INTO staff_users(username, display_name, password_hash, role_name) VALUES ('coordinator', 'C', $1, 'COORDINATOR')",
      [await new PasswordService().hash(password)],
    );
    staff = (
      await http()
        .post('/api/v1/auth/login')
        .send({ username: 'coordinator', password })
        .expect(200)
    ).body;
  }, 60000);
  beforeEach(() => app.get(PlayerAuthRateLimiter).reset());
  afterEach(async () => {
    const open = clients.splice(0);
    for (const socket of open) if (!socket.closed) await socket.close();
    // Server-side close handlers must have removed every registration.
    if (open.length)
      await open[0].until(() => registry.count() === 0 || undefined);
  });
  afterAll(async () => {
    delete process.env.REALTIME_AUTH_TIMEOUT_MS;
    await app?.close();
    if (database?.isInitialized) await database.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  it('authenticates player and staff sockets with their own access tokens and registers them', async () => {
    const player = await login();
    const socket = client();
    const ack = await socket.authenticate('PLAYER', player.accessToken);
    expect(ack).toEqual({
      type: 'AUTHENTICATED',
      surface: 'PLAYER',
      expiresAt: new Date(
        decodeJwt(player.accessToken).exp! * 1000,
      ).toISOString(),
    });
    expect(registry.count(`PLAYER:${player.player.id}`)).toBe(1);
    const staffSocket = client();
    expect(
      await staffSocket.authenticate('STAFF', staff.accessToken),
    ).toMatchObject({
      type: 'AUTHENTICATED',
      surface: 'STAFF',
    });
    expect(registry.count(`STAFF:${staff.staff.id}`)).toBe(1);
    expect(registry.count(`PLAYER:${staff.staff.id}`)).toBe(0);
  });
  it('closes sockets whose token does not match the surface, is invalid or is a refresh token', async () => {
    const player = await login();
    for (const [surface, token] of [
      ['STAFF', player.accessToken],
      ['PLAYER', staff.accessToken],
      ['PLAYER', 'not-a-jwt'],
      ['PLAYER', player.refreshToken],
      ['STAFF', staff.refreshToken],
    ] as const) {
      const socket = client();
      expect(await socket.authenticate(surface, token)).toEqual({
        closed: { code: 4001, reason: 'UNAUTHORIZED' },
      });
      expect(socket.messages).toEqual([]);
    }
    expect(registry.count()).toBe(0);
  });
  it('closes sockets that never authenticate or break the protocol', async () => {
    const silent = client();
    await silent.open();
    expect(await silent.closedWith(2000)).toEqual({
      code: 4000,
      reason: 'AUTH_TIMEOUT',
    });
    const player = await login();
    for (const frame of [
      'not json',
      { type: 'SUBSCRIBE', room: 'group:any' },
      {
        type: 'AUTH',
        surface: 'PLAYER',
        token: player.accessToken,
        playerId: randomUUID(),
      },
    ]) {
      const socket = client();
      await socket.open();
      socket.send(frame);
      expect(await socket.closedWith()).toEqual({
        code: 4003,
        reason: 'PROTOCOL_ERROR',
      });
    }
    const chatty = await connected(player);
    chatty.send({ type: 'AUTH', surface: 'PLAYER', token: player.accessToken });
    expect(await chatty.closedWith()).toEqual({
      code: 4003,
      reason: 'PROTOCOL_ERROR',
    });
    await chatty.until(
      () => registry.count(`PLAYER:${player.player.id}`) === 0 || undefined,
    );
  });
  it('rejects tokens in the URL and unknown paths at the handshake', async () => {
    const player = await login();
    for (const path of [
      `/api/v1/realtime?token=${player.accessToken}`,
      '/api/v1/realtime?x=1',
      '/api/v1/other',
    ]) {
      const socket = client(path);
      const closed = await socket.closedWith();
      expect(socket.opened).toBe(false);
      expect(closed.code).toBe(1006);
    }
  });
  it('closes the socket when the access token expires and on account suspension at connect', async () => {
    const player = await login();
    const config = app
      .get(ConfigService)
      .get<ApplicationConfig>('application')!;
    const now = Math.floor(Date.now() / 1000);
    // A validly signed access token for the same live session, expiring soon.
    const shortLived = await new SignJWT({
      sid: decodeJwt(player.accessToken).sid,
      kind: 'access',
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(player.player.id)
      .setIssuer('skyrim-player-api')
      .setAudience('skyrim-player-access')
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + 2)
      .sign(new TextEncoder().encode(config.playerAuth.accessSecret));
    const socket = client();
    expect(await socket.authenticate('PLAYER', shortLived)).toMatchObject({
      type: 'AUTHENTICATED',
    });
    expect(await socket.closedWith(4000)).toEqual({
      code: 4002,
      reason: 'TOKEN_EXPIRED',
    });
    await socket.until(
      () => registry.count(`PLAYER:${player.player.id}`) === 0 || undefined,
    );
    await database.query(
      "UPDATE players SET status = 'SUSPENDED' WHERE id = $1",
      [player.player.id],
    );
    try {
      expect(await client().authenticate('PLAYER', player.accessToken)).toEqual(
        {
          closed: { code: 4001, reason: 'UNAUTHORIZED' },
        },
      );
    } finally {
      await database.query(
        "UPDATE players SET status = 'ACTIVE' WHERE id = $1",
        [player.player.id],
      );
    }
  });
  it('fans group events out only to relevant players, on every connection, with a safe envelope', async () => {
    const [leader, target, stranger] = [
      await login(),
      await login(),
      await login(),
    ];
    const [leaderLink, targetLink] = [
      await character(leader),
      await character(target),
    ];
    const leaderSockets = [await connected(leader), await connected(leader)];
    const targetSocket = await connected(target);
    const strangerSocket = await connected(stranger);
    const staffSocket = client();
    await staffSocket.authenticate('STAFF', staff.accessToken);
    expect(registry.count(`PLAYER:${leader.player.id}`)).toBe(2);
    const group = (
      await post(leader, 'groups', { characterLinkId: leaderLink }).expect(201)
    ).body;
    for (const socket of leaderSockets) {
      const event = await socket.event('GROUP_CREATED');
      expect(Object.keys(event).sort()).toEqual([
        'data',
        'eventId',
        'occurredAt',
        'type',
      ]);
      expect(event.data).toEqual({
        groupId: group.id,
        gameServerId: server.id,
        memberId: group.members[0].memberId,
      });
    }
    const invite = (
      await post(leader, `groups/${group.id}/invites`, {
        actorCharacterLinkId: leaderLink,
        targetCharacterId: characterIds.get(targetLink),
      }).expect(201)
    ).body;
    const invited = await targetSocket.event('GROUP_INVITE_CREATED');
    // Events carry the public game id, never another player's ownership id.
    expect(invited.data).toMatchObject({
      targetCharacterId: characterIds.get(targetLink),
    });
    expect(
      JSON.stringify(await leaderSockets[0].event('GROUP_INVITE_CREATED')),
    ).not.toContain(targetLink);
    expect(invited.data).toMatchObject({
      groupId: group.id,
      inviteId: invite.inviteId,
    });
    for (const socket of leaderSockets)
      await socket.event('GROUP_INVITE_CREATED');
    await post(target, `group-invites/${invite.inviteId}/accept`).expect(200);
    for (const socket of [...leaderSockets, targetSocket]) {
      await socket.event('GROUP_INVITE_ACCEPTED');
      await socket.event('GROUP_MEMBER_JOINED');
    }
    const ids = leaderSockets[0].events().map((e) => e.eventId);
    expect(leaderSockets[1].events().map((e) => e.eventId)).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(strangerSocket.events()).toEqual([]);
    expect(staffSocket.events()).toEqual([]);
    const everything = JSON.stringify(
      [...leaderSockets, targetSocket].flatMap((s) => s.events()),
    );
    for (const secret of [
      leader.player.id,
      target.player.id,
      leader.accessToken,
    ])
      expect(everything).not.toContain(secret);
  });
  it('lets a reconnecting client rebuild state over HTTP and removes closed connections', async () => {
    const [leader, member] = [await login(), await login()];
    const [leaderLink, memberLink] = [
      await character(leader),
      await character(member),
    ];
    const group = (
      await post(leader, 'groups', { characterLinkId: leaderLink }).expect(201)
    ).body;
    const invite = (
      await post(leader, `groups/${group.id}/invites`, {
        actorCharacterLinkId: leaderLink,
        targetCharacterId: characterIds.get(memberLink),
      }).expect(201)
    ).body;
    const joined = (
      await post(member, `group-invites/${invite.inviteId}/accept`).expect(200)
    ).body;
    const memberSocket = await connected(member);
    await memberSocket.close();
    await memberSocket.until(
      () => registry.count(`PLAYER:${member.player.id}`) === 0 || undefined,
    );
    // Missed while disconnected: realtime is not the source of truth.
    const memberId = joined.members.find(
      (m: { characterLinkId: string | null }) =>
        m.characterLinkId === memberLink,
    ).memberId;
    await post(leader, `groups/${group.id}/members/${memberId}/kick`).expect(
      200,
    );
    const again = await connected(member);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(again.events()).toEqual([]);
    await http()
      .get(`/api/v1/player/groups/${group.id}`)
      .auth(member.accessToken, { type: 'bearer' })
      .expect(404);
    await again.close();
    await again.until(() => registry.count() === 0 || undefined);
  });
});
