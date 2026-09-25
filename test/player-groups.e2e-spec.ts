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
import { PlayerAuthRateLimiter } from '../src/player-auth/player-auth-rate-limit.js';
import { MAX_GROUP_MEMBERS } from '../src/player-groups/player-group.contracts.js';
import { FakeDiscordProvider } from './support/fake-discord-provider.js';

const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;
interface Session {
  accessToken: string;
  player: { id: string };
}
describeDatabase('Player groups with real PostgreSQL', () => {
  let admin: DataSource, database: DataSource, app: INestApplication<App>;
  let links: CharacterLinkService, servers: GameServerService;
  let server: GameServer, staffToken: string;
  const discord = new FakeDiscordProvider();
  // Test-side map from a link to its public game id (what a real inviter knows).
  const characterIds = new Map<string, string>();
  const schema = `player_groups_test_${randomUUID().replaceAll('-', '')}`;
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
  ) => {
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
  const create = async (session: Session, link: string) =>
    (await post(session, 'groups', { characterLinkId: link }).expect(201)).body;
  const invite = (
    session: Session,
    groupId: string,
    actor: string,
    target: string,
  ) =>
    post(session, `groups/${groupId}/invites`, {
      actorCharacterLinkId: actor,
      targetCharacterId: characterIds.get(target) ?? `char:${randomUUID()}`,
    });
  const accept = (session: Session, inviteId: string) =>
    post(session, `group-invites/${inviteId}/accept`);
  // A group led by `leader` with `extra` accepted members; returns everything.
  const party = async (extra: number) => {
    const leader = await login();
    const leaderLink = await character(leader);
    const group = await create(leader, leaderLink);
    const members: { session: Session; link: string; memberId: string }[] = [];
    for (let i = 0; i < extra; i++) {
      const session = await login();
      const link = await character(session);
      const invited = (
        await invite(leader, group.id, leaderLink, link).expect(201)
      ).body;
      const joined = (await accept(session, invited.inviteId).expect(200)).body;
      members.push({
        session,
        link,
        memberId: joined.members.find(
          (m: { characterLinkId: string | null }) => m.characterLinkId === link,
        ).memberId,
      });
    }
    return { leader, leaderLink, group, members };
  };
  const audits = (groupId: string) =>
    database.query(
      'SELECT action, actor_type, actor_player_id, actor_role, metadata FROM audit_logs WHERE resource_id = $1 ORDER BY created_at, action',
      [groupId],
    );
  const activeMembers = async (groupId: string) =>
    (
      await database.query(
        'SELECT count(*)::int AS n FROM player_group_members WHERE group_id = $1 AND left_at IS NULL',
        [groupId],
      )
    )[0].n;
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
    expect(await database.runMigrations()).toHaveLength(23);
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
    links = app.get(CharacterLinkService);
    servers = app.get(GameServerService);
    server = await servers.register({ code: randomUUID(), name: 'Groups' });
    const password = 'Groups-Staff-Password-42';
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
  afterAll(async () => {
    await app?.close();
    if (database?.isInitialized) await database.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  it('adds the three group tables with database-enforced membership invariants', async () => {
    expect(database.options.synchronize).toBe(false);
    expect(await database.showMigrations()).toBe(false);
    expect(await database.query('SELECT * FROM migrations')).toHaveLength(23);
    const diff = await database.driver.createSchemaBuilder().log();
    expect([diff.upQueries, diff.downQueries]).toEqual([[], []]);
    const owner = await login();
    const link = await character(owner);
    const other = await character(owner);
    const group = async () =>
      (
        await database.query(
          'INSERT INTO player_groups(game_server_id) VALUES ($1) RETURNING id',
          [server.id],
        )
      )[0].id;
    const [g1, g2] = [await group(), await group()];
    const member = (groupId: string, linkId: string, role: string) =>
      database.query(
        'INSERT INTO player_group_members(group_id, player_character_id, role, joined_at) VALUES ($1, $2, $3, now())',
        [groupId, linkId, role],
      );
    await member(g1, link, 'LEADER');
    await expect(member(g2, link, 'MEMBER')).rejects.toMatchObject({
      driverError: { code: '23505' },
    });
    await expect(member(g1, other, 'LEADER')).rejects.toMatchObject({
      driverError: { code: '23505' },
    });
    await expect(member(g1, other, 'OWNER')).rejects.toMatchObject({
      driverError: { code: '23514' },
    });
    await expect(
      database.query(
        "UPDATE player_groups SET status = 'DISBANDED' WHERE id = $1",
        [g1],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23514' } });
    const pendingInvite = () =>
      database.query(
        "INSERT INTO player_group_invites(group_id, target_player_character_id, invited_by_player_character_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 minute')",
        [g1, other, link],
      );
    await pendingInvite();
    await expect(pendingInvite()).rejects.toMatchObject({
      driverError: { code: '23505' },
    });
    await expect(
      database.query(
        "UPDATE player_group_invites SET status = 'ACCEPTED' WHERE group_id = $1",
        [g1],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23514' } });
  });
  it('creates a group with its leader atomically and audits it', async () => {
    const leader = await login();
    const link = await character(leader);
    const created = await post(leader, 'groups', {
      characterLinkId: link,
    }).expect(201);
    expect(created.body).toEqual({
      id: expect.any(String),
      gameServerId: server.id,
      status: 'ACTIVE',
      maxMembers: MAX_GROUP_MEMBERS,
      members: [
        {
          memberId: expect.any(String),
          characterId: expect.any(String),
          role: 'LEADER',
          joinedAt: expect.any(String),
          characterLinkId: link,
        },
      ],
      createdAt: expect.any(String),
    });
    expect(
      (await get(leader, `groups/${created.body.id}`).expect(200)).body,
    ).toEqual(created.body);
    await post(leader, 'groups', { characterLinkId: link }).expect(409);
    const [entry] = await audits(created.body.id);
    expect(entry).toMatchObject({
      action: 'PLAYER_GROUP_CREATED',
      actor_type: 'PLAYER',
      actor_player_id: leader.player.id,
      actor_role: null,
    });
    expect(entry.metadata).toEqual({
      groupId: created.body.id,
      gameServerId: server.id,
      characterLinkId: link,
      memberId: created.body.members[0].memberId,
    });
    for (const body of [
      {},
      { characterLinkId: 'x' },
      { characterLinkId: link, playerId: randomUUID() },
    ])
      await post(leader, 'groups', body).expect(400);
    await post(staffToken, 'groups', { characterLinkId: link }).expect(401);
  });
  it('requires an own VERIFIED character: PENDING, REVOKED and foreign links give 404', async () => {
    const a = await login();
    const b = await login();
    for (const link of [
      await character(a, 'PENDING'),
      await character(a, 'REVOKED'),
      await character(b),
      randomUUID(),
    ])
      expect(
        (await post(a, 'groups', { characterLinkId: link }).expect(404)).body
          .message,
      ).toBe('Character not found');
    const off = await servers.register({ code: randomUUID(), name: 'Off' });
    const offLink = await character(a, 'VERIFIED', off);
    await database.query(
      'UPDATE game_servers SET enabled = false WHERE id = $1',
      [off.id],
    );
    await post(a, 'groups', { characterLinkId: offLink }).expect(409);
  });
  it('invites idempotently up to five members, hiding other players and enforcing the leader', async () => {
    const { leader, leaderLink, group, members } = await party(
      MAX_GROUP_MEMBERS - 1,
    );
    expect(await activeMembers(group.id)).toBe(5);
    const view = (
      await get(members[0].session, `groups/${group.id}`).expect(200)
    ).body;
    expect(view.members).toHaveLength(5);
    expect(
      view.members.filter(
        (m: { characterLinkId: string | null }) => m.characterLinkId,
      ),
    ).toEqual([
      expect.objectContaining({
        characterLinkId: members[0].link,
        role: 'MEMBER',
      }),
    ]);
    expect(JSON.stringify(view)).not.toMatch(/playerId|providerSubject/);
    const outsider = await login();
    const outsiderLink = await character(outsider);
    expect(
      (await invite(leader, group.id, leaderLink, outsiderLink).expect(409))
        .body.message,
    ).toBe('Group full');
    await get(outsider, `groups/${group.id}`).expect(404);
    // Non-leader member → 403; non-member → 404; foreign actor link → 404.
    await invite(
      members[0].session,
      group.id,
      members[0].link,
      outsiderLink,
    ).expect(403);
    await invite(outsider, group.id, outsiderLink, members[0].link).expect(404);
    await invite(leader, group.id, members[0].link, outsiderLink).expect(404);
    const small = await party(0);
    const target = await login();
    const targetLink = await character(target);
    const first = await invite(
      small.leader,
      small.group.id,
      small.leaderLink,
      targetLink,
    ).expect(201);
    const again = await invite(
      small.leader,
      small.group.id,
      small.leaderLink,
      targetLink,
    ).expect(200);
    expect(again.body).toEqual(first.body);
    expect(first.body).toMatchObject({
      groupId: small.group.id,
      gameServerId: server.id,
      targetCharacterId: characterIds.get(targetLink),
      status: 'PENDING',
      respondedAt: null,
    });
    expect(
      (await audits(small.group.id)).filter(
        (e: { action: string }) => e.action === 'PLAYER_GROUP_INVITED',
      ),
    ).toHaveLength(1);
    const listed = (await get(target, 'group-invites').expect(200)).body.items;
    expect(listed.map((i: { inviteId: string }) => i.inviteId)).toEqual([
      first.body.inviteId,
    ]);
    expect(
      (await get(outsider, 'group-invites').expect(200)).body.items,
    ).toEqual([]);
    // Already grouped → 409; a character only on another server does not resolve.
    const elsewhere = await servers.register({
      code: randomUUID(),
      name: 'Elsewhere',
    });
    await invite(
      small.leader,
      small.group.id,
      small.leaderLink,
      await character(target, 'VERIFIED', elsewhere),
    ).expect(404);
    await invite(
      small.leader,
      small.group.id,
      small.leaderLink,
      members[1].link,
    ).expect(409);
    await invite(
      small.leader,
      small.group.id,
      small.leaderLink,
      await character(target, 'PENDING'),
    ).expect(404);
    await invite(
      small.leader,
      small.group.id,
      small.leaderLink,
      randomUUID(),
    ).expect(404);
  });
  it('invites by public character id only and never exposes ownership ids', async () => {
    const { leader, leaderLink, group } = await party(0);
    const target = await login();
    const targetLink = await character(target);
    const targetCharacterId = characterIds.get(targetLink)!;
    const path = `groups/${group.id}/invites`;
    for (const body of [
      { actorCharacterLinkId: leaderLink, targetCharacterLinkId: targetLink },
      {
        actorCharacterLinkId: leaderLink,
        targetCharacterId,
        targetCharacterLinkId: targetLink,
      },
      { actorCharacterLinkId: leaderLink, targetPlayerId: target.player.id },
      {
        actorCharacterLinkId: leaderLink,
        targetCharacterId,
        targetPlayerId: target.player.id,
      },
      {
        actorCharacterLinkId: leaderLink,
        targetCharacterId,
        gameServerId: server.id,
      },
      { actorCharacterLinkId: leaderLink },
    ])
      await post(leader, path, body).expect(400);
    // Same opaque external-id rules as the rest of the backend.
    for (const targetCharacterId of [
      '',
      '   ',
      'x'.repeat(129),
      'char\u0000x',
      'char\nx',
      'char\u009fx',
      '\ud800',
      123,
      null,
    ])
      await post(leader, path, {
        actorCharacterLinkId: leaderLink,
        targetCharacterId,
      }).expect(400);
    const longOwner = await login();
    const longId = 'á'.repeat(128);
    const longRequest = await links.request(playerActor(longOwner.player.id), {
      gameServerId: server.id,
      characterExternalId: longId,
    });
    await links.confirmFromAgent({
      challenge: longRequest.challenge,
      gameServerId: server.id,
      characterExternalId: longId,
    });
    const longInvite = await post(leader, path, {
      actorCharacterLinkId: leaderLink,
      targetCharacterId: longId,
    }).expect(201);
    expect(longInvite.body.targetCharacterId).toBe(longId);
    // PENDING, REVOKED, unknown and other-server targets share one generic 404.
    const other = await servers.register({ code: randomUUID(), name: 'Other' });
    const unresolved = [
      await character(target, 'PENDING'),
      await character(target, 'REVOKED'),
      await character(target, 'VERIFIED', other),
    ].map((link) => characterIds.get(link)!);
    const misses = await Promise.all(
      [...unresolved, `char:${randomUUID()}`].map((id) =>
        post(leader, path, {
          actorCharacterLinkId: leaderLink,
          targetCharacterId: id,
        }).expect(404),
      ),
    );
    expect(new Set(misses.map((r) => r.body.message))).toEqual(
      new Set(['Character not available']),
    );
    const created = await post(leader, path, {
      actorCharacterLinkId: leaderLink,
      targetCharacterId: ` ${targetCharacterId} `,
    }).expect(201);
    expect(Object.keys(created.body).sort()).toEqual([
      'createdAt',
      'expiresAt',
      'gameServerId',
      'groupId',
      'inviteId',
      'invitedByCharacterId',
      'respondedAt',
      'status',
      'targetCharacterId',
    ]);
    expect(created.body.targetCharacterId).toBe(targetCharacterId);
    const [listed] = (await get(target, 'group-invites').expect(200)).body
      .items;
    expect(listed).toEqual(created.body);
    for (const text of [JSON.stringify(created.body), JSON.stringify(listed)]) {
      expect(text).not.toContain(targetLink);
      expect(text).not.toContain(leaderLink);
      expect(text).not.toContain(target.player.id);
      expect(text).not.toContain(leader.player.id);
    }
    const joined = (await accept(target, created.body.inviteId).expect(200))
      .body;
    const leaderView = (await get(leader, `groups/${group.id}`).expect(200))
      .body;
    expect(leaderView.members).toEqual([
      expect.objectContaining({
        role: 'LEADER',
        characterId: characterIds.get(leaderLink),
        characterLinkId: leaderLink,
      }),
      expect.objectContaining({
        role: 'MEMBER',
        characterId: targetCharacterId,
        characterLinkId: null,
      }),
    ]);
    expect(joined.members).toEqual([
      expect.objectContaining({ role: 'LEADER', characterLinkId: null }),
      expect.objectContaining({ role: 'MEMBER', characterLinkId: targetLink }),
    ]);
    expect(JSON.stringify(leaderView)).not.toContain(targetLink);
    expect(JSON.stringify(joined)).not.toContain(leaderLink);
    // Knowing a character id grants nothing beyond being invited.
    await http()
      .get(`/api/v1/player/me/characters/${targetLink}`)
      .auth(leader.accessToken, { type: 'bearer' })
      .expect(404);
  });
  it('lets only the target accept or decline, and expires stale invites', async () => {
    const { leader, leaderLink, group } = await party(0);
    const target = await login();
    const targetLink = await character(target);
    const stranger = await login();
    const declined = (
      await invite(leader, group.id, leaderLink, targetLink).expect(201)
    ).body;
    await accept(stranger, declined.inviteId).expect(404);
    await post(leader, `group-invites/${declined.inviteId}/decline`).expect(
      404,
    );
    const answer = await post(
      target,
      `group-invites/${declined.inviteId}/decline`,
    ).expect(200);
    expect(answer.body).toMatchObject({
      status: 'DECLINED',
      respondedAt: expect.any(String),
    });
    await accept(target, declined.inviteId).expect(409);
    const stale = (
      await invite(leader, group.id, leaderLink, targetLink).expect(201)
    ).body;
    await database.query(
      "UPDATE player_group_invites SET created_at = now() - interval '1 hour', expires_at = now() - interval '1 second' WHERE id = $1",
      [stale.inviteId],
    );
    expect((await get(target, 'group-invites').expect(200)).body.items).toEqual(
      [],
    );
    expect(
      (await accept(target, stale.inviteId).expect(409)).body.message,
    ).toBe('Group invite expired');
    expect(
      (
        await database.query(
          'SELECT status FROM player_group_invites WHERE id = $1',
          [stale.inviteId],
        )
      )[0].status,
    ).toBe('EXPIRED');
    const fresh = (
      await invite(leader, group.id, leaderLink, targetLink).expect(201)
    ).body;
    expect(fresh.inviteId).not.toBe(stale.inviteId);
    const joined = (await accept(target, fresh.inviteId).expect(200)).body;
    expect(joined.members.map((m: { role: string }) => m.role)).toEqual([
      'LEADER',
      'MEMBER',
    ]);
    expect(
      (await audits(group.id)).map((e: { action: string }) => e.action),
    ).toEqual(
      expect.arrayContaining([
        'PLAYER_GROUP_INVITE_DECLINED',
        'PLAYER_GROUP_INVITE_ACCEPTED',
      ]),
    );
  });
  it('lets members leave, the leader kick, and disbands when the leader leaves', async () => {
    const { leader, leaderLink, group, members } = await party(3);
    const [first, second, third] = members;
    await post(first.session, `groups/${group.id}/leave`, {
      characterLinkId: first.link,
    }).expect(200);
    await get(first.session, `groups/${group.id}`).expect(404);
    await post(
      second.session,
      `groups/${group.id}/members/${third.memberId}/kick`,
    ).expect(403);
    const leaderMember = (await get(leader, `groups/${group.id}`).expect(200))
      .body.members[0].memberId;
    await post(
      leader,
      `groups/${group.id}/members/${leaderMember}/kick`,
    ).expect(400);
    const kicked = (
      await post(
        leader,
        `groups/${group.id}/members/${third.memberId}/kick`,
      ).expect(200)
    ).body;
    expect(kicked.members).toHaveLength(2);
    await get(third.session, `groups/${group.id}`).expect(404);
    await post(
      leader,
      `groups/${group.id}/members/${randomUUID()}/kick`,
    ).expect(404);
    const target = await login();
    const pendingInvite = (
      await invite(
        leader,
        group.id,
        leaderLink,
        await character(target),
      ).expect(201)
    ).body;
    expect(
      (
        await post(leader, `groups/${group.id}/leave`, {
          characterLinkId: leaderLink,
        }).expect(200)
      ).body,
    ).toEqual({
      status: 'DISBANDED',
    });
    await get(second.session, `groups/${group.id}`).expect(404);
    expect(await activeMembers(group.id)).toBe(0);
    expect(
      (
        await database.query(
          'SELECT status FROM player_group_invites WHERE id = $1',
          [pendingInvite.inviteId],
        )
      )[0].status,
    ).toBe('CANCELLED');
    // History is kept.
    expect(
      (
        await database.query(
          'SELECT count(*)::int AS n FROM player_group_members WHERE group_id = $1',
          [group.id],
        )
      )[0].n,
    ).toBe(4);
    const actions = (await audits(group.id)).map(
      (e: { action: string }) => e.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        'PLAYER_GROUP_MEMBER_LEFT',
        'PLAYER_GROUP_MEMBER_KICKED',
        'PLAYER_GROUP_DISBANDED',
      ]),
    );
  });
  it('disbands explicitly (leader only) and blocks every later action', async () => {
    const { leader, leaderLink, group, members } = await party(1);
    await post(members[0].session, `groups/${group.id}/disband`).expect(403);
    await post(leader, `groups/${group.id}/disband`).expect(200);
    const [row] = await database.query(
      'SELECT status, disbanded_at FROM player_groups WHERE id = $1',
      [group.id],
    );
    expect(row.status).toBe('DISBANDED');
    expect(row.disbanded_at).not.toBeNull();
    await post(leader, `groups/${group.id}/disband`).expect(404);
    await invite(leader, group.id, leaderLink, members[0].link).expect(404);
    await get(leader, `groups/${group.id}`).expect(404);
    // The characters are free to form new groups.
    await create(members[0].session, members[0].link);
    await create(leader, leaderLink);
  });
  it('requires current ownership for reads and actions after a link is revoked', async () => {
    const { group, members } = await party(1);
    const member = members[0];
    await links.revoke(playerActor(member.session.player.id), member.link);
    await get(member.session, `groups/${group.id}`).expect(404);
    await post(member.session, `groups/${group.id}/leave`, {
      characterLinkId: member.link,
    }).expect(404);
    // The membership itself is not transferred nor deleted (cleanup is future work).
    expect(await activeMembers(group.id)).toBe(2);
  });
  it('lets PostgreSQL decide concurrent creation, last-slot accepts, double joins and disband races', async () => {
    const solo = await login();
    const soloLink = await character(solo);
    const creations = await Promise.all(
      Array.from({ length: 6 }, () =>
        post(solo, 'groups', { characterLinkId: soloLink }),
      ),
    );
    expect(creations.map((r) => r.status).sort()).toEqual([
      201, 409, 409, 409, 409, 409,
    ]);
    const { leader, leaderLink, group } = await party(MAX_GROUP_MEMBERS - 2);
    const [x, y] = [await login(), await login()];
    const [xLink, yLink] = [await character(x), await character(y)];
    const [ix, iy] = [
      (await invite(leader, group.id, leaderLink, xLink).expect(201)).body,
      (await invite(leader, group.id, leaderLink, yLink).expect(201)).body,
    ];
    const lastSlot = await Promise.all([
      accept(x, ix.inviteId),
      accept(y, iy.inviteId),
    ]);
    expect(lastSlot.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await activeMembers(group.id)).toBe(MAX_GROUP_MEMBERS);
    const [g1, g2] = [await party(0), await party(0)];
    const both = await login();
    const bothLink = await character(both);
    const [i1, i2] = [
      (
        await invite(g1.leader, g1.group.id, g1.leaderLink, bothLink).expect(
          201,
        )
      ).body,
      (
        await invite(g2.leader, g2.group.id, g2.leaderLink, bothLink).expect(
          201,
        )
      ).body,
    ];
    const joins = await Promise.all([
      accept(both, i1.inviteId),
      accept(both, i2.inviteId),
    ]);
    expect(joins.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      (
        await database.query(
          'SELECT count(*)::int AS n FROM player_group_members WHERE player_character_id = $1 AND left_at IS NULL',
          [bothLink],
        )
      )[0].n,
    ).toBe(1);
    const race = await party(0);
    const joiner = await login();
    const joinerLink = await character(joiner);
    const raceInvite = (
      await invite(
        race.leader,
        race.group.id,
        race.leaderLink,
        joinerLink,
      ).expect(201)
    ).body;
    const [accepted, disbanded] = await Promise.all([
      accept(joiner, raceInvite.inviteId),
      post(race.leader, `groups/${race.group.id}/disband`),
    ]);
    expect(disbanded.status).toBe(200);
    expect([200, 409]).toContain(accepted.status);
    expect(await activeMembers(race.group.id)).toBe(0);
    const [finalInvite] = await database.query(
      'SELECT status FROM player_group_invites WHERE id = $1',
      [raceInvite.inviteId],
    );
    expect(finalInvite.status).toBe(
      accepted.status === 200 ? 'ACCEPTED' : 'CANCELLED',
    );
  });
  it('audits every mutation as PLAYER without identity data', async () => {
    const { group } = await party(1);
    const entries = await audits(group.id);
    for (const entry of entries) {
      expect(entry.actor_type).toBe('PLAYER');
      expect(entry.actor_role).toBeNull();
      expect(entry.metadata).toMatchObject({
        groupId: group.id,
        gameServerId: server.id,
      });
      expect(JSON.stringify(entry.metadata)).not.toMatch(
        /token|subject|playerId/i,
      );
    }
  });
  it('reverts only the group tables and reapplies cleanly', async () => {
    await database.undoLastMigration(); // Etapa 11.1 Game Agent Transport
    await database.undoLastMigration(); // Etapa 10.17 VIP Entitlements
    await database.undoLastMigration(); // Etapa 10.16 Player Settings
    await database.undoLastMigration(); // Etapa 10.15 Player Chat
    await database.undoLastMigration(); // Etapa 10.14 Player Marketplace
    await database.undoLastMigration(); // Etapa 10.13 Player Trades
    await database.undoLastMigration(); // Etapa 10.12 Economy
    await database.undoLastMigration(); // Etapa 10.9 Player Guilds
    await database.undoLastMigration();
    expect(
      await database.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename LIKE 'player_group%'",
        [schema],
      ),
    ).toEqual([]);
    expect(await database.runMigrations()).toHaveLength(9);
    expect(await database.runMigrations()).toHaveLength(0);
    expect(
      (await database.driver.createSchemaBuilder().log()).upQueries,
    ).toEqual([]);
  });
});
