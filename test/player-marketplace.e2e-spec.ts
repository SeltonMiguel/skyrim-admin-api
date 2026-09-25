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
import { TradeEscrowService } from '../src/player-trades/trade-escrow.service.js';
import { MarketplaceCustodyService } from '../src/player-marketplace/marketplace-custody.service.js';
import { MarketplaceSettlementService } from '../src/player-marketplace/marketplace-settlement.service.js';
import { MarketEscrowService } from '../src/player-marketplace/market-escrow.service.js';
import {
  CustodyOutcome,
  MarketSettlementOutcome,
} from '../src/player-marketplace/player-marketplace.contracts.js';
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
interface Terms {
  itemId?: string;
  quantity?: number;
  priceGold?: number;
}
const LISTING_KEYS = [
  'createdAt',
  'gameServer',
  'itemId',
  'listingId',
  'priceGold',
  'quantity',
  'sellerCharacterId',
  'status',
];
const OWN_LISTING_KEYS = [
  ...LISTING_KEYS,
  'buyerCharacterId',
  'cancelledAt',
  'characterLinkId',
  'failedAt',
  'reservedAt',
  'soldAt',
  'updatedAt',
].sort();
const PURCHASE_KEYS = [
  'buyerCharacterId',
  'completedAt',
  'createdAt',
  'failedAt',
  'listing',
  'purchaseId',
  'status',
  'updatedAt',
];
describeDatabase('Player marketplace with real PostgreSQL', () => {
  let admin: DataSource, database: DataSource, app: INestApplication<App>;
  let links: CharacterLinkService, servers: GameServerService;
  let economy: EconomyService, reconciliation: EconomyReconciliationService;
  let custody: MarketplaceCustodyService;
  let settlement: MarketplaceSettlementService;
  let escrow: MarketEscrowService, tradeEscrow: TradeEscrowService;
  let registry: RealtimeConnectionRegistry;
  let server: GameServer, staffToken: string, url: string;
  const discord = new FakeDiscordProvider();
  const clients: RealtimeTestClient[] = [];
  const schema = `player_marketplace_test_${randomUUID().replaceAll('-', '')}`;
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
  const fund = async (char: string, amount: number, on = server) =>
    expect(
      await economy.creditFromSystem({
        gameServerId: on.id,
        characterExternalId: char,
        amount,
        idempotencyKey: randomUUID(),
        source: SystemSource.AGENT,
      }),
    ).toMatchObject({ outcome: 'POSTED' });
  const party = async (gold = 0, on = server): Promise<Party> => {
    const session = await login();
    const char = `char:${randomUUID()}`;
    const id = await link(session, 'VERIFIED', char, on);
    if (gold) await fund(char, gold, on);
    return { session, link: id, char };
  };
  // A new VERIFIED owner of an existing character identity.
  const heirOf = async (char: string): Promise<Party> => {
    const session = await login();
    return { session, link: await link(session, 'VERIFIED', char), char };
  };
  const balance = async (char: string, on = server) => {
    const [row] = await database.query(
      "SELECT balance FROM economy_accounts WHERE game_server_id = $1 AND owner_type = 'CHARACTER' AND character_external_id = $2",
      [on.id, char],
    );
    return row ? Number(row.balance) : 0;
  };
  const escrowBalance = async (on = server) => {
    const [row] = await database.query(
      "SELECT balance FROM economy_accounts WHERE game_server_id = $1 AND system_key = 'MARKET_ESCROW'",
      [on.id],
    );
    return row ? Number(row.balance) : 0;
  };
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
  const list = (p: Party, terms: Terms = {}, key?: string | null) =>
    post(
      p.session,
      'marketplace/listings',
      {
        characterLinkId: p.link,
        itemId: terms.itemId ?? 'item:sword',
        quantity: terms.quantity ?? 1,
        priceGold: terms.priceGold ?? 100,
      },
      key,
    );
  const custodied = (listingId: string, id?: string) =>
    custody.confirmFromAgent({
      listingId,
      custodyEventId: id ?? `custody:${randomUUID()}`,
      outcome: CustodyOutcome.CUSTODIED,
    });
  // Listed and held by the Agent: ACTIVE.
  const active = async (p: Party, terms: Terms = {}) => {
    const listing = (await list(p, terms).expect(201)).body;
    expect(await custodied(listing.listingId)).toEqual({
      outcome: 'APPLIED',
      status: 'ACTIVE',
    });
    return listing as { listingId: string; priceGold: number };
  };
  const buy = (p: Party, listingId: string, key?: string) =>
    post(
      p.session,
      `marketplace/listings/${listingId}/purchase`,
      { characterLinkId: p.link },
      key,
    );
  const cancel = (p: Party, listingId: string, key?: string) =>
    post(
      p.session,
      `marketplace/listings/${listingId}/cancel`,
      { characterLinkId: p.link },
      key,
    );
  const mine = (p: Party) =>
    get(p.session, `me/characters/${p.link}/marketplace/listings`);
  const own = async (p: Party, listingId: string) =>
    ((await mine(p).expect(200)).body.items as { listingId: string }[]).find(
      (l) => l.listingId === listingId,
    ) as Record<string, unknown> | undefined;
  const purchasesOf = (p: Party) =>
    get(p.session, `me/characters/${p.link}/marketplace/purchases`);
  const settle = (
    purchaseId: string,
    outcome: MarketSettlementOutcome,
    id?: string,
  ) =>
    settlement.confirmFromAgent({
      purchaseId,
      settlementEventId: id ?? `settle:${randomUUID()}`,
      outcome,
    });
  const audits = (listingId: string) =>
    database.query(
      'SELECT action, actor_type, actor_player_id, actor_system_source, resource_type, metadata FROM audit_logs WHERE resource_id = $1 ORDER BY created_at, action',
      [listingId],
    );
  const actions = async (listingId: string) =>
    (await audits(listingId)).map((a: { action: string }) => a.action);
  const escrows = (purchaseId: string) =>
    database.query(
      'SELECT buyer_character_id AS buyer, seller_character_id AS seller, amount::int, status, resolution_transaction_id IS NOT NULL AS resolved FROM player_marketplace_currency_escrows WHERE purchase_id = $1',
      [purchaseId],
    );
  const count = async (sql: string, params: unknown[] = []) =>
    (await database.query(sql, params))[0].n as number;
  const reconciled = async () => {
    expect(await reconciliation.accountMismatches()).toEqual([]);
    expect(await reconciliation.unbalancedTransactions()).toEqual([]);
    expect(await escrow.mismatches()).toEqual([]);
    expect(await escrow.inconsistencies()).toEqual([]);
    expect(await tradeEscrow.mismatches()).toEqual([]);
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
  const eventFor = (
    socket: RealtimeTestClient,
    type: string,
    listingId: string,
  ) =>
    socket.until(() =>
      socket
        .events()
        .find(
          (e) =>
            e.type === type &&
            (e.data as { listingId: string }).listingId === listingId,
        ),
    );
  const typesFor = (socket: RealtimeTestClient, listingId: string) =>
    socket
      .events()
      .filter((e) => (e.data as { listingId: string }).listingId === listingId)
      .map((e) => e.type);
  const quiet = () => new Promise((resolve) => setTimeout(resolve, 200));
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
    // Apply, revert (empty marketplace) and reapply the 10.14 migration.
    expect(await database.runMigrations()).toHaveLength(20);
    await database.undoLastMigration(); // Etapa 10.15 Player Chat
    await database.undoLastMigration();
    expect(
      await database.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename LIKE 'player_marketplace%'",
        [schema],
      ),
    ).toEqual([]);
    expect(await database.runMigrations()).toHaveLength(2);
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
    custody = app.get(MarketplaceCustodyService);
    settlement = app.get(MarketplaceSettlementService);
    escrow = app.get(MarketEscrowService);
    tradeEscrow = app.get(TradeEscrowService);
    registry = app.get(RealtimeConnectionRegistry);
    server = await servers.register({ code: randomUUID(), name: 'Market' });
    const password = 'Market-Staff-Password-42';
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

  it('adds the marketplace tables and MARKET_ESCROW with a database-enforced lifecycle', async () => {
    expect(database.options.synchronize).toBe(false);
    expect(await database.showMigrations()).toBe(false);
    expect(await database.query('SELECT * FROM migrations')).toHaveLength(20);
    const diff = await database.driver.createSchemaBuilder().log();
    expect([diff.upQueries, diff.downQueries]).toEqual([[], []]);
    const insert = (quantity: number, price: number) =>
      database.query(
        "INSERT INTO player_marketplace_listings(game_server_id, seller_character_id, item_external_id, quantity, price_gold) VALUES ($1, 'char:db', 'item', $2, $3) RETURNING id, status",
        [server.id, quantity, price],
      );
    // No free listings, bounded quantity and price.
    for (const [quantity, price] of [
      [1, 0],
      [0, 1],
      [10_001, 1],
      [1, 1_000_000_000_001],
    ])
      expect(await code(insert(quantity, price))).toBe('23514');
    const [{ id, status }] = await insert(1, 1);
    expect(status).toBe('PENDING_CUSTODY');
    // ACTIVE requires a custody event; terms and skipped states are refused.
    expect(
      await code(
        database.query(
          "UPDATE player_marketplace_listings SET status = 'ACTIVE' WHERE id = $1",
          [id],
        ),
      ),
    ).toBe('23514');
    for (const statement of [
      "UPDATE player_marketplace_listings SET status = 'SOLD', custody_event_id = 'e', reserved_by_character_id = 'char:b', reserved_at = now(), sold_at = now() WHERE id = $1",
      "UPDATE player_marketplace_listings SET status = 'RESERVED', custody_event_id = 'e', reserved_by_character_id = 'char:b', reserved_at = now() WHERE id = $1",
      'UPDATE player_marketplace_listings SET price_gold = 2 WHERE id = $1',
      'DELETE FROM player_marketplace_listings WHERE id = $1',
    ])
      expect(await code(database.query(statement, [id]))).toBe('55000');
    await database.query(
      "UPDATE player_marketplace_listings SET status = 'CANCELLED', cancelled_at = now() WHERE id = $1",
      [id],
    );
    // Terminal listings never reopen.
    for (const statement of [
      "UPDATE player_marketplace_listings SET status = 'ACTIVE', custody_event_id = 'e', cancelled_at = NULL WHERE id = $1",
      "UPDATE player_marketplace_listings SET status = 'PENDING_CUSTODY', cancelled_at = NULL WHERE id = $1",
    ])
      expect(await code(database.query(statement, [id]))).toBe('55000');
    for (const statement of [
      'TRUNCATE player_marketplace_listings CASCADE',
      "UPDATE player_marketplace_requests SET operation = 'CREATE'",
      'DELETE FROM player_marketplace_custody_events',
      'DELETE FROM player_marketplace_settlement_events',
    ])
      expect(await code(database.query(statement))).toBe('55000');
    // MARKET_ESCROW is an allowed system key; unknown keys are not.
    expect(
      await code(
        database.query(
          "INSERT INTO economy_accounts(game_server_id, currency, owner_type, system_key) VALUES ($1, 'GOLD', 'SYSTEM', 'AUCTION_ESCROW')",
          [server.id],
        ),
      ),
    ).toBe('23514');
    await reconciled();
  });
  it('creates PENDING_CUSTODY listings that are neither public nor purchasable until the Agent holds the item', async () => {
    const [seller, buyer] = [await party(), await party(500)];
    const created = await list(seller, {
      itemId: '  item:bow  ',
      quantity: 3,
      priceGold: 120,
    }).expect(201);
    expect(Object.keys(created.body).sort()).toEqual(OWN_LISTING_KEYS);
    expect(created.body).toMatchObject({
      gameServer: {
        id: server.id,
        code: server.code,
        name: 'Market',
        enabled: true,
      },
      characterLinkId: seller.link,
      sellerCharacterId: seller.char,
      itemId: 'item:bow',
      quantity: 3,
      priceGold: 120,
      status: 'PENDING_CUSTODY',
      buyerCharacterId: null,
      reservedAt: null,
      soldAt: null,
      cancelledAt: null,
      failedAt: null,
    });
    const { listingId } = created.body;
    // Nothing debited; not public, not purchasable.
    expect(await balance(seller.char)).toBe(0);
    await get(buyer.session, `marketplace/listings/${listingId}`).expect(404);
    const browse = await get(buyer.session, 'marketplace/listings').expect(200);
    expect(
      browse.body.items.map((l: { listingId: string }) => l.listingId),
    ).not.toContain(listingId);
    expect((await buy(buyer, listingId).expect(409)).body.message).toBe(
      'Listing is not available',
    );
    expect(await balance(buyer.char)).toBe(500);
    // The Agent confirms custody: ACTIVE.
    const eventId = `custody:${randomUUID()}`;
    expect(await custodied(listingId, eventId)).toEqual({
      outcome: 'APPLIED',
      status: 'ACTIVE',
    });
    const view = await get(
      buyer.session,
      `marketplace/listings/${listingId}`,
    ).expect(200);
    expect(Object.keys(view.body).sort()).toEqual(LISTING_KEYS);
    expect(view.body).toMatchObject({
      listingId,
      sellerCharacterId: seller.char,
      itemId: 'item:bow',
      quantity: 3,
      priceGold: 120,
      status: 'ACTIVE',
    });
    expect(await own(seller, listingId)).toMatchObject({ status: 'ACTIVE' });
    // Custody events are idempotent per id and conflict on other content.
    expect(await custodied(listingId, eventId)).toEqual({
      outcome: 'ALREADY_APPLIED',
      status: 'ACTIVE',
    });
    expect(
      await custody.confirmFromAgent({
        listingId,
        custodyEventId: eventId,
        outcome: CustodyOutcome.FAILED,
      }),
    ).toEqual({ outcome: 'REJECTED', reason: 'EVENT_CONFLICT' });
    const other = (await list(seller).expect(201)).body;
    expect(await custodied(other.listingId, eventId)).toEqual({
      outcome: 'REJECTED',
      reason: 'EVENT_CONFLICT',
    });
    expect(await custodied(listingId)).toEqual({
      outcome: 'REJECTED',
      reason: 'LISTING_NOT_PENDING',
    });
    expect(await custodied(randomUUID())).toEqual({
      outcome: 'REJECTED',
      reason: 'LISTING_NOT_FOUND',
    });
    for (const input of [
      { listingId: 'x', custodyEventId: 'e', outcome: CustodyOutcome.FAILED },
      { listingId, custodyEventId: ' ', outcome: CustodyOutcome.FAILED },
      { listingId, custodyEventId: 'e', outcome: 'LOST' as CustodyOutcome },
    ])
      expect(await custody.confirmFromAgent(input)).toEqual({
        outcome: 'REJECTED',
        reason: 'INVALID_INPUT',
      });
    // Custody failure ends a pending listing.
    expect(
      await custody.confirmFromAgent({
        listingId: other.listingId,
        custodyEventId: `custody:${randomUUID()}`,
        outcome: CustodyOutcome.FAILED,
      }),
    ).toEqual({ outcome: 'APPLIED', status: 'FAILED' });
    expect(await own(seller, other.listingId)).toMatchObject({
      status: 'FAILED',
      failedAt: expect.any(String),
    });
    await get(buyer.session, `marketplace/listings/${other.listingId}`).expect(
      404,
    );
    await buy(buyer, other.listingId).expect(409);
    expect(
      (await cancel(seller, other.listingId).expect(409)).body.message,
    ).toBe('Listing already finished');
    // Audit: one per effective mutation, with safe metadata.
    const trail = await audits(listingId);
    expect(trail.map((a: { action: string }) => a.action)).toEqual([
      'PLAYER_MARKETPLACE_LISTING_CREATED',
      'PLAYER_MARKETPLACE_LISTING_CUSTODIED',
    ]);
    expect(trail[0]).toMatchObject({
      actor_type: 'PLAYER',
      actor_player_id: seller.session.player.id,
      resource_type: 'PLAYER_MARKETPLACE',
      metadata: {
        listingId,
        gameServerId: server.id,
        sellerCharacterId: seller.char,
        itemExternalId: 'item:bow',
        quantity: 3,
        priceGold: 120,
        status: 'PENDING_CUSTODY',
      },
    });
    expect(trail[1]).toMatchObject({
      actor_type: 'SYSTEM',
      actor_system_source: 'AGENT',
      metadata: { status: 'ACTIVE', custodyEventId: eventId },
    });
    expect(await actions(other.listingId)).toEqual([
      'PLAYER_MARKETPLACE_LISTING_CREATED',
      'PLAYER_MARKETPLACE_LISTING_CUSTODY_FAILED',
    ]);
    await reconciled();
  });
  it('validates listing requests and browse filters strictly', async () => {
    const [p, stranger] = [await party(), await party()];
    const body = (extra: object) => ({
      characterLinkId: p.link,
      itemId: 'item:x',
      quantity: 1,
      priceGold: 10,
      ...extra,
    });
    for (const extra of [
      { priceGold: 0 },
      { priceGold: 1_000_000_000_001 },
      { priceGold: 1.5 },
      { priceGold: '10' },
      { quantity: 0 },
      { quantity: 10_001 },
      { itemId: '' },
      { itemId: 'a\u0000b' },
      { itemId: 'x'.repeat(129) },
      { status: 'ACTIVE' },
      { custodyEventId: 'e' },
      { sellerCharacterId: 'char:other' },
      { gameServerId: server.id },
      { itemName: 'Daedric Sword' },
      { characterLinkId: 'nope' },
    ])
      await post(p.session, 'marketplace/listings', body(extra)).expect(400);
    await list(p, {}, null).expect(400);
    await list(p, {}, 'bad key').expect(400);
    // Links that are not VERIFIED for this player cannot act.
    for (const characterLinkId of [
      await link(p.session, 'PENDING'),
      await link(p.session, 'REVOKED'),
      stranger.link,
      randomUUID(),
    ])
      await post(
        p.session,
        'marketplace/listings',
        body({ characterLinkId }),
      ).expect(404);
    await post(staffToken, 'marketplace/listings', body({})).expect(401);
    await http().get('/api/v1/player/marketplace/listings').expect(401);
    await get(staffToken, 'marketplace/listings').expect(401);
    // Suspended players are stopped by the guard.
    await database.query(
      "UPDATE players SET status = 'SUSPENDED' WHERE id = $1",
      [p.session.player.id],
    );
    try {
      await list(p).expect(403);
      await get(p.session, 'marketplace/listings').expect(403);
    } finally {
      await database.query(
        "UPDATE players SET status = 'ACTIVE' WHERE id = $1",
        [p.session.player.id],
      );
    }
    expect((await mine(p).expect(200)).body.total).toBe(0);
    for (const query of [
      'minPrice=0',
      'maxPrice=1000000000001',
      'minPrice=abc',
      'gameServerId=nope',
      'page=0',
      'limit=101',
      'itemName=sword',
      'status=PENDING_CUSTODY',
    ])
      await get(p.session, `marketplace/listings?${query}`).expect(400);
    expect(
      (
        await get(
          p.session,
          'marketplace/listings?minPrice=50&maxPrice=10',
        ).expect(400)
      ).body.message,
    ).toBe('minPrice must not exceed maxPrice');
    await get(p.session, 'marketplace/listings/nope').expect(400);
    await get(
      p.session,
      `me/characters/${stranger.link}/marketplace/listings`,
    ).expect(404);
    await get(
      p.session,
      `me/characters/${stranger.link}/marketplace/purchases`,
    ).expect(404);
  });
  it('browses only purchasable ACTIVE listings with safe filters and a stable order', async () => {
    const other = await servers.register({
      code: randomUUID(),
      name: 'Bazaar',
    });
    const [seller, viewer] = [await party(0, other), await party()];
    const ids: string[] = [];
    for (const priceGold of [10, 50, 100])
      ids.push((await active(seller, { priceGold })).listingId);
    await list(seller, { priceGold: 60 }).expect(201); // PENDING_CUSTODY
    const cancelled = await active(seller, { priceGold: 70 });
    await cancel(seller, cancelled.listingId).expect(200);
    const expected: string[] = (
      await database.query(
        "SELECT id FROM player_marketplace_listings WHERE game_server_id = $1 AND status = 'ACTIVE' ORDER BY created_at DESC, id DESC",
        [other.id],
      )
    ).map((r: { id: string }) => r.id);
    expect([...expected].sort()).toEqual([...ids].sort());
    const page = async (query: string) =>
      (
        await get(
          viewer.session,
          `marketplace/listings?gameServerId=${other.id}&${query}`,
        ).expect(200)
      ).body;
    const all = await page('');
    expect(all).toMatchObject({ total: 3, page: 1, limit: 20, totalPages: 1 });
    expect(all.items.map((l: { listingId: string }) => l.listingId)).toEqual(
      expected,
    );
    for (const item of all.items) {
      expect(Object.keys(item).sort()).toEqual(LISTING_KEYS);
      expect(item.status).toBe('ACTIVE');
      expect(item.gameServer).toEqual({
        id: other.id,
        code: other.code,
        name: 'Bazaar',
        enabled: true,
      });
    }
    const prices = async (query: string) =>
      (await page(query)).items
        .map((l: { priceGold: number }) => l.priceGold)
        .sort((a: number, b: number) => a - b);
    expect(await prices('minPrice=20')).toEqual([50, 100]);
    expect(await prices('maxPrice=50')).toEqual([10, 50]);
    expect(await prices('minPrice=20&maxPrice=60')).toEqual([50]);
    expect(await prices('minPrice=100&maxPrice=100')).toEqual([100]);
    const first = await page('limit=2');
    expect(first).toMatchObject({ total: 3, totalPages: 2 });
    expect(first.items.map((l: { listingId: string }) => l.listingId)).toEqual(
      expected.slice(0, 2),
    );
    const second = await page('limit=2&page=2');
    expect(second.items.map((l: { listingId: string }) => l.listingId)).toEqual(
      expected.slice(2),
    );
    // Without the server filter, every server's ACTIVE listings are listed.
    const everywhere = (
      await get(viewer.session, 'marketplace/listings?limit=100').expect(200)
    ).body.items.map((l: { listingId: string }) => l.listingId);
    expect(everywhere).toEqual(expect.arrayContaining(ids));
    // A seller character without a VERIFIED owner is not offered publicly.
    await links.revoke(playerActor(seller.session.player.id), seller.link);
    expect((await page('')).total).toBe(0);
    await get(viewer.session, `marketplace/listings/${ids[0]}`).expect(404);
  });
  it('purchases an ACTIVE listing atomically, reserving GOLD in MARKET_ESCROW', async () => {
    const [seller, buyer, late] = [
      await party(),
      await party(150),
      await party(500),
    ];
    const listing = await active(seller, {
      itemId: 'item:helm',
      priceGold: 100,
    });
    const escrowBefore = await escrowBalance();
    const response = await buy(buyer, listing.listingId).expect(201);
    expect(Object.keys(response.body).sort()).toEqual(PURCHASE_KEYS);
    expect(Object.keys(response.body.listing).sort()).toEqual(LISTING_KEYS);
    expect(response.body).toMatchObject({
      buyerCharacterId: buyer.char,
      status: 'AWAITING_GAME_CONFIRMATION',
      completedAt: null,
      failedAt: null,
      listing: {
        listingId: listing.listingId,
        sellerCharacterId: seller.char,
        itemId: 'item:helm',
        priceGold: 100,
        status: 'RESERVED',
      },
    });
    const { purchaseId } = response.body;
    expect(await balance(buyer.char)).toBe(50);
    expect(await balance(seller.char)).toBe(0);
    expect((await escrowBalance()) - escrowBefore).toBe(100);
    expect(await escrows(purchaseId)).toEqual([
      {
        buyer: buyer.char,
        seller: seller.char,
        amount: 100,
        status: 'RESERVED',
        resolved: false,
      },
    ]);
    expect(
      await database.query(
        'SELECT reference_type, actor_type, actor_player_id FROM economy_transactions WHERE reference_id = $1',
        [purchaseId],
      ),
    ).toEqual([
      {
        reference_type: 'PLAYER_MARKETPLACE',
        actor_type: 'PLAYER',
        actor_player_id: buyer.session.player.id,
      },
    ]);
    expect(await own(seller, listing.listingId)).toMatchObject({
      status: 'RESERVED',
      buyerCharacterId: buyer.char,
      reservedAt: expect.any(String),
    });
    const bought = (await purchasesOf(buyer).expect(200)).body;
    expect(bought).toMatchObject({ total: 1, page: 1 });
    expect(bought.items[0]).toMatchObject({
      purchaseId,
      status: 'AWAITING_GAME_CONFIRMATION',
    });
    expect((await purchasesOf(seller).expect(200)).body.total).toBe(0);
    // RESERVED: gone from browse; nobody else buys it; the seller cannot cancel.
    await get(late.session, `marketplace/listings/${listing.listingId}`).expect(
      404,
    );
    expect((await buy(late, listing.listingId).expect(409)).body.message).toBe(
      'Listing is not available',
    );
    expect(
      (await cancel(seller, listing.listingId).expect(409)).body.message,
    ).toBe('Listing is reserved by a purchase and cannot be cancelled');
    expect(await balance(late.char)).toBe(500);
    const [created] = (await audits(listing.listingId)).filter(
      (a: { action: string }) =>
        a.action === 'PLAYER_MARKETPLACE_PURCHASE_CREATED',
    );
    expect(created).toMatchObject({
      actor_type: 'PLAYER',
      actor_player_id: buyer.session.player.id,
      metadata: {
        listingId: listing.listingId,
        purchaseId,
        gameServerId: server.id,
        sellerCharacterId: seller.char,
        buyerCharacterId: buyer.char,
        itemExternalId: 'item:helm',
        quantity: 1,
        priceGold: 100,
        status: 'RESERVED',
        purchaseStatus: 'AWAITING_GAME_CONFIRMATION',
      },
    });
    await reconciled();
  });
  it('refuses own listings, other servers, unavailable sellers and insufficient funds without changes', async () => {
    const [seller, poor, exact] = [
      await party(),
      await party(99),
      await party(100),
    ];
    const listing = await active(seller, { priceGold: 100 });
    // The seller character cannot buy its own listing.
    expect(
      (await buy(seller, listing.listingId).expect(409)).body.message,
    ).toBe('Cannot buy your own listing');
    // A buyer character on another server.
    const elsewhere = await servers.register({
      code: randomUUID(),
      name: 'Far',
    });
    const foreign = await party(1000, elsewhere);
    expect(
      (await buy(foreign, listing.listingId).expect(409)).body.message,
    ).toBe('Listing is on another game server');
    // Insufficient funds: nothing changes, nothing is audited.
    expect((await buy(poor, listing.listingId).expect(409)).body.message).toBe(
      'Insufficient funds',
    );
    expect(await balance(poor.char)).toBe(99);
    expect(
      await count(
        'SELECT count(*)::int AS n FROM player_marketplace_purchases WHERE listing_id = $1',
        [listing.listingId],
      ),
    ).toBe(0);
    expect(await own(seller, listing.listingId)).toMatchObject({
      status: 'ACTIVE',
    });
    expect(await actions(listing.listingId)).not.toContain(
      'PLAYER_MARKETPLACE_PURCHASE_CREATED',
    );
    // Buyer links that are not VERIFIED for the player cannot act.
    for (const characterLinkId of [
      await link(poor.session, 'PENDING'),
      await link(poor.session, 'REVOKED'),
      exact.link,
    ])
      await post(
        poor.session,
        `marketplace/listings/${listing.listingId}/purchase`,
        { characterLinkId },
      ).expect(404);
    await buy(poor, randomUUID()).expect(404);
    await buy(poor, 'nope').expect(400);
    // The seller character must still have an ACTIVE, VERIFIED owner.
    await database.query("UPDATE players SET status = 'BANNED' WHERE id = $1", [
      seller.session.player.id,
    ]);
    try {
      expect(
        (await buy(exact, listing.listingId).expect(409)).body.message,
      ).toBe('Seller unavailable');
    } finally {
      await database.query(
        "UPDATE players SET status = 'ACTIVE' WHERE id = $1",
        [seller.session.player.id],
      );
    }
    // The exact balance is enough; GOLD never goes negative.
    await buy(exact, listing.listingId).expect(201);
    expect(await balance(exact.char)).toBe(0);
    // Another character of the same player may buy (distinct identity).
    const second = await active(seller, { priceGold: 5 });
    const siblingChar = `char:${randomUUID()}`;
    const sibling = {
      session: seller.session,
      link: await link(seller.session, 'VERIFIED', siblingChar),
      char: siblingChar,
    };
    await fund(siblingChar, 5);
    await buy(sibling, second.listingId).expect(201);
    expect(
      await database.query(
        "SELECT count(*)::int AS n FROM economy_accounts WHERE owner_type = 'CHARACTER' AND balance < 0",
      ),
    ).toEqual([{ n: 0 }]);
    await reconciled();
  });
  it('never sells twice or double-spends under concurrency', async () => {
    const seller = await party();
    // Two buyers race for one listing: one reservation.
    const [b1, b2] = [await party(100), await party(100)];
    const contested = await active(seller, { priceGold: 100 });
    const race = await Promise.all([
      buy(b1, contested.listingId),
      buy(b2, contested.listingId),
    ]);
    expect(race.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await balance(b1.char)) + (await balance(b2.char))).toBe(100);
    expect(
      await count(
        'SELECT count(*)::int AS n FROM player_marketplace_purchases WHERE listing_id = $1',
        [contested.listingId],
      ),
    ).toBe(1);
    // One buyer, GOLD for one of two listings: no double-spend.
    const spender = await party(100);
    const [l1, l2] = [
      await active(seller, { priceGold: 100 }),
      await active(seller, { priceGold: 100 }),
    ];
    const spend = await Promise.all([
      buy(spender, l1.listingId),
      buy(spender, l2.listingId),
    ]);
    expect(spend.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await balance(spender.char)).toBe(0);
    // Purchase racing a cancel: exactly one outcome.
    const racer = await party(100);
    const l3 = await active(seller, { priceGold: 100 });
    const [cancelled, purchased] = await Promise.all([
      cancel(seller, l3.listingId),
      buy(racer, l3.listingId),
    ]);
    const final = (await own(seller, l3.listingId))!.status;
    expect(
      final === 'CANCELLED'
        ? [cancelled.status, purchased.status, await balance(racer.char)]
        : [purchased.status, cancelled.status, await balance(racer.char)],
    ).toEqual(final === 'CANCELLED' ? [200, 409, 100] : [201, 409, 0]);
    // Cancel racing the custody confirmation: always CANCELLED in the end.
    const pending = (await list(seller).expect(201)).body;
    const [cancelResponse, custodyResult] = await Promise.all([
      cancel(seller, pending.listingId),
      custodied(pending.listingId),
    ]);
    expect(cancelResponse.status).toBe(200);
    expect(['APPLIED', 'REJECTED']).toContain(custodyResult.outcome);
    expect(await own(seller, pending.listingId)).toMatchObject({
      status: 'CANCELLED',
    });
    // Concurrent custody replays of one event apply once.
    const replayed = (await list(seller).expect(201)).body;
    const eventId = `custody:${randomUUID()}`;
    const replays = await Promise.all([
      custodied(replayed.listingId, eventId),
      custodied(replayed.listingId, eventId),
    ]);
    expect(replays.map((r) => r.outcome).sort()).toEqual([
      'ALREADY_APPLIED',
      'APPLIED',
    ]);
    // Concurrent create retries with one key create one listing.
    const key = randomUUID();
    const creates = await Promise.all([
      list(seller, { itemId: 'item:twin' }, key),
      list(seller, { itemId: 'item:twin' }, key),
    ]);
    expect(creates.map((r) => r.status)).toEqual([201, 201]);
    expect(creates[0].body.listingId).toBe(creates[1].body.listingId);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM player_marketplace_listings WHERE item_external_id = 'item:twin'",
      ),
    ).toBe(1);
    await reconciled();
  });
  it('settles a purchase through the Agent once: seller paid, listing SOLD', async () => {
    const [seller, buyer] = [await party(), await party(300)];
    const listing = await active(seller, { priceGold: 120 });
    const { purchaseId } = (await buy(buyer, listing.listingId).expect(201))
      .body;
    const escrowBefore = await escrowBalance();
    const eventId = `settle:${randomUUID()}`;
    expect(
      await settle(purchaseId, MarketSettlementOutcome.SETTLED, eventId),
    ).toEqual({
      outcome: 'APPLIED',
      status: 'COMPLETED',
    });
    expect([await balance(seller.char), await balance(buyer.char)]).toEqual([
      120, 180,
    ]);
    expect(escrowBefore - (await escrowBalance())).toBe(120);
    expect(await escrows(purchaseId)).toEqual([
      {
        buyer: buyer.char,
        seller: seller.char,
        amount: 120,
        status: 'SETTLED',
        resolved: true,
      },
    ]);
    expect(await own(seller, listing.listingId)).toMatchObject({
      status: 'SOLD',
      soldAt: expect.any(String),
      buyerCharacterId: buyer.char,
    });
    expect((await purchasesOf(buyer).expect(200)).body.items[0]).toMatchObject({
      purchaseId,
      status: 'COMPLETED',
      completedAt: expect.any(String),
      listing: { status: 'SOLD' },
    });
    // Replays, conflicts and late events change nothing.
    expect(
      await settle(purchaseId, MarketSettlementOutcome.SETTLED, eventId),
    ).toEqual({
      outcome: 'ALREADY_APPLIED',
      status: 'COMPLETED',
    });
    expect(
      await settle(purchaseId, MarketSettlementOutcome.FAILED, eventId),
    ).toEqual({
      outcome: 'REJECTED',
      reason: 'EVENT_CONFLICT',
    });
    expect(await settle(purchaseId, MarketSettlementOutcome.FAILED)).toEqual({
      outcome: 'REJECTED',
      reason: 'PURCHASE_NOT_AWAITING',
    });
    expect(await settle(randomUUID(), MarketSettlementOutcome.SETTLED)).toEqual(
      {
        outcome: 'REJECTED',
        reason: 'PURCHASE_NOT_FOUND',
      },
    );
    for (const input of [
      {
        purchaseId: 'x',
        settlementEventId: 'e',
        outcome: MarketSettlementOutcome.SETTLED,
      },
      {
        purchaseId,
        settlementEventId: '',
        outcome: MarketSettlementOutcome.SETTLED,
      },
      {
        purchaseId,
        settlementEventId: 'e',
        outcome: 'LOST' as MarketSettlementOutcome,
      },
    ])
      expect(await settlement.confirmFromAgent(input)).toEqual({
        outcome: 'REJECTED',
        reason: 'INVALID_INPUT',
      });
    expect([await balance(seller.char), await balance(buyer.char)]).toEqual([
      120, 180,
    ]);
    expect(
      (await cancel(seller, listing.listingId).expect(409)).body.message,
    ).toBe('Listing already finished');
    const trail = (await audits(listing.listingId)).filter(
      (a: { action: string }) =>
        a.action === 'PLAYER_MARKETPLACE_PURCHASE_SETTLED',
    );
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      actor_type: 'SYSTEM',
      actor_system_source: 'AGENT',
      metadata: {
        purchaseId,
        buyerCharacterId: buyer.char,
        status: 'SOLD',
        purchaseStatus: 'COMPLETED',
        settlementEventId: eventId,
      },
    });
    // Concurrent settlements: different events apply once; one event replays.
    const next = await active(seller, { priceGold: 10 });
    const p2 = (await buy(buyer, next.listingId).expect(201)).body.purchaseId;
    const different = await Promise.all([
      settle(p2, MarketSettlementOutcome.SETTLED),
      settle(p2, MarketSettlementOutcome.FAILED),
    ]);
    // The SETTLED call (index 0) either won and paid the seller, or lost.
    const soldNext = different[0].outcome === 'APPLIED' ? 10 : 0;
    expect(different.map((r) => r.outcome).sort()).toEqual([
      'APPLIED',
      'REJECTED',
    ]);
    expect(different.find((r) => r.outcome === 'REJECTED')).toEqual({
      outcome: 'REJECTED',
      reason: 'PURCHASE_NOT_AWAITING',
    });
    const last = await active(seller, { priceGold: 10 });
    const p3 = (await buy(buyer, last.listingId).expect(201)).body.purchaseId;
    const same = `settle:${randomUUID()}`;
    const replays = await Promise.all([
      settle(p3, MarketSettlementOutcome.SETTLED, same),
      settle(p3, MarketSettlementOutcome.SETTLED, same),
    ]);
    expect(replays.map((r) => r.outcome).sort()).toEqual([
      'ALREADY_APPLIED',
      'APPLIED',
    ]);
    expect(await balance(seller.char)).toBe(120 + soldNext + 10);
    await reconciled();
  });
  it('refunds the buyer once and fails the listing when the Agent reports FAILED', async () => {
    const [seller, buyer] = [await party(), await party(80)];
    const listing = await active(seller, { priceGold: 80 });
    const { purchaseId } = (await buy(buyer, listing.listingId).expect(201))
      .body;
    expect(await balance(buyer.char)).toBe(0);
    const eventId = `settle:${randomUUID()}`;
    expect(
      await settle(purchaseId, MarketSettlementOutcome.FAILED, eventId),
    ).toEqual({
      outcome: 'APPLIED',
      status: 'FAILED',
    });
    expect([await balance(buyer.char), await balance(seller.char)]).toEqual([
      80, 0,
    ]);
    expect(await escrows(purchaseId)).toEqual([
      {
        buyer: buyer.char,
        seller: seller.char,
        amount: 80,
        status: 'RELEASED',
        resolved: true,
      },
    ]);
    expect(await own(seller, listing.listingId)).toMatchObject({
      status: 'FAILED',
      failedAt: expect.any(String),
    });
    expect((await purchasesOf(buyer).expect(200)).body.items[0]).toMatchObject({
      purchaseId,
      status: 'FAILED',
      failedAt: expect.any(String),
    });
    // Refund replays never refund twice; the listing never reopens.
    expect(
      await settle(purchaseId, MarketSettlementOutcome.FAILED, eventId),
    ).toEqual({
      outcome: 'ALREADY_APPLIED',
      status: 'FAILED',
    });
    expect(await settle(purchaseId, MarketSettlementOutcome.SETTLED)).toEqual({
      outcome: 'REJECTED',
      reason: 'PURCHASE_NOT_AWAITING',
    });
    expect(await balance(buyer.char)).toBe(80);
    await buy(buyer, listing.listingId).expect(409);
    await cancel(seller, listing.listingId).expect(409);
    expect(await actions(listing.listingId)).toEqual([
      'PLAYER_MARKETPLACE_LISTING_CREATED',
      'PLAYER_MARKETPLACE_LISTING_CUSTODIED',
      'PLAYER_MARKETPLACE_PURCHASE_CREATED',
      'PLAYER_MARKETPLACE_PURCHASE_FAILED',
    ]);
    await reconciled();
  });
  it('keeps the purchase AWAITING with GOLD reserved when the ledger refuses the settlement', async () => {
    const [seller, buyer] = [await party(), await party(100)];
    const sockets = [
      await connected(seller.session),
      await connected(buyer.session),
    ];
    const listing = await active(seller, { priceGold: 100 });
    const { purchaseId } = (await buy(buyer, listing.listingId).expect(201))
      .body;
    // The seller reaches the balance ceiling: receiving 100 would exceed it.
    await fund(seller.char, 1_000_000_000_000);
    const escrowBefore = await escrowBalance();
    const eventId = `settle:${randomUUID()}`;
    expect(
      await settle(purchaseId, MarketSettlementOutcome.SETTLED, eventId),
    ).toEqual({
      outcome: 'REJECTED',
      reason: 'LEDGER_REJECTED',
      ledgerReason: 'BALANCE_LIMIT',
    });
    expect(await own(seller, listing.listingId)).toMatchObject({
      status: 'RESERVED',
      soldAt: null,
    });
    expect((await purchasesOf(buyer).expect(200)).body.items[0]).toMatchObject({
      purchaseId,
      status: 'AWAITING_GAME_CONFIRMATION',
      completedAt: null,
    });
    expect(await escrows(purchaseId)).toEqual([
      {
        buyer: buyer.char,
        seller: seller.char,
        amount: 100,
        status: 'RESERVED',
        resolved: false,
      },
    ]);
    expect(await escrowBalance()).toBe(escrowBefore);
    expect(
      await count(
        'SELECT count(*)::int AS n FROM player_marketplace_settlement_events WHERE purchase_id = $1',
        [purchaseId],
      ),
    ).toBe(0);
    expect(await actions(listing.listingId)).not.toContain(
      'PLAYER_MARKETPLACE_PURCHASE_SETTLED',
    );
    await quiet();
    for (const socket of sockets)
      expect(typesFor(socket, listing.listingId)).not.toContain(
        'MARKETPLACE_LISTING_SOLD',
      );
    await reconciled();
    // A later retry with the same event id (nothing was recorded) settles.
    expect(
      await economy.debitFromSystem({
        gameServerId: server.id,
        characterExternalId: seller.char,
        amount: 100,
        idempotencyKey: randomUUID(),
        source: SystemSource.AGENT,
      }),
    ).toMatchObject({ outcome: 'POSTED' });
    expect(
      await settle(purchaseId, MarketSettlementOutcome.SETTLED, eventId),
    ).toEqual({
      outcome: 'APPLIED',
      status: 'COMPLETED',
    });
    for (const socket of sockets)
      await eventFor(socket, 'MARKETPLACE_LISTING_SOLD', listing.listingId);
    expect(await balance(seller.char)).toBe(1_000_000_000_000);
    expect(await escrowBalance()).toBe(escrowBefore - 100);
    await reconciled();
  });
  it('cancels PENDING_CUSTODY and ACTIVE listings idempotently and only by their seller', async () => {
    const [seller, stranger] = [await party(), await party()];
    const pending = (await list(seller).expect(201)).body;
    const key = randomUUID();
    const first = await cancel(seller, pending.listingId, key).expect(200);
    expect(first.body).toMatchObject({
      status: 'CANCELLED',
      cancelledAt: expect.any(String),
      characterLinkId: seller.link,
    });
    // Same key replays; cancelling again is a no-op; neither audits.
    expect(
      (await cancel(seller, pending.listingId, key).expect(200)).body,
    ).toEqual(first.body);
    expect((await cancel(seller, pending.listingId).expect(200)).body).toEqual(
      first.body,
    );
    // A late custody report is refused: the Agent must return the item.
    expect(await custodied(pending.listingId)).toEqual({
      outcome: 'REJECTED',
      reason: 'LISTING_NOT_PENDING',
    });
    const activeListing = await active(seller);
    // Only the seller's current owner can cancel.
    await cancel(stranger, activeListing.listingId).expect(404);
    await post(
      stranger.session,
      `marketplace/listings/${activeListing.listingId}/cancel`,
      { characterLinkId: seller.link },
    ).expect(404);
    await cancel(seller, randomUUID()).expect(404);
    await cancel(seller, 'nope').expect(400);
    await cancel(seller, activeListing.listingId).expect(200);
    await get(
      stranger.session,
      `marketplace/listings/${activeListing.listingId}`,
    ).expect(404);
    await buy(stranger, activeListing.listingId).expect(409);
    const trails = [
      await audits(pending.listingId),
      await audits(activeListing.listingId),
    ];
    expect(
      trails.map((t) => t.map((a: { action: string }) => a.action)),
    ).toEqual([
      [
        'PLAYER_MARKETPLACE_LISTING_CREATED',
        'PLAYER_MARKETPLACE_LISTING_CANCELLED',
      ],
      [
        'PLAYER_MARKETPLACE_LISTING_CREATED',
        'PLAYER_MARKETPLACE_LISTING_CUSTODIED',
        'PLAYER_MARKETPLACE_LISTING_CANCELLED',
      ],
    ]);
    expect(trails[0][1].metadata).toMatchObject({
      status: 'CANCELLED',
      previousStatus: 'PENDING_CUSTODY',
    });
    expect(trails[1][2].metadata).toMatchObject({ previousStatus: 'ACTIVE' });
    await reconciled();
  });
  it('replays Player requests by Idempotency-Key without duplicate effects', async () => {
    const [seller, buyer, other] = [
      await party(),
      await party(100),
      await party(),
    ];
    const key = randomUUID();
    const created = await list(seller, { itemId: 'item:ring' }, key).expect(
      201,
    );
    const again = await list(seller, { itemId: 'item:ring' }, key).expect(201);
    expect(again.body).toEqual(created.body);
    expect((await mine(seller).expect(200)).body.total).toBe(1);
    expect(
      (await list(seller, { itemId: 'item:other' }, key).expect(409)).body
        .message,
    ).toBe('Idempotency-Key already used with different content');
    // Keys are scoped per player: another player's same key is independent.
    const independent = await list(other, { itemId: 'item:ring' }, key).expect(
      201,
    );
    expect(independent.body.listingId).not.toBe(created.body.listingId);
    // A key belongs to one operation.
    await cancel(seller, created.body.listingId, key).expect(409);
    await custodied(created.body.listingId);
    const purchaseKey = randomUUID();
    const bought = await buy(buyer, created.body.listingId, purchaseKey).expect(
      201,
    );
    const replay = await buy(buyer, created.body.listingId, purchaseKey).expect(
      201,
    );
    expect(replay.body.purchaseId).toBe(bought.body.purchaseId);
    expect(await balance(buyer.char)).toBe(0);
    const second = await active(other);
    await buy(buyer, second.listingId, purchaseKey).expect(409);
    expect(
      (await actions(created.body.listingId)).filter((a: string) =>
        a.startsWith('PLAYER_MARKETPLACE_'),
      ),
    ).toEqual([
      'PLAYER_MARKETPLACE_LISTING_CREATED',
      'PLAYER_MARKETPLACE_LISTING_CUSTODIED',
      'PLAYER_MARKETPLACE_PURCHASE_CREATED',
    ]);
    // A replay never answers to a player who lost the character.
    await links.revoke(playerActor(seller.session.player.id), seller.link);
    await list(seller, { itemId: 'item:ring' }, key).expect(404);
    await links.revoke(playerActor(buyer.session.player.id), buyer.link);
    await buy(buyer, created.body.listingId, purchaseKey).expect(404);
    // Requests are persisted per player scope, never exposed.
    const [row] = await database.query(
      'SELECT idempotency_scope, operation FROM player_marketplace_requests WHERE idempotency_key = $1 AND player_id = $2',
      [purchaseKey, buyer.session.player.id],
    );
    expect(row).toEqual({
      idempotency_scope: `PLAYER:${buyer.session.player.id}`,
      operation: 'PURCHASE',
    });
    await reconciled();
  });
  it('keeps listings and purchases with the character identity when ownership changes', async () => {
    const [seller, buyer] = [await party(), await party(200)];
    const listing = await active(seller, { priceGold: 100 });
    const inherited = await active(seller, { priceGold: 7 });
    // The old seller owner loses access at once; with no owner it is not sold.
    await links.revoke(playerActor(seller.session.player.id), seller.link);
    await mine(seller).expect(404);
    await cancel(seller, listing.listingId).expect(404);
    expect((await buy(buyer, listing.listingId).expect(409)).body.message).toBe(
      'Seller unavailable',
    );
    // The new owner of the seller character sees the existing listing.
    const heir = await heirOf(seller.char);
    expect(await own(heir, listing.listingId)).toMatchObject({
      status: 'ACTIVE',
      characterLinkId: heir.link,
      sellerCharacterId: seller.char,
    });
    // ...and can cancel it; the old owner still cannot.
    await cancel(seller, inherited.listingId).expect(404);
    expect(
      (await cancel(heir, inherited.listingId).expect(200)).body,
    ).toMatchObject({ status: 'CANCELLED', characterLinkId: heir.link });
    const { purchaseId } = (await buy(buyer, listing.listingId).expect(201))
      .body;
    // The buyer's ownership changes while RESERVED: same economic identity.
    await links.revoke(playerActor(buyer.session.player.id), buyer.link);
    await purchasesOf(buyer).expect(404);
    const buyerHeir = await heirOf(buyer.char);
    expect(
      (await purchasesOf(buyerHeir).expect(200)).body.items[0],
    ).toMatchObject({
      purchaseId,
      buyerCharacterId: buyer.char,
      status: 'AWAITING_GAME_CONFIRMATION',
    });
    // The seller changes owner again; settlement still pays the character.
    await links.revoke(playerActor(heir.session.player.id), heir.link);
    expect(await settle(purchaseId, MarketSettlementOutcome.SETTLED)).toEqual({
      outcome: 'APPLIED',
      status: 'COMPLETED',
    });
    const last = await heirOf(seller.char);
    expect(
      (await get(last.session, `me/characters/${last.link}/wallet`).expect(200))
        .body.balance,
    ).toBe(100);
    expect(await own(last, listing.listingId)).toMatchObject({
      status: 'SOLD',
    });
    expect(await balance(buyer.char)).toBe(100);
    // A refund also goes back to the buyer character, whoever owns it now.
    const refund = await active(last, { priceGold: 30 });
    const p2 = (await buy(buyerHeir, refund.listingId).expect(201)).body
      .purchaseId;
    await links.revoke(
      playerActor(buyerHeir.session.player.id),
      buyerHeir.link,
    );
    expect(await settle(p2, MarketSettlementOutcome.FAILED)).toEqual({
      outcome: 'APPLIED',
      status: 'FAILED',
    });
    expect(await balance(buyer.char)).toBe(100);
    await reconciled();
  });
  it('fans marketplace events to the seller and buyer only, after commit', async () => {
    const [seller, buyer, poor, stranger] = [
      await party(),
      await party(100),
      await party(1),
      await party(),
    ];
    const [ss, sb, sp, sx] = [
      await connected(seller.session),
      await connected(buyer.session),
      await connected(poor.session),
      await connected(stranger.session),
    ];
    const listing = await active(seller, {
      itemId: 'item:gem',
      quantity: 2,
      priceGold: 40,
    });
    const base = {
      listingId: listing.listingId,
      gameServerId: server.id,
      sellerCharacterId: seller.char,
      itemId: 'item:gem',
      quantity: 2,
      priceGold: 40,
    };
    expect(
      (await eventFor(ss, 'MARKETPLACE_LISTING_ACTIVE', listing.listingId))
        .data,
    ).toEqual({
      ...base,
      status: 'ACTIVE',
    });
    // A rolled-back purchase (insufficient funds) publishes nothing.
    await buy(poor, listing.listingId).expect(409);
    const { purchaseId } = (await buy(buyer, listing.listingId).expect(201))
      .body;
    for (const socket of [ss, sb])
      expect(
        (
          await eventFor(
            socket,
            'MARKETPLACE_LISTING_RESERVED',
            listing.listingId,
          )
        ).data,
      ).toEqual({
        ...base,
        status: 'RESERVED',
        purchaseId,
        buyerCharacterId: buyer.char,
        purchaseStatus: 'AWAITING_GAME_CONFIRMATION',
      });
    await settle(purchaseId, MarketSettlementOutcome.SETTLED);
    for (const socket of [ss, sb])
      expect(
        (await eventFor(socket, 'MARKETPLACE_LISTING_SOLD', listing.listingId))
          .data,
      ).toMatchObject({
        status: 'SOLD',
        purchaseId,
        purchaseStatus: 'COMPLETED',
      });
    // Cancel and custody failure reach the seller only.
    const toCancel = await active(seller);
    await cancel(seller, toCancel.listingId).expect(200);
    expect(
      (await eventFor(ss, 'MARKETPLACE_LISTING_CANCELLED', toCancel.listingId))
        .data,
    ).toMatchObject({
      status: 'CANCELLED',
      previousStatus: 'ACTIVE',
    });
    const lost = (await list(seller).expect(201)).body;
    await custody.confirmFromAgent({
      listingId: lost.listingId,
      custodyEventId: `custody:${randomUUID()}`,
      outcome: CustodyOutcome.FAILED,
    });
    await eventFor(ss, 'MARKETPLACE_LISTING_FAILED', lost.listingId);
    // A failed purchase: both learn it failed, the seller that the listing did.
    await fund(buyer.char, 40);
    const failing = await active(seller, { priceGold: 40 });
    const p2 = (await buy(buyer, failing.listingId).expect(201)).body
      .purchaseId;
    await settle(p2, MarketSettlementOutcome.FAILED);
    for (const socket of [ss, sb])
      expect(
        (
          await eventFor(
            socket,
            'MARKETPLACE_PURCHASE_FAILED',
            failing.listingId,
          )
        ).data,
      ).toMatchObject({
        status: 'FAILED',
        purchaseId: p2,
        purchaseStatus: 'FAILED',
      });
    await eventFor(ss, 'MARKETPLACE_LISTING_FAILED', failing.listingId);
    await quiet();
    expect(typesFor(ss, listing.listingId)).toEqual([
      'MARKETPLACE_LISTING_ACTIVE',
      'MARKETPLACE_LISTING_RESERVED',
      'MARKETPLACE_LISTING_SOLD',
    ]);
    expect(typesFor(sb, listing.listingId)).toEqual([
      'MARKETPLACE_LISTING_RESERVED',
      'MARKETPLACE_LISTING_SOLD',
    ]);
    expect(typesFor(sb, failing.listingId)).toEqual([
      'MARKETPLACE_LISTING_RESERVED',
      'MARKETPLACE_PURCHASE_FAILED',
    ]);
    for (const listingId of [toCancel.listingId, lost.listingId])
      expect(typesFor(sb, listingId)).toEqual([]);
    expect(sp.events()).toEqual([]);
    expect(sx.events()).toEqual([]);
    const everything = JSON.stringify([...ss.events(), ...sb.events()]);
    for (const secret of [
      seller.session.player.id,
      buyer.session.player.id,
      seller.link,
      buyer.link,
    ])
      expect(everything).not.toContain(secret);
    expect(everything).not.toMatch(
      /custody:|settle:|transaction|account|escrow|playerId/i,
    );
  });
  it('exposes no Agent routes and leaks no internal or financial ids', async () => {
    const [seller, buyer] = [await party(), await party(100)];
    const listing = await active(seller, { priceGold: 50 });
    const bought = await buy(buyer, listing.listingId).expect(201);
    for (const path of ['custody', 'settle', 'settlement', 'confirm'])
      await post(
        buyer.session,
        `marketplace/listings/${listing.listingId}/${path}`,
        {
          characterLinkId: buyer.link,
        },
      ).expect(404);
    await post(
      buyer.session,
      `marketplace/purchases/${bought.body.purchaseId}/settle`,
      {},
    ).expect(404);
    const internals: string[] = (
      await database.query(
        `SELECT id::text FROM economy_accounts WHERE game_server_id = $1
         UNION ALL SELECT id::text FROM economy_transactions WHERE reference_id = $2
         UNION ALL SELECT id::text FROM player_marketplace_currency_escrows WHERE purchase_id = $3
         UNION ALL SELECT custody_event_id FROM player_marketplace_listings WHERE id = $4`,
        [
          server.id,
          bought.body.purchaseId,
          bought.body.purchaseId,
          listing.listingId,
        ],
      )
    ).map((r: { id: string }) => r.id);
    expect(internals.length).toBeGreaterThan(3);
    const responses = JSON.stringify([
      bought.body,
      (await get(buyer.session, 'marketplace/listings?limit=100').expect(200))
        .body,
      (await mine(seller).expect(200)).body,
      (await purchasesOf(buyer).expect(200)).body,
    ]);
    for (const secret of [
      ...internals,
      seller.session.player.id,
      buyer.session.player.id,
      `PLAYER:${buyer.session.player.id}`,
    ])
      expect(responses).not.toContain(secret);
    // The seller link appears only in the seller's own listings.
    const publicViews = JSON.stringify([
      bought.body,
      (await get(buyer.session, 'marketplace/listings?limit=100').expect(200))
        .body,
    ]);
    expect(publicViews).not.toContain(seller.link);
    const { body: docs } = await http().get('/docs-json').expect(200);
    const props = (name: string) =>
      Object.keys(docs.components.schemas[name].properties).sort();
    expect(props('CreateListingBodyDto')).toEqual([
      'characterLinkId',
      'itemId',
      'priceGold',
      'quantity',
    ]);
    expect(props('ListingDto')).toEqual(LISTING_KEYS);
    expect(props('OwnListingDto')).toEqual(OWN_LISTING_KEYS);
    expect(props('PurchaseDto')).toEqual(PURCHASE_KEYS);
    const paths = Object.keys(docs.paths).filter((p) =>
      p.includes('marketplace'),
    );
    expect(paths.sort()).toEqual([
      '/api/v1/player/marketplace/listings',
      '/api/v1/player/marketplace/listings/{listingId}',
      '/api/v1/player/marketplace/listings/{listingId}/cancel',
      '/api/v1/player/marketplace/listings/{listingId}/purchase',
      '/api/v1/player/me/characters/{characterLinkId}/marketplace/listings',
      '/api/v1/player/me/characters/{characterLinkId}/marketplace/purchases',
    ]);
  });
  it('does not disturb trades sharing the ledger', async () => {
    const [a, b] = [await party(100), await party()];
    const trade = (
      await post(a.session, 'trades', {
        actorCharacterLinkId: a.link,
        targetCharacterId: b.char,
        offer: { gold: 60, items: [] },
      }).expect(201)
    ).body;
    await post(b.session, `trades/${trade.tradeId}/accept`, {
      characterLinkId: b.link,
      counterpartyOfferVersion: 1,
    }).expect(200);
    const listing = await active(b, { priceGold: 40 });
    // A spends the rest on B's listing while the trade completes.
    const [accepted, bought] = await Promise.all([
      post(a.session, `trades/${trade.tradeId}/accept`, {
        characterLinkId: a.link,
        counterpartyOfferVersion: 1,
      }),
      buy(a, listing.listingId),
    ]);
    expect([accepted.status, bought.status]).toEqual([200, 201]);
    expect(await balance(a.char)).toBe(0);
    await settle(bought.body.purchaseId, MarketSettlementOutcome.SETTLED);
    expect(await balance(b.char)).toBe(100);
    await reconciled();
  });
  it('blocks new economic operations on a disabled server without trapping items or GOLD', async () => {
    const closed = await servers.register({
      code: randomUUID(),
      name: 'Closed',
    });
    const enable = (enabled: boolean) =>
      database.query('UPDATE game_servers SET enabled = $2 WHERE id = $1', [
        closed.id,
        enabled,
      ]);
    const [seller, buyer, late] = [
      await party(0, closed),
      await party(500, closed),
      await party(500, closed),
    ];
    const [ss, sb, sl] = [
      await connected(seller.session),
      await connected(buyer.session),
      await connected(late.session),
    ];
    // Set up while enabled: pending, active and two reserved listings.
    const pending = (await list(seller).expect(201)).body;
    const open = await active(seller, { priceGold: 50 });
    const sold = await active(seller, { priceGold: 100 });
    const refunded = await active(seller, { priceGold: 70 });
    const p1 = (await buy(buyer, sold.listingId).expect(201)).body.purchaseId;
    const p2 = (await buy(buyer, refunded.listingId).expect(201)).body
      .purchaseId;
    expect(await balance(buyer.char, closed)).toBe(330);
    expect(await escrowBalance(closed)).toBe(170);
    const audited = () =>
      count(
        "SELECT count(*)::int AS n FROM audit_logs WHERE resource_type = 'PLAYER_MARKETPLACE' AND metadata->>'gameServerId' = $1",
        [closed.id],
      );
    const listed = () =>
      count(
        'SELECT count(*)::int AS n FROM player_marketplace_listings WHERE game_server_id = $1',
        [closed.id],
      );
    await quiet();
    const [auditsBefore, listingsBefore] = [await audited(), await listed()];
    const eventsBefore = [ss, sb, sl].map((s) => s.events().length);
    await enable(false);
    try {
      // CREATE: 409, nothing created, audited or published.
      expect((await list(seller).expect(409)).body.message).toBe(
        'Game server disabled',
      );
      expect(await listed()).toBe(listingsBefore);
      // PURCHASE: 409, the listing stays ACTIVE, no GOLD moves.
      expect((await buy(late, open.listingId).expect(409)).body.message).toBe(
        'Game server disabled',
      );
      expect(await own(seller, open.listingId)).toMatchObject({
        status: 'ACTIVE',
      });
      expect(
        await count(
          'SELECT count(*)::int AS n FROM player_marketplace_purchases WHERE listing_id = $1',
          [open.listingId],
        ),
      ).toBe(0);
      expect(await balance(late.char, closed)).toBe(500);
      expect(await escrowBalance(closed)).toBe(170);
      expect(await audited()).toBe(auditsBefore);
      await quiet();
      expect([ss, sb, sl].map((s) => s.events().length)).toEqual(eventsBefore);
      // The public catalog hides the server's listings; detail is 404.
      expect(
        (
          await get(
            late.session,
            `marketplace/listings?gameServerId=${closed.id}`,
          ).expect(200)
        ).body.total,
      ).toBe(0);
      expect(
        (
          await get(late.session, 'marketplace/listings?limit=100').expect(200)
        ).body.items.map((l: { listingId: string }) => l.listingId),
      ).not.toContain(open.listingId);
      await get(late.session, `marketplace/listings/${open.listingId}`).expect(
        404,
      );
      // The seller still sees every listing of the character.
      const statuses = Object.fromEntries(
        (
          (await mine(seller).expect(200)).body.items as {
            listingId: string;
            status: string;
          }[]
        ).map((l) => [l.listingId, l.status]),
      );
      expect(statuses).toEqual({
        [pending.listingId]: 'PENDING_CUSTODY',
        [open.listingId]: 'ACTIVE',
        [sold.listingId]: 'RESERVED',
        [refunded.listingId]: 'RESERVED',
      });
      expect((await purchasesOf(buyer).expect(200)).body.total).toBe(2);
      // Cleanup stays possible; RESERVED is still not cancellable.
      await cancel(seller, sold.listingId).expect(409);
      for (const listing of [pending, open])
        expect(
          (await cancel(seller, listing.listingId).expect(200)).body.status,
        ).toBe('CANCELLED');
      // Obligations created before the disable still resolve.
      expect(await settle(p1, MarketSettlementOutcome.SETTLED)).toEqual({
        outcome: 'APPLIED',
        status: 'COMPLETED',
      });
      expect(await settle(p2, MarketSettlementOutcome.FAILED)).toEqual({
        outcome: 'APPLIED',
        status: 'FAILED',
      });
      expect(await balance(seller.char, closed)).toBe(100);
      expect(await balance(buyer.char, closed)).toBe(400);
      expect(await escrowBalance(closed)).toBe(0);
      for (const [socket, type, listingId] of [
        [ss, 'MARKETPLACE_LISTING_CANCELLED', open.listingId],
        [ss, 'MARKETPLACE_LISTING_SOLD', sold.listingId],
        [sb, 'MARKETPLACE_LISTING_SOLD', sold.listingId],
        [sb, 'MARKETPLACE_PURCHASE_FAILED', refunded.listingId],
        [ss, 'MARKETPLACE_LISTING_FAILED', refunded.listingId],
      ] as const)
        await eventFor(socket, type, listingId);
      expect(typesFor(ss, open.listingId)).not.toContain(
        'MARKETPLACE_LISTING_RESERVED',
      );
      expect(sl.events()).toEqual([]);
      await reconciled();
    } finally {
      await enable(true);
    }
  });
  it('refuses to revert while marketplace listings exist', async () => {
    await reconciled();
    // No messages here: 10.15 reverts, then 10.14 refuses and is kept.
    await database.undoLastMigration();
    await expect(database.undoLastMigration()).rejects.toThrow(
      'marketplace listings exist',
    );
    expect(await database.runMigrations()).toHaveLength(1);
    expect(await database.showMigrations()).toBe(false);
    expect(await database.query('SELECT * FROM migrations')).toHaveLength(20);
  });
});
