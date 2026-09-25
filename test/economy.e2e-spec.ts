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
import {
  playerActor,
  SystemSource,
  systemActor,
} from '../src/actors/actor.contracts.js';
import { GameServerService } from '../src/game-bridge/game-server.service.js';
import type { GameServer } from '../src/game-bridge/entities/game-server.entity.js';
import { DiscordIdentityProvider } from '../src/player-auth/discord-identity.provider.js';
import { CharacterLinkService } from '../src/player-characters/character-link.service.js';
import { PlayerAuthRateLimiter } from '../src/player-auth/player-auth-rate-limit.js';
import { EconomyService } from '../src/economy/economy.service.js';
import { EconomyReconciliationService } from '../src/economy/economy-reconciliation.service.js';
import {
  Currency,
  MAX_CHARACTER_BALANCE,
} from '../src/economy/economy.contracts.js';
import { FakeDiscordProvider } from './support/fake-discord-provider.js';

const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;
interface Session {
  accessToken: string;
  player: { id: string };
}
describeDatabase('Economy ledger and wallet with real PostgreSQL', () => {
  let admin: DataSource, database: DataSource, app: INestApplication<App>;
  let links: CharacterLinkService, servers: GameServerService;
  let economy: EconomyService, reconciliation: EconomyReconciliationService;
  let server: GameServer, staffToken: string;
  const discord = new FakeDiscordProvider();
  const schema = `economy_test_${randomUUID().replaceAll('-', '')}`;
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
  // Returns [linkId, characterExternalId] in the requested state.
  const character = async (
    session: Session,
    state: 'PENDING' | 'VERIFIED' | 'REVOKED' = 'VERIFIED',
    characterExternalId = `char:${randomUUID()}`,
  ): Promise<[string, string]> => {
    const actor = playerActor(session.player.id);
    const requested = await links.request(actor, {
      gameServerId: server.id,
      characterExternalId,
    });
    if (state !== 'PENDING')
      await links.confirmFromAgent({
        challenge: requested.challenge,
        gameServerId: server.id,
        characterExternalId,
      });
    if (state === 'REVOKED') await links.revoke(actor, requested.link.id);
    return [requested.link.id, characterExternalId];
  };
  const get = (session: Session | string, path: string) =>
    http()
      .get(`/api/v1/player/me/characters/${path}`)
      .auth(typeof session === 'string' ? session : session.accessToken, {
        type: 'bearer',
      });
  const credit = (
    characterExternalId: string,
    amount: number,
    idempotencyKey: string = randomUUID(),
    source = SystemSource.AGENT,
  ) =>
    economy.creditFromSystem({
      gameServerId: server.id,
      characterExternalId,
      amount,
      idempotencyKey,
      source,
    });
  const debit = (
    characterExternalId: string,
    amount: number,
    idempotencyKey: string = randomUUID(),
  ) =>
    economy.debitFromSystem({
      gameServerId: server.id,
      characterExternalId,
      amount,
      idempotencyKey,
      source: SystemSource.AGENT,
    });
  const transfer = (
    from: string,
    to: string,
    amount: number,
    idempotencyKey: string = randomUUID(),
    actor = systemActor(SystemSource.AGENT) as Parameters<
      EconomyService['transfer']
    >[0]['actor'],
  ) =>
    economy.transfer({
      gameServerId: server.id,
      currency: Currency.GOLD,
      fromCharacterId: from,
      toCharacterId: to,
      amount,
      actor,
      idempotencyKey,
    });
  const balanceOf = async (characterExternalId: string) => {
    const [row] = await database.query(
      "SELECT balance FROM economy_accounts WHERE game_server_id = $1 AND owner_type = 'CHARACTER' AND character_external_id = $2",
      [server.id, characterExternalId],
    );
    return row ? Number(row.balance) : null;
  };
  const count = async (table: string, where = 'true', params: unknown[] = []) =>
    (
      await database.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
        params,
      )
    )[0].n;
  const ledgerCounts = async () => ({
    accounts: await count('economy_accounts'),
    transactions: await count('economy_transactions'),
    entries: await count('economy_entries'),
    audits: await count('audit_logs', "action LIKE 'ECONOMY_%'"),
  });
  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => 'ok',
      (error: { driverError?: { code: string }; code?: string }) =>
        error.driverError?.code ?? error.code,
    );
  // Raw SQL inside one explicit transaction, so deferred triggers fire on COMMIT.
  const atomically = async (statements: [string, unknown[]][]) => {
    const runner = database.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      for (const [sql, params] of statements) await runner.query(sql, params);
      await runner.commitTransaction();
    } catch (error) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  };
  const rawTransaction = (id: string, type = 'SYSTEM_CREDIT') =>
    [
      `INSERT INTO economy_transactions(id, game_server_id, currency, type, actor_type, actor_system_source, idempotency_scope, idempotency_key, request_fingerprint) VALUES ($1, $2, 'GOLD', $3, 'SYSTEM', 'AGENT', 'SYSTEM:AGENT', $4, repeat('0', 64))`,
      [id, server.id, type, randomUUID()],
    ] as [string, unknown[]];
  const rawEntry = (transactionId: string, accountId: string, amount: number) =>
    [
      `INSERT INTO economy_entries(transaction_id, account_id, game_server_id, currency, amount) VALUES ($1, $2, $3, 'GOLD', $4)`,
      [transactionId, accountId, server.id, amount],
    ] as [string, unknown[]];
  const accountId = async (characterExternalId: string) =>
    (
      await database.query(
        "SELECT id FROM economy_accounts WHERE game_server_id = $1 AND owner_type = 'CHARACTER' AND character_external_id = $2",
        [server.id, characterExternalId],
      )
    )[0].id as string;
  const systemAccountId = async (key: 'MINT' | 'BURN') =>
    (
      await database.query(
        "SELECT id FROM economy_accounts WHERE game_server_id = $1 AND owner_type = 'SYSTEM' AND system_key = $2",
        [server.id, key],
      )
    )[0].id as string;
  const reconciled = async () => {
    expect(await reconciliation.accountMismatches()).toEqual([]);
    expect(await reconciliation.unbalancedTransactions()).toEqual([]);
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
    // Apply, revert (empty ledger) and reapply the economy migration.
    expect(await database.runMigrations()).toHaveLength(23);
    await database.undoLastMigration(); // Etapa 11.1 Game Agent Transport
    await database.undoLastMigration(); // Etapa 10.17 VIP Entitlements
    await database.undoLastMigration(); // Etapa 10.16 Player Settings
    await database.undoLastMigration(); // Etapa 10.15 Player Chat
    await database.undoLastMigration(); // Etapa 10.14 Player Marketplace
    await database.undoLastMigration(); // Etapa 10.13 Player Trades
    await database.undoLastMigration();
    expect(
      await database.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename LIKE 'economy_%'",
        [schema],
      ),
    ).toEqual([]);
    expect(await database.runMigrations()).toHaveLength(7);
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
    economy = app.get(EconomyService);
    reconciliation = app.get(EconomyReconciliationService);
    server = await servers.register({ code: randomUUID(), name: 'Economy' });
    const password = 'Economy-Staff-Password-42';
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

  it('adds the ledger tables with no schema diff and database-enforced account shape', async () => {
    expect(database.options.synchronize).toBe(false);
    expect(await database.showMigrations()).toBe(false);
    expect(await database.query('SELECT * FROM migrations')).toHaveLength(23);
    const diff = await database.driver.createSchemaBuilder().log();
    expect([diff.upQueries, diff.downQueries]).toEqual([[], []]);
    const account = (
      columns: string,
      values: string,
      params: unknown[] = [server.id],
    ) =>
      database.query(
        `INSERT INTO economy_accounts(game_server_id, ${columns}) VALUES ($1, ${values})`,
        params,
      );
    const char = `char:${randomUUID()}`;
    expect(
      await code(
        account(
          'currency, owner_type, character_external_id',
          "'GOLD', 'CHARACTER', $2",
          [server.id, char],
        ),
      ),
    ).toBe('ok');
    expect(
      await code(
        account(
          'currency, owner_type, character_external_id',
          "'GOLD', 'CHARACTER', $2",
          [server.id, char],
        ),
      ),
    ).toBe('23505');
    for (const [columns, values] of [
      [
        'currency, owner_type, character_external_id',
        "'SILVER', 'CHARACTER', 'x'",
      ],
      [
        'currency, owner_type, character_external_id, system_key',
        "'GOLD', 'CHARACTER', 'x', 'MINT'",
      ],
      ['currency, owner_type', "'GOLD', 'CHARACTER'"],
      [
        'currency, owner_type, system_key',
        "'GOLD', 'SYSTEM', 'AUCTION_ESCROW'",
      ],
      [
        'currency, owner_type, character_external_id, system_key',
        "'GOLD', 'SYSTEM', 'x', 'MINT'",
      ],
      [
        'currency, owner_type, character_external_id',
        "'GOLD', 'CHARACTER', '  '",
      ],
    ])
      expect(await code(account(columns, values))).toBe('23514');
    // Accounts start at zero and their balance only moves through entries.
    expect(
      await code(
        account(
          'currency, owner_type, character_external_id, balance',
          "'GOLD', 'CHARACTER', $2, 10",
          [server.id, `char:${randomUUID()}`],
        ),
      ),
    ).toBe('55000');
    for (const statement of [
      'UPDATE economy_accounts SET balance = 50 WHERE character_external_id = $1',
      "UPDATE economy_accounts SET character_external_id = 'other' WHERE character_external_id = $1",
      'DELETE FROM economy_accounts WHERE character_external_id = $1',
    ])
      expect(await code(database.query(statement, [char]))).toBe('55000');
    expect(
      await code(database.query('TRUNCATE economy_accounts CASCADE')),
    ).toBe('55000');
  });
  it('refuses unbalanced, one-legged, cross-server or empty transactions at commit', async () => {
    const [a, b] = [`char:${randomUUID()}`, `char:${randomUUID()}`];
    await credit(a, 100);
    await credit(b, 100);
    const [accountA, accountB] = [await accountId(a), await accountId(b)];
    const before = await ledgerCounts();
    const tx = () => randomUUID();
    const t1 = tx();
    expect(
      await code(
        atomically([
          rawTransaction(t1, 'TRANSFER'),
          rawEntry(t1, accountA, -10),
        ]),
      ),
    ).toBe('23514');
    const t2 = tx();
    expect(
      await code(
        atomically([
          rawTransaction(t2, 'TRANSFER'),
          rawEntry(t2, accountA, -10),
          rawEntry(t2, accountB, 9),
        ]),
      ),
    ).toBe('23514');
    const t3 = tx();
    expect(await code(atomically([rawTransaction(t3)]))).toBe('23514');
    const t4 = tx();
    expect(
      await code(atomically([rawTransaction(t4), rawEntry(t4, accountA, 0)])),
    ).toBe('23514');
    // Entries are pinned to the transaction's and account's server/currency.
    const other = await servers.register({ code: randomUUID(), name: 'Other' });
    const t5 = tx();
    expect(
      await code(
        atomically([
          rawTransaction(t5, 'TRANSFER'),
          [
            `INSERT INTO economy_entries(transaction_id, account_id, game_server_id, currency, amount) VALUES ($1, $2, $3, 'GOLD', -5)`,
            [t5, accountA, other.id],
          ],
        ]),
      ),
    ).toBe('23503');
    // A character balance can never go negative, even with a balanced posting.
    const t6 = tx();
    expect(
      await code(
        atomically([
          rawTransaction(t6, 'TRANSFER'),
          rawEntry(t6, accountA, -101),
          rawEntry(t6, accountB, 101),
        ]),
      ),
    ).toBe('23514');
    // Only SYSTEM actors post SYSTEM_* transactions.
    const t7 = tx();
    const player = await login();
    expect(
      await code(
        atomically([
          [
            `INSERT INTO economy_transactions(id, game_server_id, currency, type, actor_type, actor_player_id, idempotency_scope, idempotency_key, request_fingerprint) VALUES ($1, $2, 'GOLD', 'SYSTEM_CREDIT', 'PLAYER', $3, $4, 'k', repeat('0', 64))`,
            [t7, server.id, player.player.id, `PLAYER:${player.player.id}`],
          ],
          rawEntry(t7, accountA, -1),
          rawEntry(t7, accountB, 1),
        ]),
      ),
    ).toBe('23514');
    expect(await ledgerCounts()).toEqual(before);
    // A valid raw posting commits and updates both projections.
    const ok = tx();
    await atomically([
      rawTransaction(ok, 'TRANSFER'),
      rawEntry(ok, accountA, -30),
      rawEntry(ok, accountB, 30),
    ]);
    expect([await balanceOf(a), await balanceOf(b)]).toEqual([70, 130]);
    await reconciled();
  });
  it('keeps the ledger append-only', async () => {
    const c = `char:${randomUUID()}`;
    const posted = await credit(c, 10);
    expect(posted.outcome).toBe('POSTED');
    for (const statement of [
      "UPDATE economy_transactions SET reference_type = 'X', reference_id = 'y'",
      'DELETE FROM economy_transactions',
      'TRUNCATE economy_transactions CASCADE',
      'UPDATE economy_entries SET amount = amount * 2',
      'DELETE FROM economy_entries',
      'TRUNCATE economy_entries',
    ])
      expect(await code(database.query(statement))).toBe('55000');
    // Nothing can be deleted through a cascade either.
    expect(
      await code(
        database.query('DELETE FROM game_servers WHERE id = $1', [server.id]),
      ),
    ).not.toBe('ok');
    expect(await balanceOf(c)).toBe(10);
    await reconciled();
  });
  it('credits from SYSTEM idempotently, creating accounts lazily, and audits it', async () => {
    const c = `char:${randomUUID()}`;
    const before = await ledgerCounts();
    const mintExisted = await count(
      'economy_accounts',
      "game_server_id = $1 AND system_key = 'MINT'",
      [server.id],
    );
    expect(await balanceOf(c)).toBeNull();
    const key = randomUUID();
    const first = await credit(c, 500, key);
    expect(first).toEqual({
      outcome: 'POSTED',
      transactionId: expect.any(String),
      balance: 500,
    });
    // Character account plus the server's MINT account, both created lazily.
    expect(await ledgerCounts()).toEqual({
      accounts: before.accounts + 1 + (mintExisted ? 0 : 1),
      transactions: before.transactions + 1,
      entries: before.entries + 2,
      audits: before.audits + 1,
    });
    expect(
      await database.query(
        'SELECT a.owner_type, a.system_key, e.amount FROM economy_entries e JOIN economy_accounts a ON a.id = e.account_id WHERE e.transaction_id = $1 ORDER BY e.amount',
        [first.outcome === 'POSTED' && first.transactionId],
      ),
    ).toEqual([
      { owner_type: 'SYSTEM', system_key: 'MINT', amount: '-500' },
      { owner_type: 'CHARACTER', system_key: null, amount: '500' },
    ]);
    const replay = await credit(c, 500, key);
    expect(replay).toEqual({ ...first, outcome: 'ALREADY_POSTED' });
    expect(await credit(c, 501, key)).toEqual({
      outcome: 'REJECTED',
      reason: 'IDEMPOTENCY_CONFLICT',
    });
    expect(await credit(`char:${randomUUID()}`, 500, key)).toMatchObject({
      reason: 'IDEMPOTENCY_CONFLICT',
    });
    // Scopes are per actor: another system source may reuse the key.
    expect(await credit(c, 500, key, SystemSource.VIP_DELIVERY)).toMatchObject({
      outcome: 'POSTED',
      balance: 1000,
    });
    const [transaction] = await database.query(
      'SELECT type, actor_type, actor_system_source, idempotency_scope, actor_player_id, actor_staff_id FROM economy_transactions WHERE id = $1',
      [first.outcome === 'POSTED' && first.transactionId],
    );
    expect(transaction).toEqual({
      type: 'SYSTEM_CREDIT',
      actor_type: 'SYSTEM',
      actor_system_source: 'AGENT',
      idempotency_scope: 'SYSTEM:AGENT',
      actor_player_id: null,
      actor_staff_id: null,
    });
    const audits = await database.query(
      "SELECT action, actor_type, actor_system_source, resource_type, resource_id, metadata FROM audit_logs WHERE action = 'ECONOMY_SYSTEM_CREDITED' AND metadata->>'characterExternalId' = $1 ORDER BY created_at",
      [c],
    );
    expect(audits).toHaveLength(2);
    expect(audits[0]).toEqual({
      action: 'ECONOMY_SYSTEM_CREDITED',
      actor_type: 'SYSTEM',
      actor_system_source: 'AGENT',
      resource_type: 'ECONOMY_TRANSACTION',
      resource_id: first.outcome === 'POSTED' && first.transactionId,
      metadata: {
        gameServerId: server.id,
        characterExternalId: c,
        currency: 'GOLD',
        amount: 500,
        transactionId: first.outcome === 'POSTED' && first.transactionId,
      },
    });
    expect(JSON.stringify(audits)).not.toContain(key);
    await reconciled();
  });
  it('rejects invalid input and enforces the character balance ceiling without changes', async () => {
    const c = `char:${randomUUID()}`;
    const before = await ledgerCounts();
    for (const amount of [0, -1, 1.5, Number.NaN, MAX_CHARACTER_BALANCE + 1])
      expect(await credit(c, amount)).toEqual({
        outcome: 'REJECTED',
        reason: 'INVALID_INPUT',
      });
    for (const input of [
      { characterExternalId: '' },
      { characterExternalId: 'a\u0000b' },
      { gameServerId: 'x' },
      { gameServerId: randomUUID() },
      { idempotencyKey: 'bad key' },
      { idempotencyKey: '' },
      { source: 'MARKET' as SystemSource },
    ])
      expect(
        await economy.creditFromSystem({
          gameServerId: server.id,
          characterExternalId: c,
          amount: 1,
          idempotencyKey: randomUUID(),
          source: SystemSource.AGENT,
          ...input,
        }),
      ).toMatchObject({ outcome: 'REJECTED', reason: 'INVALID_INPUT' });
    expect(await ledgerCounts()).toEqual(before);
    expect(await credit(c, MAX_CHARACTER_BALANCE)).toMatchObject({
      outcome: 'POSTED',
      balance: MAX_CHARACTER_BALANCE,
    });
    expect(await credit(c, 1)).toEqual({
      outcome: 'REJECTED',
      reason: 'BALANCE_LIMIT',
    });
    expect(await balanceOf(c)).toBe(MAX_CHARACTER_BALANCE);
    await reconciled();
  });
  it('debits to BURN only with sufficient funds, idempotently, never below zero', async () => {
    const c = `char:${randomUUID()}`;
    const before = await ledgerCounts();
    // No funds and no account: rejected, nothing created.
    expect(await debit(c, 1)).toEqual({
      outcome: 'REJECTED',
      reason: 'INSUFFICIENT_FUNDS',
    });
    expect(await ledgerCounts()).toEqual(before);
    await credit(c, 300);
    const key = randomUUID();
    const posted = await debit(c, 200, key);
    expect(posted).toMatchObject({ outcome: 'POSTED', balance: 100 });
    expect(await debit(c, 200, key)).toMatchObject({
      outcome: 'ALREADY_POSTED',
      balance: 100,
    });
    expect(await debit(c, 150, key)).toMatchObject({
      reason: 'IDEMPOTENCY_CONFLICT',
    });
    const middle = await ledgerCounts();
    expect(await debit(c, 101)).toEqual({
      outcome: 'REJECTED',
      reason: 'INSUFFICIENT_FUNDS',
    });
    for (const amount of [0, -5])
      expect((await debit(c, amount)).outcome).toBe('REJECTED');
    expect(await ledgerCounts()).toEqual(middle);
    expect(await balanceOf(c)).toBe(100);
    expect(
      await database.query(
        'SELECT a.system_key, e.amount FROM economy_entries e JOIN economy_accounts a ON a.id = e.account_id WHERE e.transaction_id = $1 ORDER BY e.amount',
        [posted.outcome === 'POSTED' && posted.transactionId],
      ),
    ).toEqual([
      { system_key: null, amount: '-200' },
      { system_key: 'BURN', amount: '200' },
    ]);
    expect(
      await count(
        'audit_logs',
        "action = 'ECONOMY_SYSTEM_DEBITED' AND metadata->>'characterExternalId' = $1",
        [c],
      ),
    ).toBe(1);
    await reconciled();
  });
  it('blocks SYSTEM movements for a suspended or banned current owner only', async () => {
    const owner = await login();
    const [link, c] = await character(owner);
    await credit(c, 50);
    for (const status of ['SUSPENDED', 'BANNED']) {
      await database.query('UPDATE players SET status = $2 WHERE id = $1', [
        owner.player.id,
        status,
      ]);
      expect(await credit(c, 10)).toEqual({
        outcome: 'REJECTED',
        reason: 'PLAYER_UNAVAILABLE',
      });
      expect(await debit(c, 10)).toEqual({
        outcome: 'REJECTED',
        reason: 'PLAYER_UNAVAILABLE',
      });
    }
    // Without a current owner, the character's wallet still moves.
    await database.query("UPDATE players SET status = 'ACTIVE' WHERE id = $1", [
      owner.player.id,
    ]);
    await links.revoke(playerActor(owner.player.id), link);
    await database.query("UPDATE players SET status = 'BANNED' WHERE id = $1", [
      owner.player.id,
    ]);
    expect(await credit(c, 10)).toMatchObject({
      outcome: 'POSTED',
      balance: 60,
    });
    expect(await credit(`char:${randomUUID()}`, 10)).toMatchObject({
      outcome: 'POSTED',
    });
  });
  it('transfers between characters internally, idempotently and without Audit', async () => {
    const [a, b] = [`char:${randomUUID()}`, `char:${randomUUID()}`];
    await credit(a, 300);
    const audits = await count('audit_logs', "action LIKE 'ECONOMY_%'");
    const key = randomUUID();
    const moved = await transfer(a, b, 120, key);
    expect(moved).toEqual({
      outcome: 'POSTED',
      transactionId: expect.any(String),
    });
    expect([await balanceOf(a), await balanceOf(b)]).toEqual([180, 120]);
    expect(await transfer(a, b, 120, key)).toEqual({
      ...moved,
      outcome: 'ALREADY_POSTED',
    });
    expect(await transfer(a, b, 121, key)).toMatchObject({
      reason: 'IDEMPOTENCY_CONFLICT',
    });
    expect(await transfer(b, a, 120, key)).toMatchObject({
      reason: 'IDEMPOTENCY_CONFLICT',
    });
    expect(await transfer(a, b, 181)).toEqual({
      outcome: 'REJECTED',
      reason: 'INSUFFICIENT_FUNDS',
    });
    for (const [from, to, amount] of [
      [a, a, 1],
      [a, ` ${a} `, 1],
      [a, b, 0],
      [a, b, -1],
      [a, b, 0.5],
    ] as const)
      expect(await transfer(from, to, amount)).toEqual({
        outcome: 'REJECTED',
        reason: 'INVALID_INPUT',
      });
    // Trade (10.13) will post as the PLAYER actor, in its own scope.
    const player = await login();
    const asPlayer = await transfer(
      a,
      b,
      10,
      key,
      playerActor(player.player.id),
    );
    expect(asPlayer.outcome).toBe('POSTED');
    const [row] = await database.query(
      'SELECT type, actor_type, actor_player_id, idempotency_scope FROM economy_transactions WHERE id = $1',
      [asPlayer.outcome === 'POSTED' && asPlayer.transactionId],
    );
    expect(row).toEqual({
      type: 'TRANSFER',
      actor_type: 'PLAYER',
      actor_player_id: player.player.id,
      idempotency_scope: `PLAYER:${player.player.id}`,
    });
    expect(await count('audit_logs', "action LIKE 'ECONOMY_%'")).toBe(audits);
    await reconciled();
  });
  it('lets PostgreSQL serialize concurrent credits, debits and transfers without lost updates', async () => {
    const c = `char:${randomUUID()}`;
    const key = randomUUID();
    const retries = await Promise.all(
      Array.from({ length: 8 }, () => credit(c, 100, key)),
    );
    expect(
      new Set(
        retries.map((r) =>
          r.outcome === 'REJECTED' ? r.reason : r.transactionId,
        ),
      ).size,
    ).toBe(1);
    expect(retries.filter((r) => r.outcome === 'POSTED')).toHaveLength(1);
    expect(
      await count('economy_transactions', 'idempotency_key = $1', [key]),
    ).toBe(1);
    const distinct = await Promise.all(
      Array.from({ length: 10 }, (_, i) => credit(c, i + 1)),
    );
    expect(distinct.every((r) => r.outcome === 'POSTED')).toBe(true);
    expect(await balanceOf(c)).toBe(100 + 55);
    // Concurrent debits never overdraw: 155 allows exactly 5 debits of 30.
    const debits = await Promise.all(
      Array.from({ length: 10 }, () => debit(c, 30)),
    );
    expect(debits.filter((r) => r.outcome === 'POSTED')).toHaveLength(5);
    expect(
      debits.filter(
        (r) => r.outcome === 'REJECTED' && r.reason === 'INSUFFICIENT_FUNDS',
      ),
    ).toHaveLength(5);
    expect(await balanceOf(c)).toBe(5);
    // Debit and credit racing: the debit either sees the credit or not.
    const [raceDebit, raceCredit] = await Promise.all([
      debit(c, 50),
      credit(c, 100),
    ]);
    expect(raceCredit.outcome).toBe('POSTED');
    expect(await balanceOf(c)).toBe(raceDebit.outcome === 'POSTED' ? 55 : 105);
    // Opposite transfers at once: ordered locks, no deadlock, no lost update.
    const [a, b] = [`char:${randomUUID()}`, `char:${randomUUID()}`];
    await credit(a, 1000);
    await credit(b, 1000);
    const transfers = await Promise.all([
      ...Array.from({ length: 10 }, () => transfer(a, b, 50)),
      ...Array.from({ length: 10 }, () => transfer(b, a, 30)),
    ]);
    expect(transfers.every((r) => r.outcome === 'POSTED')).toBe(true);
    expect([await balanceOf(a), await balanceOf(b)]).toEqual([800, 1200]);
    await reconciled();
  });
  it('rolls everything back when Audit or a ledger constraint fails', async () => {
    const c = `char:${randomUUID()}`;
    const before = await ledgerCounts();
    await database.query(`
      CREATE FUNCTION fail_economy_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'ECONOMY_SYSTEM_CREDITED' THEN
          RAISE EXCEPTION 'audit down';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_economy_audit BEFORE INSERT ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION fail_economy_audit();
    `);
    try {
      await expect(credit(c, 40)).rejects.toThrow(
        'Audit persistence unavailable',
      );
    } finally {
      await database.query(`
        DROP TRIGGER fail_economy_audit ON audit_logs;
        DROP FUNCTION fail_economy_audit();
      `);
    }
    expect(await ledgerCounts()).toEqual(before);
    expect(await balanceOf(c)).toBeNull();
    await database.query(`
      CREATE FUNCTION fail_economy_entry() RETURNS trigger AS $$
      BEGIN
        IF NEW.amount = 777 THEN
          RAISE EXCEPTION 'entry refused' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_economy_entry BEFORE INSERT ON economy_entries
        FOR EACH ROW EXECUTE FUNCTION fail_economy_entry();
    `);
    try {
      await expect(credit(c, 777)).rejects.toThrow('entry refused');
    } finally {
      await database.query(`
        DROP TRIGGER fail_economy_entry ON economy_entries;
        DROP FUNCTION fail_economy_entry();
      `);
    }
    expect(await ledgerCounts()).toEqual(before);
    expect(await credit(c, 40)).toMatchObject({
      outcome: 'POSTED',
      balance: 40,
    });
    await reconciled();
  });
  it('shows the own VERIFIED character wallet read-only, zero without any ledger row', async () => {
    const player = await login();
    const [link, c] = await character(player);
    const accounts = await count('economy_accounts');
    const response = await get(player, `${link}/wallet`).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      characterLinkId: link,
      currency: 'GOLD',
      balance: 0,
    });
    expect(
      (await get(player, `${link}/wallet/transactions`).expect(200)).body,
    ).toEqual({ items: [], total: 0, page: 1, limit: 20, totalPages: 0 });
    // Reads never create accounts.
    expect(await count('economy_accounts')).toBe(accounts);
    await credit(c, 250);
    expect((await get(player, `${link}/wallet`).expect(200)).body.balance).toBe(
      250,
    );
    // No route moves money.
    for (const method of ['post', 'put', 'patch', 'delete'] as const)
      for (const path of ['wallet', 'wallet/transactions', 'wallet/credit'])
        await http()
          [method](`/api/v1/player/me/characters/${link}/${path}`)
          .auth(player.accessToken, { type: 'bearer' })
          .send({ amount: 1_000_000, balance: 1_000_000 })
          .expect(404);
    for (const query of [
      'amount=5',
      'characterExternalId=x',
      'page=0',
      'limit=101',
    ])
      await get(player, `${link}/wallet/transactions?${query}`).expect(400);
    await get(player, `${link}/wallet?amount=5`).expect(400);
    expect((await get(player, `${link}/wallet`).expect(200)).body.balance).toBe(
      250,
    );
  });
  it('isolates wallets: other players, PENDING/REVOKED links and staff tokens get nothing', async () => {
    const [a, b] = [await login(), await login()];
    const [linkA, charA] = await character(a);
    await credit(charA, 90);
    const [pending] = await character(a, 'PENDING');
    const [revoked, revokedChar] = await character(a, 'REVOKED');
    await credit(revokedChar, 10);
    for (const [session, link] of [
      [b, linkA],
      [a, pending],
      [a, revoked],
      [a, randomUUID()],
    ] as const) {
      await get(session, `${link}/wallet`).expect(404);
      await get(session, `${link}/wallet/transactions`).expect(404);
    }
    await get(a, 'x/wallet').expect(400);
    await get(staffToken, `${linkA}/wallet`).expect(401);
    await http()
      .get(`/api/v1/player/me/characters/${linkA}/wallet`)
      .expect(401);
  });
  it('pages the character history newest first with a safe DTO', async () => {
    const player = await login();
    const [link, c] = await character(player);
    const [, other] = await character(await login());
    const ids: string[] = [];
    for (const amount of [100, 200, 300]) {
      const result = await credit(c, amount);
      if (result.outcome === 'POSTED') ids.push(result.transactionId);
    }
    const out = await debit(c, 50);
    if (out.outcome === 'POSTED') ids.push(out.transactionId);
    const sent = await transfer(c, other, 25);
    if (sent.outcome === 'POSTED') ids.push(sent.transactionId);
    const received = await transfer(other, c, 5);
    if (received.outcome === 'POSTED') ids.push(received.transactionId);
    const page1 = (
      await get(player, `${link}/wallet/transactions?limit=4`).expect(200)
    ).body;
    const page2 = (
      await get(player, `${link}/wallet/transactions?limit=4&page=2`).expect(
        200,
      )
    ).body;
    expect([page1.total, page1.totalPages, page2.page]).toEqual([6, 2, 2]);
    const items = [...page1.items, ...page2.items];
    expect(
      items.map((i: { transactionId: string }) => i.transactionId),
    ).toEqual([...ids].reverse());
    expect(
      items.map((i: { type: string; direction: string; amount: number }) => [
        i.type,
        i.direction,
        i.amount,
      ]),
    ).toEqual([
      ['TRANSFER', 'CREDIT', 5],
      ['TRANSFER', 'DEBIT', 25],
      ['SYSTEM_DEBIT', 'DEBIT', 50],
      ['SYSTEM_CREDIT', 'CREDIT', 300],
      ['SYSTEM_CREDIT', 'CREDIT', 200],
      ['SYSTEM_CREDIT', 'CREDIT', 100],
    ]);
    for (const item of items)
      expect(Object.keys(item).sort()).toEqual([
        'amount',
        'createdAt',
        'direction',
        'referenceId',
        'referenceType',
        'transactionId',
        'type',
      ]);
    expect((await get(player, `${link}/wallet`).expect(200)).body.balance).toBe(
      530,
    );
    const text = JSON.stringify([page1, page2]);
    const secrets = [
      other,
      player.player.id,
      await accountId(c),
      await accountId(other),
      await systemAccountId('MINT'),
      await systemAccountId('BURN'),
      ...(
        await database.query(
          'SELECT idempotency_key, idempotency_scope FROM economy_transactions WHERE id = ANY($1::uuid[])',
          [ids],
        )
      ).flatMap((r: { idempotency_key: string; idempotency_scope: string }) => [
        r.idempotency_key,
        r.idempotency_scope,
      ]),
    ];
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(text).not.toMatch(
      /accountId|playerId|staffId|idempotency|scope|entries|MINT|BURN/,
    );
  });
  it('keeps the wallet with the character when ownership changes', async () => {
    const [a, b] = [await login(), await login()];
    const c = `char:${randomUUID()}`;
    const [linkA] = await character(a, 'VERIFIED', c);
    await credit(c, 700);
    await debit(c, 100);
    const wallet = (await get(a, `${linkA}/wallet`).expect(200)).body;
    const history = (await get(a, `${linkA}/wallet/transactions`).expect(200))
      .body;
    expect(wallet.balance).toBe(600);
    await links.revoke(playerActor(a.player.id), linkA);
    await get(a, `${linkA}/wallet`).expect(404);
    await get(a, `${linkA}/wallet/transactions`).expect(404);
    const [linkB] = await character(b, 'VERIFIED', c);
    expect((await get(b, `${linkB}/wallet`).expect(200)).body).toEqual({
      characterLinkId: linkB,
      currency: 'GOLD',
      balance: 600,
    });
    expect(
      (await get(b, `${linkB}/wallet/transactions`).expect(200)).body,
    ).toEqual(history);
    expect(
      await count(
        'economy_accounts',
        "game_server_id = $1 AND owner_type = 'CHARACTER' AND character_external_id = $2",
        [server.id, c],
      ),
    ).toBe(1);
  });
  it('documents only read-only wallet routes', async () => {
    const { body } = await http().get('/docs-json').expect(200);
    const routes = Object.entries(body.paths).filter(([path]) =>
      path.includes('wallet'),
    );
    expect(
      routes.map(([path, ops]) => [path, Object.keys(ops as object)]),
    ).toEqual([
      ['/api/v1/player/me/characters/{characterLinkId}/wallet', ['get']],
      [
        '/api/v1/player/me/characters/{characterLinkId}/wallet/transactions',
        ['get'],
      ],
    ]);
    expect(
      Object.keys(body.paths).filter((p) =>
        /economy|ledger|mint|burn/i.test(p),
      ),
    ).toEqual([]);
    expect(
      Object.keys(body.components.schemas.WalletDto.properties).sort(),
    ).toEqual(['balance', 'characterLinkId', 'currency']);
  });
  it('reconciles every account and refuses to revert a non-empty ledger', async () => {
    await reconciled();
    const sums = await database.query(
      'SELECT transaction_id, sum(amount)::bigint AS total FROM economy_entries GROUP BY transaction_id HAVING sum(amount) <> 0',
    );
    expect(sums).toEqual([]);
    const before = await ledgerCounts();
    // No credentials, entitlements, settings, messages, listings or trades
    // here, so 11.1, 10.17, 10.16, 10.15, 10.14 and 10.13 revert; 10.12 then
    // refuses.
    await database.undoLastMigration();
    await database.undoLastMigration();
    await database.undoLastMigration();
    await database.undoLastMigration();
    await database.undoLastMigration();
    await database.undoLastMigration();
    await expect(database.undoLastMigration()).rejects.toThrow(
      'economy ledger is not empty',
    );
    expect(await ledgerCounts()).toEqual(before);
    expect(await database.runMigrations()).toHaveLength(6);
    expect(await database.showMigrations()).toBe(false);
  });
});
