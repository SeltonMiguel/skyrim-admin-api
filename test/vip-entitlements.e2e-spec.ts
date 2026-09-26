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
import {
  playerActor,
  staffActor,
  systemActor,
  SystemSource,
} from '../src/actors/actor.contracts.js';
import type { StaffActor } from '../src/actors/actor.contracts.js';
import { GameServerService } from '../src/game-bridge/game-server.service.js';
import type { GameServer } from '../src/game-bridge/entities/game-server.entity.js';
import { DiscordIdentityProvider } from '../src/player-auth/discord-identity.provider.js';
import { CharacterLinkService } from '../src/player-characters/character-link.service.js';
import { PlayerAuthRateLimiter } from '../src/player-auth/player-auth-rate-limit.js';
import { RealtimeConnectionRegistry } from '../src/realtime/realtime-connection.registry.js';
import { VipEntitlementService } from '../src/vip-entitlements/vip-entitlement.service.js';
import { VipEntitlementScope } from '../src/vip-entitlements/vip-entitlement.contracts.js';
import type {
  EntitlementTarget,
  GrantEntitlementInput,
  GrantEntitlementResult,
} from '../src/vip-entitlements/vip-entitlement.contracts.js';
import { RoleName } from '../src/rbac/roles.js';
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
const ENTITLEMENT_KEYS = [
  'entitlementId',
  'expiresAt',
  'grantedAt',
  'product',
  'scope',
];
const PRODUCT_KEYS = [
  'code',
  'currency',
  'description',
  'entitlementScope',
  'id',
  'name',
  'priceMinor',
  'rewards',
];
describeDatabase('VIP entitlements with real PostgreSQL', () => {
  let admin: DataSource, database: DataSource, app: INestApplication<App>;
  let links: CharacterLinkService, servers: GameServerService;
  let entitlements: VipEntitlementService;
  let registry: RealtimeConnectionRegistry;
  let server: GameServer, staffToken: string, staff: StaffActor, url: string;
  const discord = new FakeDiscordProvider();
  const clients: RealtimeTestClient[] = [];
  const schema = `vip_entitlements_test_${randomUUID().replaceAll('-', '')}`;
  const system = systemActor(SystemSource.VIP_DELIVERY);
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
  ) => {
    const actor = playerActor(session.player.id);
    const requested = await links.request(actor, {
      gameServerId: server.id,
      characterExternalId: char,
    });
    if (state !== 'PENDING')
      await links.confirmFromAgent({
        challenge: requested.challenge,
        gameServerId: server.id,
        characterExternalId: char,
      });
    if (state === 'REVOKED') await links.revoke(actor, requested.link.id);
    return requested.link.id;
  };
  const party = async (session?: Session): Promise<Party> => {
    const owner = session ?? (await login());
    const char = `char:${randomUUID()}`;
    return { session: owner, link: await link(owner, 'VERIFIED', char), char };
  };
  const heirOf = async (char: string): Promise<Party> => {
    const session = await login();
    return { session, link: await link(session, 'VERIFIED', char), char };
  };
  const adminHttp = () => ({
    post: (path: string, body: object) =>
      http()
        .post(`/api/v1/admin/vip-store/offers${path}`)
        .auth(staffToken, { type: 'bearer' })
        .send(body),
    patch: (path: string, body: object) =>
      http()
        .patch(`/api/v1/admin/vip-store/offers${path}`)
        .auth(staffToken, { type: 'bearer' })
        .send(body),
  });
  // An active offer of the Stage 08 catalog with an explicit scope.
  const offer = async (
    scope: 'PLAYER' | 'CHARACTER' = 'PLAYER',
    active = true,
  ) =>
    (
      await adminHttp()
        .post('', {
          code: `vip_${randomUUID().slice(0, 8)}`,
          name: 'VIP',
          description: 'Benefit',
          priceMinor: 990,
          currency: 'BRL',
          rewards: [{ type: 'TITLE', titleId: 'title:hero' }],
          entitlementScope: scope,
          active,
        })
        .expect(201)
    ).body as { id: string; code: string };
  const forPlayer = (p: Party | Session): EntitlementTarget => ({
    scope: VipEntitlementScope.PLAYER,
    playerId: 'session' in p ? p.session.player.id : p.player.id,
  });
  const forCharacter = (p: Party): EntitlementTarget => ({
    scope: VipEntitlementScope.CHARACTER,
    gameServerId: server.id,
    characterExternalId: p.char,
  });
  const grant = (
    offerId: string,
    target: EntitlementTarget,
    extra: Partial<GrantEntitlementInput> = {},
  ) =>
    entitlements.grant({
      offerId,
      target,
      actor: system,
      idempotencyKey: randomUUID(),
      ...extra,
    });
  const revoke = (entitlementId: string, idempotencyKey = randomUUID()) =>
    entitlements.revoke({ entitlementId, actor: staff, idempotencyKey });
  const get = (session: Session | string, path: string) =>
    http()
      .get(`/api/v1/player/${path}`)
      .auth(typeof session === 'string' ? session : session.accessToken, {
        type: 'bearer',
      });
  const account = (session: Session) => get(session, 'vip/entitlements');
  const character = (p: Party) =>
    get(p.session, `me/characters/${p.link}/vip/entitlements`);
  const effectiveView = (p: Party) =>
    get(p.session, `me/characters/${p.link}/vip/effective`);
  const ids = (body: { items: { entitlementId: string }[] }) =>
    body.items.map((e) => e.entitlementId);
  const audits = (entitlementId: string) =>
    database.query(
      'SELECT action, actor_type, actor_staff_id, actor_system_source, resource_type, metadata FROM audit_logs WHERE resource_id = $1 ORDER BY created_at',
      [entitlementId],
    );
  const count = async (sql: string, params: unknown[] = []) =>
    (await database.query(sql, params))[0].n as number;
  const activeRows = (offerId: string) =>
    count(
      "SELECT count(*)::int AS n FROM player_vip_entitlements WHERE vip_offer_id = $1 AND status = 'ACTIVE'",
      [offerId],
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
  const vipEvents = (socket: RealtimeTestClient, entitlementId?: string) =>
    socket
      .events()
      .filter(
        (e) =>
          String(e.type).startsWith('VIP_ENTITLEMENT_') &&
          (!entitlementId ||
            (e.data as { entitlementId: string }).entitlementId ===
              entitlementId),
      );
  const received = (
    socket: RealtimeTestClient,
    type: string,
    entitlementId: string,
  ) =>
    socket.until(() =>
      vipEvents(socket, entitlementId).find((e) => e.type === type),
    );
  const quiet = () => new Promise((resolve) => setTimeout(resolve, 200));
  const granted = (result: GrantEntitlementResult) => {
    expect(result).toMatchObject({ outcome: 'GRANTED' });
    return (result as { entitlementId: string }).entitlementId;
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
    // Apply 10.16, then 10.17 over a pre-existing offer; revert and reapply.
    expect(await database.runMigrations()).toHaveLength(26);
    await database.undoLastMigration(); // Etapa 12.4 Operational Recovery
    await database.undoLastMigration(); // Etapa 11.4 Agent Domain Events
    await database.undoLastMigration(); // Etapa 11.3 Server Control Transport
    await database.undoLastMigration(); // Etapa 11.1 Game Agent Transport
    await database.undoLastMigration();
    await database.query(
      `INSERT INTO vip_offers(code, name, description, price_minor, currency, active, rewards)
       VALUES ('vip_legacy', 'Legacy', '', 100, 'BRL', true, '[{"type":"ITEM","itemId":"gold","quantity":1}]')`,
    );
    expect(
      await database.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename IN ('player_vip_entitlements', 'vip_entitlement_requests')",
        [schema],
      ),
    ).toEqual([]);
    expect(await database.runMigrations()).toHaveLength(5);
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
    entitlements = app.get(VipEntitlementService);
    registry = app.get(RealtimeConnectionRegistry);
    server = await servers.register({ code: randomUUID(), name: 'VIP' });
    const password = 'Vip-Staff-Password-42';
    const [{ id }] = await database.query(
      "INSERT INTO staff_users(username, display_name, password_hash, role_name) VALUES ('coordinator', 'C', $1, 'COORDINATOR') RETURNING id",
      [await new PasswordService().hash(password)],
    );
    staff = staffActor({
      id,
      username: 'coordinator',
      displayName: 'C',
      roleName: RoleName.COORDINATOR,
    });
    staffToken = (
      await http()
        .post('/api/v1/auth/login')
        .send({ username: 'coordinator', password })
        .expect(200)
    ).body.accessToken;
  }, 60000);
  beforeEach(() => app.get(PlayerAuthRateLimiter).reset());
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

  it('adds entitlements over the existing catalog with database-enforced shape and history', async () => {
    expect(database.options.synchronize).toBe(false);
    expect(await database.showMigrations()).toBe(false);
    expect(await database.query('SELECT * FROM migrations')).toHaveLength(26);
    const diff = await database.driver.createSchemaBuilder().log();
    expect([diff.upQueries, diff.downQueries]).toEqual([[], []]);
    // Offers from before 10.17 got the conservative CHARACTER scope.
    expect(
      await database.query(
        "SELECT entitlement_scope FROM vip_offers WHERE code = 'vip_legacy'",
      ),
    ).toEqual([{ entitlement_scope: 'CHARACTER' }]);
    expect(
      await code(
        database.query(
          "UPDATE vip_offers SET entitlement_scope = 'ACCOUNT' WHERE code = 'vip_legacy'",
        ),
      ),
    ).toBe('23514');
    const session = await login();
    const { id: offerId } = await offer('PLAYER');
    const insert = (columns: string, values: string, params: unknown[]) =>
      database.query(
        `INSERT INTO player_vip_entitlements(vip_offer_id, granted_at, source, ${columns}) VALUES ($1, now(), 'STAFF', ${values}) RETURNING id`,
        [offerId, ...params],
      );
    for (const [columns, values, params] of [
      [
        'scope, player_id, game_server_id',
        "'PLAYER', $2, $3",
        [session.player.id, server.id],
      ],
      ['scope, game_server_id', "'CHARACTER', $2", [server.id]],
      ['scope, player_id', "'ACCOUNT', $2", [session.player.id]],
      [
        'scope, player_id, status',
        "'PLAYER', $2, 'REVOKED'",
        [session.player.id],
      ],
      [
        'scope, player_id, expires_at',
        "'PLAYER', $2, now() - interval '1 day'",
        [session.player.id],
      ],
    ] as const)
      expect(await code(insert(columns, values, [...params]))).toBe('23514');
    expect(
      await code(
        database.query(
          "INSERT INTO player_vip_entitlements(vip_offer_id, granted_at, source, scope, player_id) VALUES ($1, now(), 'PLAYER:x', 'PLAYER', $2)",
          [offerId, session.player.id],
        ),
      ),
    ).toBe('23514');
    const [{ id }] = await insert('scope, player_id', "'PLAYER', $2", [
      session.player.id,
    ]);
    // One ACTIVE equivalent entitlement.
    expect(
      await code(
        insert('scope, player_id', "'PLAYER', $2", [session.player.id]),
      ),
    ).toBe('23505');
    for (const statement of [
      'UPDATE player_vip_entitlements SET player_id = gen_random_uuid() WHERE id = $1',
      "UPDATE player_vip_entitlements SET expires_at = now() + interval '1 day' WHERE id = $1",
      'DELETE FROM player_vip_entitlements WHERE id = $1',
    ])
      expect(await code(database.query(statement, [id]))).toBe('55000');
    await database.query(
      "UPDATE player_vip_entitlements SET status = 'REVOKED', revoked_at = now() WHERE id = $1",
      [id],
    );
    expect(
      await code(
        database.query(
          "UPDATE player_vip_entitlements SET status = 'ACTIVE', revoked_at = NULL WHERE id = $1",
          [id],
        ),
      ),
    ).toBe('55000');
    for (const statement of [
      'TRUNCATE player_vip_entitlements CASCADE',
      "UPDATE vip_entitlement_requests SET operation = 'GRANT'",
    ])
      expect(await code(database.query(statement))).toBe('55000');
  });
  it('makes the offer scope an explicit catalog field without changing the public catalog rules', async () => {
    const created = await adminHttp()
      .post('', {
        code: `vip_${randomUUID().slice(0, 8)}`,
        name: 'Account perk',
        description: '',
        priceMinor: 0,
        currency: 'BRL',
        rewards: [{ type: 'TITLE', titleId: 'founder' }],
        active: true,
      })
      .expect(201);
    // No scope sent: the conservative default, never inferred from the name.
    expect(created.body.entitlementScope).toBe('CHARACTER');
    await adminHttp()
      .patch(`/${created.body.id}`, { entitlementScope: 'PLAYER' })
      .expect(200);
    const listed = await http()
      .get(`/api/v1/vip-store/offers/${created.body.code}`)
      .expect(200);
    expect(listed.body.entitlementScope).toBe('PLAYER');
    expect(Object.keys(listed.body).sort()).toEqual(PRODUCT_KEYS);
    for (const entitlementScope of ['ACCOUNT', 'player', null])
      await adminHttp()
        .patch(`/${created.body.id}`, { entitlementScope })
        .expect(400);
    // Inactive offers stay out of the public catalog.
    const hidden = await offer('PLAYER', false);
    await http().get(`/api/v1/vip-store/offers/${hidden.code}`).expect(404);
  });
  it('grants PLAYER entitlements to the account with safe reads, one Audit and own realtime', async () => {
    const [p, stranger] = [await party(), await party()];
    const [s1, s2, sx] = [
      await connected(p.session),
      await connected(p.session),
      await connected(stranger.session),
    ];
    const product = await offer('PLAYER');
    const id = granted(
      await grant(product.id, forPlayer(p), {
        externalReference: 'order:secret-42',
      }),
    );
    const { body } = await account(p.session).expect(200);
    expect(body.items).toHaveLength(1);
    const [entitlement] = body.items;
    expect(Object.keys(entitlement).sort()).toEqual(ENTITLEMENT_KEYS);
    expect(Object.keys(entitlement.product).sort()).toEqual(PRODUCT_KEYS);
    expect(entitlement).toMatchObject({
      entitlementId: id,
      scope: 'PLAYER',
      expiresAt: null,
      product: {
        id: product.id,
        code: product.code,
        entitlementScope: 'PLAYER',
      },
    });
    for (const secret of [
      'order:secret-42',
      'SYSTEM:',
      'VIP_DELIVERY',
      p.session.player.id,
    ])
      expect(JSON.stringify(body)).not.toContain(secret);
    // The account right is not a character right.
    expect((await character(p).expect(200)).body.items).toEqual([]);
    expect((await account(stranger.session).expect(200)).body.items).toEqual(
      [],
    );
    const trail = await audits(id);
    expect(trail).toEqual([
      {
        action: 'VIP_ENTITLEMENT_GRANTED',
        actor_type: 'SYSTEM',
        actor_staff_id: null,
        actor_system_source: 'VIP_DELIVERY',
        resource_type: 'VIP_ENTITLEMENT',
        metadata: {
          entitlementId: id,
          productId: product.id,
          productCode: product.code,
          scope: 'PLAYER',
          status: 'ACTIVE',
          expiresAt: null,
          source: 'SYSTEM:VIP_DELIVERY',
        },
      },
    ]);
    for (const socket of [s1, s2])
      expect(
        (await received(socket, 'VIP_ENTITLEMENT_GRANTED', id)).data,
      ).toMatchObject({
        entitlementId: id,
        scope: 'PLAYER',
        status: 'ACTIVE',
        productCode: product.code,
        gameServerId: null,
        characterId: null,
      });
    await quiet();
    expect(sx.events()).toEqual([]);
    expect(JSON.stringify(s1.events())).not.toMatch(
      /secret-42|playerId|VIP_DELIVERY/,
    );
  });
  it('grants CHARACTER entitlements to the character identity, permanent or expiring, by STAFF', async () => {
    const owner = await login();
    const [x, y] = [await party(owner), await party(owner)];
    const product = await offer('CHARACTER');
    const until = new Date(Date.now() + 86_400_000);
    const id = granted(
      await grant(product.id, forCharacter(x), {
        actor: staff,
        expiresAt: until,
      }),
    );
    expect((await character(x).expect(200)).body.items).toMatchObject([
      { entitlementId: id, scope: 'CHARACTER', expiresAt: until.toISOString() },
    ]);
    // Only that character; not the account, not a sibling character.
    expect((await character(y).expect(200)).body.items).toEqual([]);
    expect((await account(owner).expect(200)).body.items).toEqual([]);
    const accountPerk = await offer('PLAYER');
    const perk = granted(await grant(accountPerk.id, forPlayer(owner)));
    const combined = (await effectiveView(x).expect(200)).body;
    expect(Object.keys(combined).sort()).toEqual(['character', 'player']);
    expect(
      combined.player.map((e: { entitlementId: string }) => e.entitlementId),
    ).toEqual([perk]);
    expect(
      combined.character.map((e: { entitlementId: string }) => e.entitlementId),
    ).toEqual([id]);
    expect((await effectiveView(y).expect(200)).body).toMatchObject({
      player: [{ entitlementId: perk }],
      character: [],
    });
    const [trail] = await audits(id);
    expect(trail).toMatchObject({
      actor_type: 'STAFF',
      actor_staff_id: staff.id,
      metadata: {
        scope: 'CHARACTER',
        gameServerId: server.id,
        characterExternalId: x.char,
        expiresAt: until.toISOString(),
        source: 'STAFF',
      },
    });
    expect(trail.metadata).not.toHaveProperty('playerId');
    // The same offer in both scopes is not collapsed: scopes are per offer.
    await expect(grant(product.id, forPlayer(owner))).resolves.toEqual({
      outcome: 'REJECTED',
      reason: 'SCOPE_MISMATCH',
    });
  });
  it('validates grants: actor, offer, scope, target and expiry', async () => {
    const p = await party();
    const [accountOffer, characterOffer, inactive] = [
      await offer('PLAYER'),
      await offer('CHARACTER'),
      await offer('PLAYER', false),
    ];
    const reject = (reason: string) => ({ outcome: 'REJECTED', reason });
    await expect(
      grant(accountOffer.id, forPlayer(p), {
        actor: playerActor(p.session.player.id),
      }),
    ).resolves.toEqual(reject('ACTOR_NOT_ALLOWED'));
    await expect(grant(randomUUID(), forPlayer(p))).resolves.toEqual(
      reject('OFFER_NOT_FOUND'),
    );
    await expect(grant(inactive.id, forPlayer(p))).resolves.toEqual(
      reject('OFFER_NOT_ACTIVE'),
    );
    await expect(grant(characterOffer.id, forPlayer(p))).resolves.toEqual(
      reject('SCOPE_MISMATCH'),
    );
    await expect(grant(accountOffer.id, forCharacter(p))).resolves.toEqual(
      reject('SCOPE_MISMATCH'),
    );
    await expect(
      grant(accountOffer.id, {
        scope: VipEntitlementScope.PLAYER,
        playerId: randomUUID(),
      }),
    ).resolves.toEqual(reject('TARGET_NOT_FOUND'));
    await expect(
      grant(characterOffer.id, {
        scope: VipEntitlementScope.CHARACTER,
        gameServerId: randomUUID(),
        characterExternalId: p.char,
      }),
    ).resolves.toEqual(reject('TARGET_NOT_FOUND'));
    await expect(
      grant(accountOffer.id, forPlayer(p), {
        expiresAt: new Date(Date.now() - 1000),
      }),
    ).resolves.toEqual(reject('INVALID_INPUT'));
    // A CHARACTER right does not need a current owner.
    expect(
      (
        await grant(characterOffer.id, {
          scope: VipEntitlementScope.CHARACTER,
          gameServerId: server.id,
          characterExternalId: `char:${randomUUID()}`,
        })
      ).outcome,
    ).toBe('GRANTED');
    expect(await activeRows(accountOffer.id)).toBe(0);
  });
  it('makes grants idempotent and keeps one ACTIVE entitlement under concurrency', async () => {
    const p = await party();
    const product = await offer('PLAYER');
    const key = randomUUID();
    const id = granted(
      await grant(product.id, forPlayer(p), { idempotencyKey: key }),
    );
    await expect(
      grant(product.id, forPlayer(p), { idempotencyKey: key }),
    ).resolves.toEqual({
      outcome: 'ALREADY_GRANTED',
      entitlementId: id,
    });
    await expect(
      grant(product.id, forPlayer(p), {
        idempotencyKey: key,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).resolves.toEqual({ outcome: 'REJECTED', reason: 'IDEMPOTENCY_CONFLICT' });
    // Another key for an equivalent grant: the existing right, unchanged.
    await expect(grant(product.id, forPlayer(p))).resolves.toEqual({
      outcome: 'ALREADY_ACTIVE',
      entitlementId: id,
    });
    expect(await audits(id)).toHaveLength(1);
    // Concurrent equivalent grants with different keys: one ACTIVE.
    const q = await party();
    const race = await Promise.all(
      Array.from({ length: 6 }, () => grant(product.id, forPlayer(q))),
    );
    expect(race.filter((r) => r.outcome === 'GRANTED')).toHaveLength(1);
    expect(race.filter((r) => r.outcome === 'ALREADY_ACTIVE')).toHaveLength(5);
    expect(
      new Set(race.map((r) => (r as { entitlementId: string }).entitlementId))
        .size,
    ).toBe(1);
    // Concurrent retries of one key: one entitlement, one Audit.
    const r = await party();
    const same = randomUUID();
    const retries = await Promise.all(
      Array.from({ length: 6 }, () =>
        grant(product.id, forPlayer(r), { idempotencyKey: same }),
      ),
    );
    expect(retries.filter((x) => x.outcome === 'GRANTED')).toHaveLength(1);
    const winner = (retries[0] as { entitlementId: string }).entitlementId;
    expect(
      retries.every(
        (x) => (x as { entitlementId: string }).entitlementId === winner,
      ),
    ).toBe(true);
    expect(await audits(winner)).toHaveLength(1);
    expect(await activeRows(product.id)).toBe(3);
  });
  it('revokes once, idempotently, keeps history and allows a later grant', async () => {
    const p = await party();
    const socket = await connected(p.session);
    const product = await offer('PLAYER');
    const id = granted(await grant(product.id, forPlayer(p)));
    await received(socket, 'VIP_ENTITLEMENT_GRANTED', id);
    const key = randomUUID();
    await expect(revoke(id, key)).resolves.toEqual({
      outcome: 'REVOKED',
      entitlementId: id,
    });
    await expect(revoke(id, key)).resolves.toEqual({
      outcome: 'ALREADY_REVOKED',
      entitlementId: id,
    });
    await expect(revoke(id)).resolves.toEqual({
      outcome: 'ALREADY_REVOKED',
      entitlementId: id,
    });
    await expect(
      entitlements.revoke({
        entitlementId: randomUUID(),
        actor: staff,
        idempotencyKey: key,
      }),
    ).resolves.toEqual({ outcome: 'REJECTED', reason: 'IDEMPOTENCY_CONFLICT' });
    await expect(revoke(randomUUID())).resolves.toEqual({
      outcome: 'REJECTED',
      reason: 'ENTITLEMENT_NOT_FOUND',
    });
    await expect(
      entitlements.revoke({
        entitlementId: id,
        actor: playerActor(p.session.player.id),
        idempotencyKey: randomUUID(),
      }),
    ).resolves.toEqual({ outcome: 'REJECTED', reason: 'ACTOR_NOT_ALLOWED' });
    expect((await account(p.session).expect(200)).body.items).toEqual([]);
    expect((await audits(id)).map((a: { action: string }) => a.action)).toEqual(
      ['VIP_ENTITLEMENT_GRANTED', 'VIP_ENTITLEMENT_REVOKED'],
    );
    expect(
      (await received(socket, 'VIP_ENTITLEMENT_REVOKED', id)).data,
    ).toMatchObject({
      entitlementId: id,
      status: 'REVOKED',
    });
    await quiet();
    expect(vipEvents(socket, id)).toHaveLength(2);
    // History stays; a new grant creates a new ACTIVE entitlement.
    const again = granted(await grant(product.id, forPlayer(p)));
    expect(again).not.toBe(id);
    expect(ids((await account(p.session).expect(200)).body)).toEqual([again]);
    expect(
      await count(
        'SELECT count(*)::int AS n FROM player_vip_entitlements WHERE player_id = $1',
        [p.session.player.id],
      ),
    ).toBe(2);
    // Concurrent revokes: one effective revoke, one Audit.
    const both = await Promise.all([
      revoke(again),
      revoke(again),
      revoke(again),
    ]);
    expect(both.map((r) => r.outcome).sort()).toEqual([
      'ALREADY_REVOKED',
      'ALREADY_REVOKED',
      'REVOKED',
    ]);
    expect(
      (await audits(again)).filter(
        (a: { action: string }) => a.action === 'VIP_ENTITLEMENT_REVOKED',
      ),
    ).toHaveLength(1);
  });
  it('resolves a grant racing a revoke to one consistent outcome', async () => {
    for (let round = 0; round < 5; round++) {
      const p = await party();
      const product = await offer('PLAYER');
      const id = granted(await grant(product.id, forPlayer(p)));
      const [regrant, revoked] = await Promise.all([
        grant(product.id, forPlayer(p)),
        revoke(id),
      ]);
      expect(revoked.outcome).toBe('REVOKED');
      const active = await activeRows(product.id);
      if (regrant.outcome === 'ALREADY_ACTIVE') expect(active).toBe(0);
      else {
        expect(regrant.outcome).toBe('GRANTED');
        expect(active).toBe(1);
      }
    }
  });
  it('treats expired entitlements as inactive, lazily, and materializes EXPIRED on write', async () => {
    const p = await party();
    const product = await offer('PLAYER');
    // An entitlement that expired while nobody touched it (still ACTIVE).
    const [{ id: stale }] = await database.query(
      `INSERT INTO player_vip_entitlements(vip_offer_id, scope, player_id, granted_at, expires_at, source)
       VALUES ($1, 'PLAYER', $2, now() - interval '2 days', now() - interval '1 day', 'STAFF') RETURNING id`,
      [product.id, p.session.player.id],
    );
    expect((await account(p.session).expect(200)).body.items).toEqual([]);
    expect(
      await entitlements.hasPlayerEntitlement(
        p.session.player.id,
        product.code,
      ),
    ).toBe(false);
    await expect(revoke(stale)).resolves.toEqual({
      outcome: 'REJECTED',
      reason: 'NOT_ACTIVE',
    });
    expect(
      (
        await database.query(
          'SELECT status FROM player_vip_entitlements WHERE id = $1',
          [stale],
        )
      )[0].status,
    ).toBe('EXPIRED');
    // A short grant stops counting once its time passes.
    const q = await party();
    const brief = granted(
      await grant(product.id, forPlayer(q), {
        expiresAt: new Date(Date.now() + 1200),
      }),
    );
    expect(ids((await account(q.session).expect(200)).body)).toEqual([brief]);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect((await account(q.session).expect(200)).body.items).toEqual([]);
    // Granting again materializes the old row as EXPIRED and adds a new one.
    const renewed = granted(await grant(product.id, forPlayer(q)));
    expect(
      await database.query(
        'SELECT id, status FROM player_vip_entitlements WHERE player_id = $1 ORDER BY created_at',
        [q.session.player.id],
      ),
    ).toEqual([
      { id: brief, status: 'EXPIRED' },
      { id: renewed, status: 'ACTIVE' },
    ]);
  });
  it('keeps CHARACTER entitlements with the character and PLAYER ones with the account', async () => {
    const a = await party();
    const [characterOffer, accountOffer] = [
      await offer('CHARACTER'),
      await offer('PLAYER'),
    ];
    const right = granted(await grant(characterOffer.id, forCharacter(a)));
    const perk = granted(await grant(accountOffer.id, forPlayer(a)));
    await links.revoke(playerActor(a.session.player.id), a.link);
    await character(a).expect(404);
    await effectiveView(a).expect(404);
    const heir = await heirOf(a.char);
    const [sheir, sold] = [
      await connected(heir.session),
      await connected(a.session),
    ];
    expect(ids((await character(heir).expect(200)).body)).toEqual([right]);
    // The account perk stays with A's account, not with the character.
    expect((await effectiveView(heir).expect(200)).body).toMatchObject({
      player: [],
      character: [{ entitlementId: right }],
    });
    expect(ids((await account(a.session).expect(200)).body)).toEqual([perk]);
    expect(
      await entitlements.hasCharacterEntitlement(
        server.id,
        a.char,
        characterOffer.code,
      ),
    ).toBe(true);
    // Realtime goes to the current owner of the character only.
    await revoke(right);
    await received(sheir, 'VIP_ENTITLEMENT_REVOKED', right);
    await quiet();
    expect(vipEvents(sold)).toEqual([]);
  });
  it('keeps granted rights when the offer is later disabled', async () => {
    const p = await party();
    const product = await offer('PLAYER');
    const id = granted(await grant(product.id, forPlayer(p)));
    await adminHttp()
      .patch(`/${product.id}/active`, { active: false })
      .expect(200);
    await http().get(`/api/v1/vip-store/offers/${product.code}`).expect(404);
    const { body } = await account(p.session).expect(200);
    expect(body.items).toMatchObject([
      { entitlementId: id, product: { id: product.id, code: product.code } },
    ]);
    expect(
      await entitlements.hasPlayerEntitlement(
        p.session.player.id,
        product.code,
      ),
    ).toBe(true);
    // The catalog controls new grants only.
    await expect(grant(product.id, forPlayer(await party()))).resolves.toEqual({
      outcome: 'REJECTED',
      reason: 'OFFER_NOT_ACTIVE',
    });
    await expect(revoke(id)).resolves.toMatchObject({ outcome: 'REVOKED' });
  });
  it('answers internal checks for future benefits', async () => {
    const p = await party();
    const [accountOffer, characterOffer] = [
      await offer('PLAYER'),
      await offer('CHARACTER'),
    ];
    expect(
      await entitlements.hasPlayerEntitlement(
        p.session.player.id,
        accountOffer.code,
      ),
    ).toBe(false);
    const perk = granted(await grant(accountOffer.id, forPlayer(p)));
    granted(await grant(characterOffer.id, forCharacter(p)));
    expect(
      await entitlements.hasPlayerEntitlement(
        p.session.player.id,
        accountOffer.code,
      ),
    ).toBe(true);
    expect(
      await entitlements.hasPlayerEntitlement(
        p.session.player.id,
        characterOffer.code,
      ),
    ).toBe(false);
    expect(
      await entitlements.hasCharacterEntitlement(
        server.id,
        p.char,
        characterOffer.code,
      ),
    ).toBe(true);
    expect(
      await entitlements.hasCharacterEntitlement(
        server.id,
        'char:other',
        characterOffer.code,
      ),
    ).toBe(false);
    expect(
      await entitlements.hasCharacterEntitlement(
        'nope',
        p.char,
        characterOffer.code,
      ),
    ).toBe(false);
    expect(
      await entitlements.hasPlayerEntitlement('nope', accountOffer.code),
    ).toBe(false);
    await revoke(perk);
    expect(
      await entitlements.hasPlayerEntitlement(
        p.session.player.id,
        accountOffer.code,
      ),
    ).toBe(false);
  });
  it('rolls grants back when the Audit fails, publishing nothing', async () => {
    const p = await party();
    const socket = await connected(p.session);
    const product = await offer('PLAYER');
    const key = randomUUID();
    await database.query(`
      CREATE FUNCTION fail_vip_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'VIP_ENTITLEMENT_GRANTED' THEN
          RAISE EXCEPTION 'audit down';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_vip_audit BEFORE INSERT ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION fail_vip_audit();
    `);
    try {
      await expect(
        grant(product.id, forPlayer(p), { idempotencyKey: key }),
      ).rejects.toThrow();
    } finally {
      await database.query(`
        DROP TRIGGER fail_vip_audit ON audit_logs;
        DROP FUNCTION fail_vip_audit();
      `);
    }
    expect(await activeRows(product.id)).toBe(0);
    expect(
      await count(
        'SELECT count(*)::int AS n FROM vip_entitlement_requests WHERE idempotency_key = $1',
        [key],
      ),
    ).toBe(0);
    await quiet();
    expect(vipEvents(socket)).toEqual([]);
    // The same key works once the Audit is back.
    expect(
      (await grant(product.id, forPlayer(p), { idempotencyKey: key })).outcome,
    ).toBe('GRANTED');
  });
  it('guards the Player surface: own data only, read-only, no payment', async () => {
    const [p, stranger] = [await party(), await party()];
    const product = await offer('CHARACTER');
    granted(await grant(product.id, forCharacter(p)));
    for (const linkId of [
      stranger.link,
      await link(p.session, 'PENDING'),
      await link(p.session, 'REVOKED'),
      randomUUID(),
    ]) {
      await get(p.session, `me/characters/${linkId}/vip/entitlements`).expect(
        404,
      );
      await get(p.session, `me/characters/${linkId}/vip/effective`).expect(404);
    }
    await get(p.session, 'me/characters/nope/vip/entitlements').expect(400);
    for (const path of [
      'vip/entitlements',
      `me/characters/${p.link}/vip/entitlements`,
      `me/characters/${p.link}/vip/effective`,
    ]) {
      await get(staffToken, path).expect(401);
      await http().get(`/api/v1/player/${path}`).expect(401);
    }
    // A blocked account loses access, not the right.
    await database.query(
      "UPDATE players SET status = 'SUSPENDED' WHERE id = $1",
      [p.session.player.id],
    );
    try {
      await character(p).expect(403);
      await account(p.session).expect(403);
    } finally {
      await database.query(
        "UPDATE players SET status = 'ACTIVE' WHERE id = $1",
        [p.session.player.id],
      );
    }
    expect((await character(p).expect(200)).body.items).toHaveLength(1);
    // No grant, revoke, purchase, checkout or payment for players.
    for (const path of [
      'vip/purchase',
      'vip/checkout',
      'vip/pay',
      'vip/entitlements',
      `vip/entitlements/${randomUUID()}/revoke`,
      `me/characters/${p.link}/vip/entitlements`,
      `me/characters/${p.link}/vip/purchase`,
    ])
      await http()
        .post(`/api/v1/player/${path}`)
        .auth(p.session.accessToken, { type: 'bearer' })
        .send({ offerId: product.id })
        .expect(404);
    const { body: docs } = await http().get('/docs-json').expect(200);
    const vipPaths = Object.entries(docs.paths).filter(([path]) =>
      path.includes('/vip'),
    );
    expect(
      vipPaths
        .filter(([path]) => path.startsWith('/api/v1/player'))
        .map(([path, ops]) => [path, Object.keys(ops as object)]),
    ).toEqual([
      ['/api/v1/player/vip/entitlements', ['get']],
      [
        '/api/v1/player/me/characters/{characterLinkId}/vip/entitlements',
        ['get'],
      ],
      ['/api/v1/player/me/characters/{characterLinkId}/vip/effective', ['get']],
    ]);
    expect(
      Object.keys(docs.components.schemas.VipEntitlementDto.properties).sort(),
    ).toEqual(ENTITLEMENT_KEYS);
  });
  it('freezes the offer scope once it has any entitlement, whatever its status', async () => {
    const offerAudits = (offerId: string) =>
      count(
        "SELECT count(*)::int AS n FROM audit_logs WHERE resource_type = 'VIP_OFFER' AND resource_id = $1",
        [offerId],
      );
    const scopeOf = async (offerId: string) =>
      (
        await database.query(
          'SELECT entitlement_scope, name FROM vip_offers WHERE id = $1',
          [offerId],
        )
      )[0];
    const product = await offer('CHARACTER');
    // Never granted: the scope may change (audited as usual).
    await adminHttp()
      .patch(`/${product.id}`, { entitlementScope: 'PLAYER' })
      .expect(200);
    await adminHttp()
      .patch(`/${product.id}`, { entitlementScope: 'CHARACTER' })
      .expect(200);
    const id = granted(await grant(product.id, forCharacter(await party())));
    const audited = await offerAudits(product.id);
    // ACTIVE entitlement: refused with 409, nothing changes, no Audit.
    const refused = await adminHttp()
      .patch(`/${product.id}`, { entitlementScope: 'PLAYER' })
      .expect(409);
    expect(refused.body.message).toBe(
      'Entitlement scope is frozen once the offer has entitlements',
    );
    await adminHttp()
      .patch(`/${product.id}`, { entitlementScope: 'PLAYER', name: 'Renamed' })
      .expect(409);
    expect(await scopeOf(product.id)).toEqual({
      entitlement_scope: 'CHARACTER',
      name: 'VIP',
    });
    expect(await offerAudits(product.id)).toBe(audited);
    // Other fields and the same scope stay editable as before.
    await adminHttp().patch(`/${product.id}`, { name: 'Renamed' }).expect(200);
    const same = await adminHttp()
      .patch(`/${product.id}`, { entitlementScope: 'CHARACTER' })
      .expect(200);
    expect(same.body.entitlementScope).toBe('CHARACTER');
    expect(await offerAudits(product.id)).toBe(audited + 2);
    // REVOKED does not unfreeze it.
    await revoke(id);
    await adminHttp()
      .patch(`/${product.id}`, { entitlementScope: 'PLAYER' })
      .expect(409);
    // Neither does an expired entitlement (lazy or materialized).
    const other = await offer('PLAYER');
    await database.query(
      `INSERT INTO player_vip_entitlements(vip_offer_id, scope, player_id, granted_at, expires_at, source)
       VALUES ($1, 'PLAYER', $2, now() - interval '2 days', now() - interval '1 day', 'STAFF')`,
      [other.id, (await login()).player.id],
    );
    await adminHttp()
      .patch(`/${other.id}`, { entitlementScope: 'CHARACTER' })
      .expect(409);
    expect((await scopeOf(other.id)).entitlement_scope).toBe('PLAYER');
    expect(await offerAudits(product.id)).toBe(audited + 2);
    expect(await offerAudits(other.id)).toBe(1);
  });
  it('never mixes scopes when a grant races a scope change', async () => {
    const consistent = async (offerId: string) =>
      expect(
        await database.query(
          `SELECT e.scope FROM player_vip_entitlements e JOIN vip_offers o ON o.id = e.vip_offer_id
            WHERE e.vip_offer_id = $1 AND e.scope <> o.entitlement_scope`,
          [offerId],
        ),
      ).toEqual([]);
    const scopeOf = async (offerId: string) =>
      (
        await database.query(
          'SELECT entitlement_scope FROM vip_offers WHERE id = $1',
          [offerId],
        )
      )[0].entitlement_scope;
    // Grant first: a grant in flight holds the offer FOR SHARE and commits an
    // entitlement; the scope change waits, then sees it and is refused.
    const first = await offer('CHARACTER');
    const grantInFlight = database.createQueryRunner();
    await grantInFlight.connect();
    await grantInFlight.startTransaction();
    await grantInFlight.query(
      'SELECT 1 FROM vip_offers WHERE id = $1 FOR SHARE',
      [first.id],
    );
    await grantInFlight.query(
      `INSERT INTO player_vip_entitlements(vip_offer_id, scope, game_server_id, character_external_id, granted_at, source)
       VALUES ($1, 'CHARACTER', $2, 'char:in-flight', now(), 'STAFF')`,
      [first.id, server.id],
    );
    const patching = adminHttp()
      .patch(`/${first.id}`, { entitlementScope: 'PLAYER' })
      .then((r) => r);
    await quiet();
    await grantInFlight.commitTransaction();
    await grantInFlight.release();
    expect((await patching).status).toBe(409);
    expect(await scopeOf(first.id)).toBe('CHARACTER');
    await consistent(first.id);
    // Change first: a scope change in flight holds the offer FOR UPDATE; the
    // grant waits, then sees the new scope and is refused.
    const second = await offer('CHARACTER');
    const changeInFlight = database.createQueryRunner();
    await changeInFlight.connect();
    await changeInFlight.startTransaction();
    await changeInFlight.query(
      'SELECT 1 FROM vip_offers WHERE id = $1 FOR UPDATE',
      [second.id],
    );
    await changeInFlight.query(
      "UPDATE vip_offers SET entitlement_scope = 'PLAYER' WHERE id = $1",
      [second.id],
    );
    const granting = grant(second.id, forCharacter(await party()));
    await quiet();
    await changeInFlight.commitTransaction();
    await changeInFlight.release();
    await expect(granting).resolves.toEqual({
      outcome: 'REJECTED',
      reason: 'SCOPE_MISMATCH',
    });
    await consistent(second.id);
    // Real races through both services: always one of the two outcomes.
    for (let round = 0; round < 6; round++) {
      const product = await offer('CHARACTER');
      const target = await party();
      const [result, patched] = await Promise.all([
        grant(product.id, forCharacter(target)),
        adminHttp().patch(`/${product.id}`, { entitlementScope: 'PLAYER' }),
      ]);
      if (result.outcome === 'GRANTED') {
        expect(patched.status).toBe(409);
        expect(await scopeOf(product.id)).toBe('CHARACTER');
      } else {
        expect(result).toEqual({
          outcome: 'REJECTED',
          reason: 'SCOPE_MISMATCH',
        });
        expect(patched.status).toBe(200);
        expect(await scopeOf(product.id)).toBe('PLAYER');
        expect(await activeRows(product.id)).toBe(0);
      }
      await consistent(product.id);
    }
  });
  it('refuses to revert while entitlements exist', async () => {
    await database.undoLastMigration(); // Etapa 12.4 Operational Recovery
    // CHARACTER grants left rewards to deliver: 11.4 refuses to forget them.
    await expect(database.undoLastMigration()).rejects.toThrow(
      'Pending marketplace item releases or VIP reward deliveries exist',
    );
    expect(await database.query('SELECT * FROM migrations')).toHaveLength(25);
    await database.query(
      "UPDATE vip_reward_deliveries SET status = 'CANCELLED', error_code = 'ENTITLEMENT_REVOKED', completed_at = now() WHERE status = 'PENDING'",
    );
    // No credentials here: 11.4, 11.3, 11.1 revert, then 10.17 refuses.
    await database.undoLastMigration(); // Etapa 11.4 Agent Domain Events
    await database.undoLastMigration(); // Etapa 11.3 Server Control Transport
    await database.undoLastMigration();
    await expect(database.undoLastMigration()).rejects.toThrow(
      'VIP entitlements exist',
    );
    expect(await database.runMigrations()).toHaveLength(4);
    expect(await database.showMigrations()).toBe(false);
    expect(await database.query('SELECT * FROM migrations')).toHaveLength(26);
  });
});
