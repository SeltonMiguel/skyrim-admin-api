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
import { EconomyService } from '../src/economy/economy.service.js';
import { EconomyReconciliationService } from '../src/economy/economy-reconciliation.service.js';
import { TradeSettlementService } from '../src/player-trades/trade-settlement.service.js';
import { TradeEscrowService } from '../src/player-trades/trade-escrow.service.js';
import {
  MAX_TRADE_ITEM_LINES,
  SettlementOutcome,
} from '../src/player-trades/player-trade.contracts.js';
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
type Offer = { gold: number; items: { itemId: string; quantity: number }[] };
describeDatabase('Player trades with real PostgreSQL', () => {
  let admin: DataSource, database: DataSource, app: INestApplication<App>;
  let links: CharacterLinkService, servers: GameServerService;
  let economy: EconomyService, reconciliation: EconomyReconciliationService;
  let settlement: TradeSettlementService, escrow: TradeEscrowService;
  let registry: RealtimeConnectionRegistry;
  let server: GameServer, staffToken: string, url: string;
  const discord = new FakeDiscordProvider();
  const clients: RealtimeTestClient[] = [];
  const schema = `player_trades_test_${randomUUID().replaceAll('-', '')}`;
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
  const party = async (gold = 0): Promise<Party> => {
    const session = await login();
    const char = `char:${randomUUID()}`;
    const id = await link(session, 'VERIFIED', char);
    if (gold) await fund(char, gold);
    return { session, link: id, char };
  };
  const fund = async (char: string, amount: number) =>
    expect(
      await economy.creditFromSystem({
        gameServerId: server.id,
        characterExternalId: char,
        amount,
        idempotencyKey: randomUUID(),
        source: SystemSource.AGENT,
      }),
    ).toMatchObject({ outcome: 'POSTED' });
  const balance = async (char: string) => {
    const [row] = await database.query(
      "SELECT balance FROM economy_accounts WHERE game_server_id = $1 AND owner_type = 'CHARACTER' AND character_external_id = $2",
      [server.id, char],
    );
    return row ? Number(row.balance) : 0;
  };
  const escrowBalance = async () => {
    const [row] = await database.query(
      "SELECT balance FROM economy_accounts WHERE game_server_id = $1 AND system_key = 'TRADE_ESCROW'",
      [server.id],
    );
    return row ? Number(row.balance) : 0;
  };
  const send = (
    method: 'post' | 'put',
    session: Session | string,
    path: string,
    body: object,
    key: string | null = randomUUID(),
  ) => {
    const call = http()
      [method](`/api/v1/player/${path}`)
      .auth(typeof session === 'string' ? session : session.accessToken, {
        type: 'bearer',
      });
    return (key === null ? call : call.set('Idempotency-Key', key)).send(body);
  };
  const open = (
    from: Party,
    to: Party,
    offer: Offer = { gold: 0, items: [] },
    key?: string | null,
  ) =>
    send(
      'post',
      from.session,
      'trades',
      {
        actorCharacterLinkId: from.link,
        targetCharacterId: to.char,
        offer,
      },
      key,
    );
  const offer = (p: Party, tradeId: string, content: Offer, key?: string) =>
    send(
      'put',
      p.session,
      `trades/${tradeId}/offer`,
      { characterLinkId: p.link, ...content },
      key,
    );
  const accept = (
    p: Party,
    tradeId: string,
    counterpartyOfferVersion: number,
    key?: string,
  ) =>
    send(
      'post',
      p.session,
      `trades/${tradeId}/accept`,
      { characterLinkId: p.link, counterpartyOfferVersion },
      key,
    );
  const cancel = (p: Party, tradeId: string, key?: string) =>
    send(
      'post',
      p.session,
      `trades/${tradeId}/cancel`,
      { characterLinkId: p.link },
      key,
    );
  const view = (p: Party, tradeId: string) =>
    http()
      .get(`/api/v1/player/trades/${tradeId}?characterLinkId=${p.link}`)
      .auth(p.session.accessToken, { type: 'bearer' });
  // Both sides accept the other's current offer.
  const agree = async (a: Party, b: Party, trade: { tradeId: string }) => {
    const current = (await view(a, trade.tradeId).expect(200)).body;
    await accept(a, trade.tradeId, current.target.offer.version).expect(200);
    return (
      await accept(b, trade.tradeId, current.initiator.offer.version).expect(
        200,
      )
    ).body;
  };
  const confirm = (tradeId: string, outcome: SettlementOutcome, id?: string) =>
    settlement.confirmFromAgent({
      tradeId,
      settlementEventId: id ?? `evt:${randomUUID()}`,
      outcome,
    });
  const audits = (tradeId: string) =>
    database.query(
      'SELECT action, actor_type, actor_player_id, actor_system_source, metadata FROM audit_logs WHERE resource_id = $1 ORDER BY created_at, action',
      [tradeId],
    );
  const escrows = (tradeId: string) =>
    database.query(
      'SELECT character_external_id AS char, amount::int, status, resolution_transaction_id IS NOT NULL AS resolved FROM player_trade_currency_escrows WHERE trade_id = $1 ORDER BY amount DESC',
      [tradeId],
    );
  const reconciled = async () => {
    expect(await reconciliation.accountMismatches()).toEqual([]);
    expect(await reconciliation.unbalancedTransactions()).toEqual([]);
    expect(await escrow.mismatches()).toEqual([]);
    expect(await escrow.orphanReservations()).toEqual([]);
  };
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
    expect(
      await database.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename LIKE 'player_trade%'",
        [schema],
      ),
    ).toEqual([]);
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
    economy = app.get(EconomyService);
    reconciliation = app.get(EconomyReconciliationService);
    settlement = app.get(TradeSettlementService);
    escrow = app.get(TradeEscrowService);
    registry = app.get(RealtimeConnectionRegistry);
    server = await servers.register({ code: randomUUID(), name: 'Trades' });
    const password = 'Trades-Staff-Password-42';
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

  it('adds the trade tables and TRADE_ESCROW with database-enforced lifecycle', async () => {
    expect(database.options.synchronize).toBe(false);
    expect(await database.showMigrations()).toBe(false);
    expect(await database.query('SELECT * FROM migrations')).toHaveLength(18);
    const diff = await database.driver.createSchemaBuilder().log();
    expect([diff.upQueries, diff.downQueries]).toEqual([[], []]);
    const insertTrade = (a: string, b: string) =>
      database.query(
        'INSERT INTO player_trades(game_server_id, initiator_character_id, target_character_id) VALUES ($1, $2, $3) RETURNING id',
        [server.id, a, b],
      );
    expect(await code(insertTrade('x', 'x'))).toBe('23514');
    const [{ id }] = await insertTrade('char:a', 'char:b');
    const offerRows = await database.query(
      "INSERT INTO player_trade_offers(trade_id, side) VALUES ($1, 'INITIATOR') RETURNING id",
      [id],
    );
    expect(
      await code(
        database.query(
          "INSERT INTO player_trade_offers(trade_id, side) VALUES ($1, 'INITIATOR')",
          [id],
        ),
      ),
    ).toBe('23505');
    for (const statement of [
      "UPDATE player_trades SET status = 'COMPLETED' WHERE id = $1",
      "UPDATE player_trades SET status = 'AWAITING_GAME_CONFIRMATION' WHERE id = $1",
    ])
      expect(await code(database.query(statement, [id]))).toBe('23514');
    await database.query(
      "UPDATE player_trades SET status = 'CANCELLED', cancelled_at = now() WHERE id = $1",
      [id],
    );
    // Terminal trades never reopen, are kept and freeze their offers.
    for (const statement of [
      "UPDATE player_trades SET status = 'NEGOTIATING', cancelled_at = NULL WHERE id = $1",
      "UPDATE player_trades SET target_character_id = 'char:c' WHERE id = $1",
      'DELETE FROM player_trades WHERE id = $1',
    ])
      expect(await code(database.query(statement, [id]))).toBe('55000');
    expect(
      await code(
        database.query(
          'UPDATE player_trade_offers SET gold_amount = 5 WHERE id = $1',
          [offerRows[0].id],
        ),
      ),
    ).toBe('55000');
    expect(
      await code(
        database.query(
          "INSERT INTO player_trade_items(offer_id, item_external_id, quantity) VALUES ($1, 'item', 1)",
          [offerRows[0].id],
        ),
      ),
    ).toBe('55000');
    expect(await code(database.query('TRUNCATE player_trades CASCADE'))).toBe(
      '55000',
    );
    // TRADE_ESCROW is now an allowed system key; other keys are not.
    expect(
      await code(
        database.query(
          "INSERT INTO economy_accounts(game_server_id, currency, owner_type, system_key) VALUES ($1, 'GOLD', 'SYSTEM', 'MARKET_ESCROW')",
          [server.id],
        ),
      ),
    ).toBe('23514');
  });
  it('opens a trade with a VERIFIED counterparty and a safe view', async () => {
    const [a, b] = [await party(), await party()];
    const created = await open(a, b, {
      gold: 0,
      items: [
        { itemId: ' iron-sword ', quantity: 1 },
        { itemId: 'arrow', quantity: 50 },
      ],
    }).expect(201);
    expect(created.body).toEqual({
      tradeId: expect.any(String),
      gameServer: {
        id: server.id,
        code: server.code,
        name: server.name,
        enabled: true,
      },
      status: 'NEGOTIATING',
      initiator: {
        characterId: a.char,
        characterLinkId: a.link,
        acceptedAt: null,
        offer: {
          version: 1,
          gold: 0,
          items: [
            { itemId: 'arrow', quantity: 50 },
            { itemId: 'iron-sword', quantity: 1 },
          ],
        },
      },
      target: {
        characterId: b.char,
        characterLinkId: null,
        acceptedAt: null,
        offer: { version: 1, gold: 0, items: [] },
      },
      lockedAt: null,
      completedAt: null,
      cancelledAt: null,
      failedAt: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    const seenByB = (await view(b, created.body.tradeId).expect(200)).body;
    expect(seenByB.initiator.characterLinkId).toBeNull();
    expect(seenByB.target.characterLinkId).toBe(b.link);
    const text = JSON.stringify([created.body, seenByB]);
    for (const secret of [a.session.player.id, b.session.player.id])
      expect(text).not.toContain(secret);
    expect(JSON.stringify(created.body)).not.toContain(b.link);
    expect(text).not.toMatch(/accountId|playerId|idempotency|scope|escrow/i);
    const [entry] = await audits(created.body.tradeId);
    expect(entry).toMatchObject({
      action: 'PLAYER_TRADE_CREATED',
      actor_type: 'PLAYER',
      actor_player_id: a.session.player.id,
    });
    expect(entry.metadata).toEqual({
      tradeId: created.body.tradeId,
      gameServerId: server.id,
      actorCharacterId: a.char,
      targetCharacterId: b.char,
      status: 'NEGOTIATING',
      offerVersion: 1,
      gold: 0,
      itemCount: 2,
    });
    // Strangers, other own characters and staff see nothing.
    const stranger = await party();
    await view(stranger, created.body.tradeId).expect(404);
    await view(
      { ...a, link: await link(a.session) },
      created.body.tradeId,
    ).expect(404);
    await view(a, randomUUID()).expect(404);
    await http()
      .get(
        `/api/v1/player/trades/${created.body.tradeId}?characterLinkId=${a.link}`,
      )
      .auth(staffToken, { type: 'bearer' })
      .expect(401);
    await http()
      .get(`/api/v1/player/trades/${created.body.tradeId}`)
      .auth(a.session.accessToken, { type: 'bearer' })
      .expect(400);
    const page = (
      await http()
        .get(`/api/v1/player/me/characters/${b.link}/trades?limit=10`)
        .auth(b.session.accessToken, { type: 'bearer' })
        .expect(200)
    ).body;
    expect(page).toMatchObject({ total: 1, page: 1, limit: 10, totalPages: 1 });
    expect(page.items[0]).toEqual(seenByB);
    await http()
      .get(`/api/v1/player/me/characters/${b.link}/trades`)
      .auth(a.session.accessToken, { type: 'bearer' })
      .expect(404);
  });
  it('validates the counterparty, the offer and the request strictly', async () => {
    const [a, b] = [await party(), await party()];
    const other = await servers.register({ code: randomUUID(), name: 'Other' });
    const unresolved = [
      `char:${randomUUID()}`,
      await (async () => {
        const c = `char:${randomUUID()}`;
        await link(b.session, 'PENDING', c);
        return c;
      })(),
      await (async () => {
        const c = `char:${randomUUID()}`;
        await link(b.session, 'REVOKED', c);
        return c;
      })(),
      await (async () => {
        const c = `char:${randomUUID()}`;
        await link(b.session, 'VERIFIED', c, other);
        return c;
      })(),
    ];
    for (const char of unresolved)
      expect((await open(a, { ...b, char }).expect(404)).body.message).toBe(
        'Character not available',
      );
    await open(a, a).expect(400);
    const line = (i: number) => ({ itemId: `item-${i}`, quantity: 1 });
    for (const offerBody of [
      { gold: -1, items: [] },
      { gold: 1.5, items: [] },
      { gold: 1_000_000_000_001, items: [] },
      { gold: 0 },
      { items: [] },
      { gold: 0, items: [{ itemId: 'x', quantity: 0 }] },
      { gold: 0, items: [{ itemId: 'x', quantity: 10_001 }] },
      { gold: 0, items: [{ itemId: '', quantity: 1 }] },
      { gold: 0, items: [{ itemId: 'a\u0000b', quantity: 1 }] },
      { gold: 0, items: [{ itemId: 'x', quantity: 1, name: 'Ebony Blade' }] },
      { gold: 0, items: [line(1), { itemId: ' item-1 ', quantity: 2 }] },
      {
        gold: 0,
        items: Array.from({ length: MAX_TRADE_ITEM_LINES + 1 }, (_, i) =>
          line(i),
        ),
      },
    ])
      await open(a, b, offerBody as Offer).expect(400);
    for (const body of [
      {
        actorCharacterLinkId: a.link,
        targetCharacterLinkId: b.link,
        offer: { gold: 0, items: [] },
      },
      {
        actorCharacterLinkId: a.link,
        targetCharacterId: b.char,
        targetPlayerId: b.session.player.id,
        offer: { gold: 0, items: [] },
      },
      {
        actorCharacterLinkId: a.link,
        targetCharacterId: b.char,
        gameServerId: server.id,
        offer: { gold: 0, items: [] },
      },
      { actorCharacterLinkId: a.link, targetCharacterId: b.char },
    ])
      await send('post', a.session, 'trades', body).expect(400);
    await open(a, b, undefined, null).expect(400);
    await open(a, b, undefined, 'bad key').expect(400);
    await send('post', staffToken, 'trades', {
      actorCharacterLinkId: a.link,
      targetCharacterId: b.char,
      offer: { gold: 0, items: [] },
    }).expect(401);
    const full = await open(a, b, {
      gold: 0,
      items: Array.from({ length: MAX_TRADE_ITEM_LINES }, (_, i) => line(i)),
    }).expect(201);
    expect(full.body.initiator.offer.items).toHaveLength(MAX_TRADE_ITEM_LINES);
    // A suspended player is stopped by the guard.
    await database.query(
      "UPDATE players SET status = 'SUSPENDED' WHERE id = $1",
      [a.session.player.id],
    );
    try {
      await open(a, b).expect(403);
      await view(a, full.body.tradeId).expect(403);
    } finally {
      await database.query(
        "UPDATE players SET status = 'ACTIVE' WHERE id = $1",
        [a.session.player.id],
      );
    }
    expect(
      await database.query(
        'SELECT count(*)::int AS n FROM player_trades WHERE initiator_character_id = $1',
        [a.char],
      ),
    ).toEqual([{ n: 1 }]);
  });
  it('replays create, offer, accept and cancel by Idempotency-Key without duplicates', async () => {
    const [a, b] = [await party(), await party()];
    const key = randomUUID();
    const first = (await open(a, b, { gold: 0, items: [] }, key).expect(201))
      .body;
    const again = await open(a, b, { gold: 0, items: [] }, key).expect(201);
    expect(again.body.tradeId).toBe(first.tradeId);
    await open(a, b, { gold: 1, items: [] }, key).expect(409);
    // Keys are scoped per player.
    const byB = await open(b, a, { gold: 0, items: [] }, key).expect(201);
    expect(byB.body.tradeId).not.toBe(first.tradeId);
    const race = randomUUID();
    const creations = await Promise.all(
      Array.from({ length: 6 }, () =>
        open(a, b, { gold: 0, items: [{ itemId: 'gem', quantity: 1 }] }, race),
      ),
    );
    expect(creations.map((r) => r.status)).toEqual(Array(6).fill(201));
    expect(new Set(creations.map((r) => r.body.tradeId)).size).toBe(1);
    const tradeId = creations[0].body.tradeId;
    const offerKey = randomUUID();
    const content = { gold: 0, items: [{ itemId: 'ring', quantity: 1 }] };
    const updated = (await offer(b, tradeId, content, offerKey).expect(200))
      .body;
    expect(updated.target.offer.version).toBe(2);
    expect(
      (await offer(b, tradeId, content, offerKey).expect(200)).body.target.offer
        .version,
    ).toBe(2);
    await offer(b, tradeId, { gold: 0, items: [] }, offerKey).expect(409);
    // Another operation under the same player's key conflicts; the same key
    // from another player is simply a different scope.
    await accept(b, tradeId, 1, offerKey).expect(409);
    const acceptKey = randomUUID();
    await accept(a, tradeId, 2, acceptKey).expect(200);
    await accept(a, tradeId, 2, acceptKey).expect(200);
    const cancelKey = randomUUID();
    await cancel(b, tradeId, cancelKey).expect(200);
    const replayed = await cancel(b, tradeId, cancelKey).expect(200);
    expect(replayed.body.status).toBe('CANCELLED');
    const actions = (await audits(tradeId)).map(
      (e: { action: string }) => e.action,
    );
    expect(actions).toEqual([
      'PLAYER_TRADE_CREATED',
      'PLAYER_TRADE_OFFER_UPDATED',
      'PLAYER_TRADE_ACCEPTED',
      'PLAYER_TRADE_CANCELLED',
    ]);
    expect(
      await database.query(
        'SELECT count(*)::int AS n FROM player_trade_requests WHERE idempotency_key = ANY($1)',
        [[race, offerKey, acceptKey, cancelKey]],
      ),
    ).toEqual([{ n: 4 }]);
    // A replay is answered only to a current participant.
    await links.revoke(playerActor(b.session.player.id), b.link);
    await cancel(b, tradeId, cancelKey).expect(404);
  });
  it('versions offers, resets acceptances and refuses stale or empty acceptances', async () => {
    const [a, b] = [await party(), await party()];
    const trade = (await open(a, b).expect(201)).body;
    // Only the caller's own side changes.
    const changed = (
      await offer(a, trade.tradeId, {
        gold: 0,
        items: [{ itemId: 'gem', quantity: 3 }],
      }).expect(200)
    ).body;
    expect([
      changed.initiator.offer.version,
      changed.target.offer.version,
    ]).toEqual([2, 1]);
    await accept(b, trade.tradeId, 1).expect(409);
    const acceptedByB = (await accept(b, trade.tradeId, 2).expect(200)).body;
    expect(acceptedByB.target.acceptedAt).not.toBeNull();
    expect(acceptedByB.status).toBe('NEGOTIATING');
    // Accepting again is a no-op; any offer change resets both sides.
    await accept(b, trade.tradeId, 2).expect(200);
    const reset = (
      await offer(a, trade.tradeId, {
        gold: 0,
        items: [{ itemId: 'gem', quantity: 2 }],
      }).expect(200)
    ).body;
    expect([reset.initiator.acceptedAt, reset.target.acceptedAt]).toEqual([
      null,
      null,
    ]);
    expect(reset.initiator.offer.version).toBe(3);
    const stranger = await party();
    await offer(stranger, trade.tradeId, { gold: 0, items: [] }).expect(404);
    await accept(stranger, trade.tradeId, 1).expect(404);
    await cancel(stranger, trade.tradeId).expect(404);
    for (const body of [
      { characterLinkId: a.link, gold: 0, items: [], side: 'TARGET' },
      { characterLinkId: a.link, gold: 0 },
    ])
      await send(
        'put',
        a.session,
        `trades/${trade.tradeId}/offer`,
        body,
      ).expect(400);
    await send('post', a.session, `trades/${trade.tradeId}/accept`, {
      characterLinkId: a.link,
    }).expect(400);
    // Nothing on either side: the second acceptance cannot lock the trade.
    const empty = (await open(a, b).expect(201)).body;
    await accept(a, empty.tradeId, 1).expect(200);
    expect((await accept(b, empty.tradeId, 1).expect(409)).body.message).toBe(
      'Trade has no assets',
    );
    expect((await view(a, empty.tradeId).expect(200)).body).toMatchObject({
      status: 'NEGOTIATING',
      target: { acceptedAt: null },
    });
    // Concurrent edits of the same offer serialize on the trade row.
    const edits = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        offer(a, trade.tradeId, {
          gold: 0,
          items: [{ itemId: `e${i}`, quantity: 1 }],
        }),
      ),
    );
    expect(edits.every((r) => r.status === 200)).toBe(true);
    const final = (await view(a, trade.tradeId).expect(200)).body;
    expect(final.initiator.offer.version).toBe(8);
    expect(final.initiator.offer.items).toHaveLength(1);
  });
  it('settles two-way GOLD atomically through escrow and completes once', async () => {
    const [a, b] = [await party(300), await party(80)];
    const trade = (await open(a, b, { gold: 100, items: [] }).expect(201)).body;
    await offer(b, trade.tradeId, { gold: 50, items: [] }).expect(200);
    const done = await agree(a, b, trade);
    expect(done).toMatchObject({
      status: 'COMPLETED',
      lockedAt: expect.any(String),
      completedAt: expect.any(String),
    });
    expect([await balance(a.char), await balance(b.char)]).toEqual([250, 130]);
    expect(await escrowBalance()).toBe(0);
    expect(await escrows(trade.tradeId)).toEqual([
      { char: a.char, amount: 100, status: 'SETTLED', resolved: true },
      { char: b.char, amount: 50, status: 'SETTLED', resolved: true },
    ]);
    // Reservation and settlement are separate balanced ledger postings.
    const postings = await database.query(
      'SELECT t.id, t.type, t.reference_type, t.reference_id, count(e.id)::int AS legs, sum(e.amount)::int AS total FROM economy_transactions t JOIN economy_entries e ON e.transaction_id = t.id WHERE t.reference_id = $1 GROUP BY t.id ORDER BY min(t.created_at), t.idempotency_key DESC',
      [trade.tradeId],
    );
    expect(postings).toHaveLength(2);
    for (const p of postings)
      expect(p).toMatchObject({
        type: 'TRANSFER',
        reference_type: 'PLAYER_TRADE',
        legs: 3,
        total: 0,
      });
    await accept(a, trade.tradeId, 2).expect(409);
    await cancel(a, trade.tradeId).expect(409);
    await offer(a, trade.tradeId, { gold: 1, items: [] }).expect(409);
    // Wallet history shows the trade reference, not the counterparty.
    const history = (
      await http()
        .get(`/api/v1/player/me/characters/${a.link}/wallet/transactions`)
        .auth(a.session.accessToken, { type: 'bearer' })
        .expect(200)
    ).body.items;
    expect(
      history
        .filter((h: { referenceId: string }) => h.referenceId === trade.tradeId)
        .map((h: { direction: string; amount: number }) => [
          h.direction,
          h.amount,
        ])
        .sort(),
    ).toEqual([
      ['CREDIT', 50],
      ['DEBIT', 100],
    ]);
    expect(JSON.stringify(history)).not.toContain(b.char);
    const accepted = (await audits(trade.tradeId)).filter(
      (e: { action: string }) => e.action === 'PLAYER_TRADE_ACCEPTED',
    );
    expect(
      accepted.map((e: { metadata: { status: string } }) => e.metadata.status),
    ).toEqual(['NEGOTIATING', 'COMPLETED']);
    expect(accepted[1].metadata).toMatchObject({
      initiatorGold: 100,
      targetGold: 50,
      itemCount: 0,
    });
    await reconciled();
  });
  it('gifts GOLD one way, allows the exact balance and rejects insufficient funds without changes', async () => {
    const [a, b] = [await party(100), await party()];
    const gift = (await open(a, b, { gold: 100, items: [] }).expect(201)).body;
    expect((await agree(a, b, gift)).status).toBe('COMPLETED');
    expect([await balance(a.char), await balance(b.char)]).toEqual([0, 100]);
    const broke = (await open(a, b, { gold: 1, items: [] }).expect(201)).body;
    await accept(b, broke.tradeId, 1).expect(200);
    const before = await audits(broke.tradeId);
    expect((await accept(a, broke.tradeId, 1).expect(409)).body.message).toBe(
      'Insufficient funds',
    );
    // The failed acceptance left no trace: no reservation, no Audit.
    expect((await view(a, broke.tradeId).expect(200)).body).toMatchObject({
      status: 'NEGOTIATING',
      initiator: { acceptedAt: null },
      target: { acceptedAt: expect.any(String) },
    });
    expect(await escrows(broke.tradeId)).toEqual([]);
    expect(await audits(broke.tradeId)).toEqual(before);
    expect(await balance(a.char)).toBe(0);
    await fund(a.char, 1);
    expect((await accept(a, broke.tradeId, 1).expect(200)).body.status).toBe(
      'COMPLETED',
    );
    await reconciled();
  });
  it('never double-spends when two trades race for the same GOLD', async () => {
    const [a, b, c] = [await party(100), await party(), await party()];
    const t1 = (await open(a, b, { gold: 100, items: [] }).expect(201)).body;
    const t2 = (await open(a, c, { gold: 100, items: [] }).expect(201)).body;
    await accept(b, t1.tradeId, 1).expect(200);
    await accept(c, t2.tradeId, 1).expect(200);
    const results = await Promise.all([
      accept(a, t1.tradeId, 1),
      accept(a, t2.tradeId, 1),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await balance(a.char)).toBe(0);
    expect((await balance(b.char)) + (await balance(c.char))).toBe(100);
    // Both sides accepting at once: one lock, one completion.
    const [x, y] = [await party(40), await party(40)];
    const t3 = (await open(x, y, { gold: 10, items: [] }).expect(201)).body;
    await offer(y, t3.tradeId, { gold: 5, items: [] }).expect(200);
    const both = await Promise.all([
      accept(x, t3.tradeId, 2),
      accept(y, t3.tradeId, 1),
    ]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect((await view(x, t3.tradeId).expect(200)).body.status).toBe(
      'COMPLETED',
    );
    expect([await balance(x.char), await balance(y.char)]).toEqual([35, 45]);
    // Accept racing an offer edit: either the edit wins (accept is stale)
    // or the accept wins and the edit resets it.
    const t4 = (await open(x, y, { gold: 1, items: [] }).expect(201)).body;
    const [edit, acceptance] = await Promise.all([
      offer(x, t4.tradeId, { gold: 2, items: [] }),
      accept(y, t4.tradeId, 1),
    ]);
    expect(edit.status).toBe(200);
    expect([200, 409]).toContain(acceptance.status);
    const t4View = (await view(x, t4.tradeId).expect(200)).body;
    expect(t4View).toMatchObject({
      status: 'NEGOTIATING',
      initiator: { offer: { version: 2, gold: 2 } },
      target: { acceptedAt: null },
    });
    // Cancel racing the completing accept: exactly one outcome.
    const t5 = (await open(x, y, { gold: 1, items: [] }).expect(201)).body;
    await accept(x, t5.tradeId, 1).expect(200);
    const [cancelled, completed] = await Promise.all([
      cancel(x, t5.tradeId),
      accept(y, t5.tradeId, 1),
    ]);
    const final = (await view(x, t5.tradeId).expect(200)).body.status;
    expect(
      final === 'CANCELLED'
        ? [cancelled.status, completed.status]
        : [completed.status, cancelled.status],
    ).toEqual([200, 409]);
    await reconciled();
  });
  it('locks GAME_ITEM trades with GOLD reserved until the Agent settles them', async () => {
    const [a, b] = [await party(500), await party()];
    const trade = (await open(a, b, { gold: 200, items: [] }).expect(201)).body;
    await offer(b, trade.tradeId, {
      gold: 0,
      items: [{ itemId: 'daedric-bow', quantity: 1 }],
    }).expect(200);
    const locked = await agree(a, b, trade);
    expect(locked).toMatchObject({
      status: 'AWAITING_GAME_CONFIRMATION',
      lockedAt: expect.any(String),
      completedAt: null,
    });
    expect([await balance(a.char), await balance(b.char)]).toEqual([300, 0]);
    expect(await escrowBalance()).toBe(200);
    expect(await escrows(trade.tradeId)).toEqual([
      { char: a.char, amount: 200, status: 'RESERVED', resolved: false },
    ]);
    // Immutable and not cancellable by players while the Agent may act.
    await offer(a, trade.tradeId, { gold: 1, items: [] }).expect(409);
    await offer(b, trade.tradeId, { gold: 0, items: [] }).expect(409);
    expect((await cancel(a, trade.tradeId).expect(409)).body.message).toBe(
      'Trade is awaiting game confirmation and cannot be cancelled',
    );
    await accept(a, trade.tradeId, 2).expect(409);
    await reconciled();
    const eventId = `evt:${randomUUID()}`;
    expect(
      await confirm(trade.tradeId, SettlementOutcome.SETTLED, eventId),
    ).toEqual({
      outcome: 'APPLIED',
      status: 'COMPLETED',
    });
    expect([await balance(a.char), await balance(b.char)]).toEqual([300, 200]);
    expect(await escrowBalance()).toBe(0);
    expect(await escrows(trade.tradeId)).toEqual([
      { char: a.char, amount: 200, status: 'SETTLED', resolved: true },
    ]);
    // Replays change nothing; a reused id with other content conflicts.
    expect(
      await confirm(trade.tradeId, SettlementOutcome.SETTLED, eventId),
    ).toEqual({
      outcome: 'ALREADY_APPLIED',
      status: 'COMPLETED',
    });
    expect(
      await confirm(trade.tradeId, SettlementOutcome.FAILED, eventId),
    ).toEqual({
      outcome: 'REJECTED',
      reason: 'EVENT_CONFLICT',
    });
    expect(await confirm(trade.tradeId, SettlementOutcome.FAILED)).toEqual({
      outcome: 'REJECTED',
      reason: 'TRADE_NOT_AWAITING',
    });
    for (const input of [
      {
        tradeId: 'x',
        settlementEventId: 'e',
        outcome: SettlementOutcome.SETTLED,
      },
      {
        tradeId: trade.tradeId,
        settlementEventId: '',
        outcome: SettlementOutcome.SETTLED,
      },
      {
        tradeId: trade.tradeId,
        settlementEventId: 'e',
        outcome: 'DONE' as SettlementOutcome,
      },
    ])
      expect(await settlement.confirmFromAgent(input)).toEqual({
        outcome: 'REJECTED',
        reason: 'INVALID_INPUT',
      });
    expect(
      await confirm(randomUUID(), SettlementOutcome.SETTLED),
    ).toMatchObject({
      reason: 'TRADE_NOT_FOUND',
    });
    const settled = (await audits(trade.tradeId)).filter(
      (e: { action: string }) => e.action === 'PLAYER_TRADE_SETTLED',
    );
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      actor_type: 'SYSTEM',
      actor_system_source: 'AGENT',
      metadata: {
        tradeId: trade.tradeId,
        gameServerId: server.id,
        status: 'COMPLETED',
        settlementEventId: eventId,
        initiatorGold: 200,
        targetGold: 0,
        itemCount: 1,
      },
    });
    await reconciled();
  });
  it('refunds reserved GOLD on Agent failure, once, and never completes item-only trades early', async () => {
    const [a, b] = [await party(120), await party(60)];
    const mixed = (await open(a, b, { gold: 120, items: [] }).expect(201)).body;
    await offer(b, mixed.tradeId, {
      gold: 60,
      items: [{ itemId: 'ebony-mail', quantity: 1 }],
    }).expect(200);
    expect((await agree(a, b, mixed)).status).toBe(
      'AWAITING_GAME_CONFIRMATION',
    );
    expect(await escrowBalance()).toBe(180);
    const eventId = `evt:${randomUUID()}`;
    expect(
      await confirm(mixed.tradeId, SettlementOutcome.FAILED, eventId),
    ).toEqual({
      outcome: 'APPLIED',
      status: 'FAILED',
    });
    expect([await balance(a.char), await balance(b.char)]).toEqual([120, 60]);
    expect(await escrowBalance()).toBe(0);
    expect(
      (await escrows(mixed.tradeId)).map((e: { status: string }) => e.status),
    ).toEqual(['RELEASED', 'RELEASED']);
    expect(
      await confirm(mixed.tradeId, SettlementOutcome.FAILED, eventId),
    ).toMatchObject({
      outcome: 'ALREADY_APPLIED',
    });
    expect((await view(a, mixed.tradeId).expect(200)).body).toMatchObject({
      status: 'FAILED',
      failedAt: expect.any(String),
    });
    await cancel(a, mixed.tradeId).expect(409);
    // Item-only: no ledger movement; concurrent confirmations apply once.
    const items = (
      await open(a, b, {
        gold: 0,
        items: [{ itemId: 'gem', quantity: 2 }],
      }).expect(201)
    ).body;
    expect((await agree(a, b, items)).status).toBe(
      'AWAITING_GAME_CONFIRMATION',
    );
    expect(await escrows(items.tradeId)).toEqual([]);
    const race = await Promise.all([
      confirm(items.tradeId, SettlementOutcome.SETTLED),
      confirm(items.tradeId, SettlementOutcome.FAILED),
      confirm(items.tradeId, SettlementOutcome.SETTLED),
    ]);
    expect(race.filter((r) => r.outcome === 'APPLIED')).toHaveLength(1);
    expect(
      race.filter(
        (r) => r.outcome === 'REJECTED' && r.reason === 'TRADE_NOT_AWAITING',
      ),
    ).toHaveLength(2);
    expect(
      await database.query(
        'SELECT count(*)::int AS n FROM player_trade_settlement_events WHERE trade_id = $1',
        [items.tradeId],
      ),
    ).toEqual([{ n: 1 }]);
    await reconciled();
  });
  it('keeps trades with the character identity when ownership changes', async () => {
    const [a, b] = [await party(), await party(300)];
    const trade = (
      await open(a, b, {
        gold: 0,
        items: [{ itemId: 'amulet', quantity: 1 }],
      }).expect(201)
    ).body;
    // NEGOTIATING: the old owner loses access; the new owner continues.
    await links.revoke(playerActor(a.session.player.id), a.link);
    await view(a, trade.tradeId).expect(404);
    await cancel(a, trade.tradeId).expect(404);
    const heir = await login();
    const heirParty = {
      session: heir,
      link: await link(heir, 'VERIFIED', a.char),
      char: a.char,
    };
    const seen = (await view(heirParty, trade.tradeId).expect(200)).body;
    expect(seen.initiator).toMatchObject({
      characterId: a.char,
      characterLinkId: heirParty.link,
    });
    await offer(b, trade.tradeId, { gold: 150, items: [] }).expect(200);
    await accept(heirParty, trade.tradeId, 2).expect(200);
    // No current owner on one side: the second acceptance is refused.
    await links.revoke(playerActor(heir.player.id), heirParty.link);
    expect((await accept(b, trade.tradeId, 1).expect(409)).body.message).toBe(
      'Trade party unavailable',
    );
    const successor = await login();
    const current = {
      session: successor,
      link: await link(successor, 'VERIFIED', a.char),
      char: a.char,
    };
    await accept(b, trade.tradeId, 1).expect(200);
    expect((await view(current, trade.tradeId).expect(200)).body.status).toBe(
      'AWAITING_GAME_CONFIRMATION',
    );
    // AWAITING: another ownership change does not change who is paid.
    await links.revoke(playerActor(successor.player.id), current.link);
    await confirm(trade.tradeId, SettlementOutcome.SETTLED);
    expect([await balance(a.char), await balance(b.char)]).toEqual([150, 150]);
    const last = await login();
    const lastParty = {
      session: last,
      link: await link(last, 'VERIFIED', a.char),
      char: a.char,
    };
    expect(
      (
        await http()
          .get(`/api/v1/player/me/characters/${lastParty.link}/wallet`)
          .auth(last.accessToken, { type: 'bearer' })
          .expect(200)
      ).body.balance,
    ).toBe(150);
    expect((await view(lastParty, trade.tradeId).expect(200)).body.status).toBe(
      'COMPLETED',
    );
    await reconciled();
  });
  it('fans trade events to the current owners only, after commit', async () => {
    const [a, b, stranger] = [await party(50), await party(), await party()];
    const [sa, sb, ss] = [
      await connected(a.session),
      await connected(b.session),
      await connected(stranger.session),
    ];
    const trade = (await open(a, b, { gold: 50, items: [] }).expect(201)).body;
    for (const socket of [sa, sb])
      expect((await socket.event('TRADE_CREATED')).data).toEqual({
        tradeId: trade.tradeId,
        gameServerId: server.id,
        status: 'NEGOTIATING',
        initiatorCharacterId: a.char,
        targetCharacterId: b.char,
      });
    await offer(b, trade.tradeId, {
      gold: 0,
      items: [{ itemId: 'x', quantity: 1 }],
    }).expect(200);
    await sa.event('TRADE_OFFER_UPDATED');
    await accept(a, trade.tradeId, 2).expect(200);
    await sb.event('TRADE_ACCEPTED');
    await accept(b, trade.tradeId, 1).expect(200);
    for (const socket of [sa, sb])
      await socket.event('TRADE_AWAITING_GAME_CONFIRMATION');
    await confirm(trade.tradeId, SettlementOutcome.SETTLED);
    for (const socket of [sa, sb]) await socket.event('TRADE_COMPLETED');
    // A rolled-back acceptance publishes nothing.
    const broke = (await open(b, a, { gold: 999, items: [] }).expect(201)).body;
    await accept(a, broke.tradeId, 1).expect(200);
    for (const socket of [sa, sb])
      await socket.until(
        () =>
          socket
            .events()
            .some(
              (e) =>
                e.type === 'TRADE_ACCEPTED' &&
                (e.data as { tradeId: string }).tradeId === broke.tradeId,
            ) || undefined,
      );
    const before = sa.events().length;
    await accept(b, broke.tradeId, 1).expect(409);
    await cancel(b, broke.tradeId).expect(200);
    await sa.event('TRADE_CANCELLED');
    await settle();
    expect(
      sa
        .events()
        .slice(before)
        .map((e) => e.type),
    ).toEqual(['TRADE_CANCELLED']);
    expect(ss.events()).toEqual([]);
    const everything = JSON.stringify([...sa.events(), ...sb.events()]);
    for (const secret of [
      a.session.player.id,
      b.session.player.id,
      a.link,
      b.link,
    ])
      expect(everything).not.toContain(secret);
    for (const event of sa.events())
      expect(Object.keys(event.data as object)).not.toContain('playerId');
  });
  it('accepts only the current counterparty offer version and resets on any change', async () => {
    const [a, b] = [await party(), await party()];
    const trade = (
      await open(a, b, {
        gold: 0,
        items: [{ itemId: 'shield', quantity: 1 }],
      }).expect(201)
    ).body;
    // A sees B at v1; B changes its offer to v2.
    expect(
      (await view(a, trade.tradeId).expect(200)).body.target.offer.version,
    ).toBe(1);
    await offer(b, trade.tradeId, {
      gold: 0,
      items: [{ itemId: 'helm', quantity: 1 }],
    }).expect(200);
    const stale = await accept(a, trade.tradeId, 1).expect(409);
    expect(stale.body.message).toBe(
      'Offer changed; review it and accept again',
    );
    const accepted = (await accept(a, trade.tradeId, 2).expect(200)).body;
    expect(accepted.initiator.acceptedAt).not.toBeNull();
    // Initiator confirms the TARGET version; target confirms the INITIATOR version.
    await accept(b, trade.tradeId, 2).expect(409);
    // The old field name is not accepted; neither is it alongside the new one.
    for (const body of [
      { characterLinkId: b.link, offerVersion: 1 },
      { characterLinkId: b.link, counterpartyOfferVersion: 1, offerVersion: 1 },
    ])
      await send(
        'post',
        b.session,
        `trades/${trade.tradeId}/accept`,
        body,
      ).expect(400);
    // A change of one's own offer resets both acceptances...
    await accept(b, trade.tradeId, 1).expect(200);
    const locked = (await view(a, trade.tradeId).expect(200)).body;
    expect(locked.status).toBe('AWAITING_GAME_CONFIRMATION');
    const second = (
      await open(a, b, {
        gold: 0,
        items: [{ itemId: 'gem', quantity: 1 }],
      }).expect(201)
    ).body;
    await accept(b, second.tradeId, 1).expect(200);
    const ownChange = (
      await offer(b, second.tradeId, {
        gold: 0,
        items: [{ itemId: 'ore', quantity: 1 }],
      }).expect(200)
    ).body;
    expect([
      ownChange.initiator.acceptedAt,
      ownChange.target.acceptedAt,
    ]).toEqual([null, null]);
    // ...and so does a change of the counterparty's offer.
    await accept(a, second.tradeId, 2).expect(200);
    const counterChange = (
      await offer(b, second.tradeId, { gold: 0, items: [] }).expect(200)
    ).body;
    expect([
      counterChange.initiator.acceptedAt,
      counterChange.target.acceptedAt,
    ]).toEqual([null, null]);
    const [acceptedAudit] = (await audits(second.tradeId)).filter(
      (e: { action: string }) => e.action === 'PLAYER_TRADE_ACCEPTED',
    );
    expect(acceptedAudit.metadata).toMatchObject({
      counterpartyOfferVersion: 1,
    });
    expect(acceptedAudit.metadata).not.toHaveProperty('offerVersion');
    const { body: docs } = await http().get('/docs-json').expect(200);
    expect(
      Object.keys(docs.components.schemas.AcceptTradeBodyDto.properties).sort(),
    ).toEqual(['characterLinkId', 'counterpartyOfferVersion']);
  });
  it('keeps the trade AWAITING with GOLD reserved when the ledger refuses the settlement', async () => {
    const [a, b] = [await party(100), await party()];
    const sockets = [await connected(a.session), await connected(b.session)];
    const trade = (await open(a, b, { gold: 100, items: [] }).expect(201)).body;
    await offer(b, trade.tradeId, {
      gold: 0,
      items: [{ itemId: 'crown', quantity: 1 }],
    }).expect(200);
    expect((await agree(a, b, trade)).status).toBe(
      'AWAITING_GAME_CONFIRMATION',
    );
    // B reaches the balance ceiling meanwhile: receiving 100 would exceed it.
    await fund(b.char, 1_000_000_000_000);
    const eventId = `evt:${randomUUID()}`;
    expect(
      await confirm(trade.tradeId, SettlementOutcome.SETTLED, eventId),
    ).toEqual({
      outcome: 'REJECTED',
      reason: 'LEDGER_REJECTED',
      ledgerReason: 'BALANCE_LIMIT',
    });
    expect((await view(a, trade.tradeId).expect(200)).body).toMatchObject({
      status: 'AWAITING_GAME_CONFIRMATION',
      completedAt: null,
    });
    expect(await escrows(trade.tradeId)).toEqual([
      { char: a.char, amount: 100, status: 'RESERVED', resolved: false },
    ]);
    expect(await escrowBalance()).toBe(100);
    expect(
      await database.query(
        'SELECT count(*)::int AS n FROM player_trade_settlement_events WHERE trade_id = $1',
        [trade.tradeId],
      ),
    ).toEqual([{ n: 0 }]);
    expect(
      (await audits(trade.tradeId)).map((e: { action: string }) => e.action),
    ).not.toContain('PLAYER_TRADE_SETTLED');
    await settle();
    for (const socket of sockets)
      expect(socket.events().map((e) => e.type)).not.toContain(
        'TRADE_COMPLETED',
      );
    expect([await balance(a.char), await balance(b.char)]).toEqual([
      0, 1_000_000_000_000,
    ]);
    await reconciled();
    // A later retry (same event id, nothing was recorded) can still settle.
    expect(
      await economy.debitFromSystem({
        gameServerId: server.id,
        characterExternalId: b.char,
        amount: 100,
        idempotencyKey: randomUUID(),
        source: SystemSource.AGENT,
      }),
    ).toMatchObject({ outcome: 'POSTED' });
    expect(
      await confirm(trade.tradeId, SettlementOutcome.SETTLED, eventId),
    ).toEqual({
      outcome: 'APPLIED',
      status: 'COMPLETED',
    });
    for (const socket of sockets) await socket.event('TRADE_COMPLETED');
    expect(await balance(b.char)).toBe(1_000_000_000_000);
    expect(await escrowBalance()).toBe(0);
    await reconciled();
  });
  it('refuses to revert while trades exist', async () => {
    await reconciled();
    await expect(database.undoLastMigration()).rejects.toThrow(
      'player trades exist',
    );
    expect(await database.showMigrations()).toBe(false);
  });
});
