import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
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
import { PlayerAccountService } from '../src/player-accounts/player-account.service.js';
import {
  IdentityProvider as P,
  PlayerStatus as S,
} from '../src/player-accounts/player-account.contracts.js';
import type { Player } from '../src/player-accounts/entities/player.entity.js';
import type { PlayerIdentity } from '../src/player-accounts/entities/player-identity.entity.js';

const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;
describeDatabase('Player accounts with real PostgreSQL', () => {
  let admin: DataSource, database: DataSource, app: INestApplication<App>;
  let accounts: PlayerAccountService;
  const schema = `player_accounts_test_${randomUUID().replaceAll('-', '')}`;
  const players = () => database.getRepository<Player>('Player');
  const identities = () =>
    database.getRepository<PlayerIdentity>('PlayerIdentity');
  const subject = () => `subject-${randomUUID()}`;
  const discord = (providerSubject = subject()) => ({
    provider: P.DISCORD,
    providerSubject,
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
    expect(await database.runMigrations()).toHaveLength(10);
    expect(await database.runMigrations()).toHaveLength(0);
    const { AppModule } = await import('../src/app.module.js');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DataSource)
      .useValue(database)
      .compile();
    app = module.createNestApplication(new AppExpressAdapter());
    app.useLogger(false);
    setupApp(app);
    await app.listen(0, '127.0.0.1');
    accounts = app.get(PlayerAccountService);
  }, 30000);
  afterAll(async () => {
    await app?.close();
    if (database?.isInitialized) await database.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });
  it('adds only players and player_identities, with no schema diff and no staff relation', async () => {
    expect(database.options.synchronize).toBe(false);
    expect(await database.showMigrations()).toBe(false);
    const diff = await database.driver.createSchemaBuilder().log();
    expect(diff.upQueries).toEqual([]);
    expect(diff.downQueries).toEqual([]);
    expect(await database.query('SELECT * FROM migrations')).toHaveLength(10);
    expect(await database.query('SELECT * FROM permissions')).toHaveLength(36);
    expect(await database.query('SELECT * FROM role_permissions')).toHaveLength(
      93,
    );
    const columns = async (table: string) =>
      (
        await database.query(
          'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position',
          [schema, table],
        )
      ).map((r: { column_name: string }) => r.column_name);
    expect(await columns('players')).toEqual([
      'id',
      'status',
      'display_name',
      'created_at',
      'updated_at',
    ]);
    expect(await columns('player_identities')).toEqual([
      'id',
      'player_id',
      'provider',
      'provider_subject',
      'created_at',
      'updated_at',
    ]);
    const foreignKeys = await database.query(
      `SELECT conrelid::regclass::text AS source, confrelid::regclass::text AS target
         FROM pg_constraint WHERE contype = 'f' AND connamespace = $1::regnamespace
         AND ($2 IN (conrelid::regclass::text, confrelid::regclass::text)
           OR $3 IN (conrelid::regclass::text, confrelid::regclass::text))`,
      [schema, 'players', 'player_identities'],
    );
    expect(foreignKeys).toEqual([
      { source: 'player_identities', target: 'players' },
    ]);
    expect(
      await database.query(
        'SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname',
        [schema, 'player_identities'],
      ),
    ).toEqual([
      { indexname: 'player_identities_pkey' },
      { indexname: 'player_identities_player_idx' },
      { indexname: 'player_identities_provider_subject_key' },
    ]);
  });
  it('creates ACTIVE players with trimmed, non-unique display names and looks them up by UUID', async () => {
    const first = await accounts.createPlayer({ displayName: '  Dovahkiin  ' });
    const second = await accounts.createPlayer({ displayName: 'Dovahkiin' });
    expect(first).toMatchObject({ displayName: 'Dovahkiin', status: S.ACTIVE });
    expect(first.id).not.toBe(second.id);
    expect(first.createdAt).toBeInstanceOf(Date);
    expect(await accounts.findPlayerById(first.id)).toEqual(first);
    expect(await accounts.findPlayerById(randomUUID())).toBeNull();
    await expect(accounts.findPlayerById('invalid')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const name = 'á'.repeat(64);
    expect(
      (await accounts.createPlayer({ displayName: name })).displayName,
    ).toBe(name);
  });
  it('rejects invalid display names without persistence', async () => {
    const before = await players().count();
    for (const displayName of [
      '',
      '   ',
      'x'.repeat(65),
      'a\nb',
      '\u0000',
      '\u009f',
      '\ud800',
      1,
      null,
      undefined,
      { name: 'x' },
    ])
      await expect(
        accounts.createPlayer({ displayName: displayName as string }),
      ).rejects.toBeInstanceOf(BadRequestException);
    expect(await players().count()).toBe(before);
    await expect(
      database.query("INSERT INTO players(display_name) VALUES ('  ')"),
    ).rejects.toMatchObject({ driverError: { code: '23514' } });
  });
  it('defaults to ACTIVE and accepts only ACTIVE, SUSPENDED and BANNED', async () => {
    const [row] = await database.query(
      "INSERT INTO players(display_name) VALUES ('Raw') RETURNING status",
    );
    expect(row.status).toBe(S.ACTIVE);
    const player = await accounts.createPlayer({ displayName: 'Status' });
    for (const status of [S.SUSPENDED, S.BANNED, S.ACTIVE]) {
      await players().update(player.id, { status });
      expect((await accounts.findPlayerById(player.id))?.status).toBe(status);
    }
    for (const status of ['DISABLED', 'active', ''])
      await expect(
        database.query('UPDATE players SET status = $1 WHERE id = $2', [
          status,
          player.id,
        ]),
      ).rejects.toMatchObject({ driverError: { code: '23514' } });
  });
  it('attaches DISCORD and STEAM identities to one player, idempotently, and looks up by identity', async () => {
    const player = await accounts.createPlayer({
      displayName: 'Multi',
      identity: discord(),
    });
    const discordIdentity = (await identities().findOneByOrFail({
      playerId: player.id,
    }))!;
    const steamSubject = subject();
    const steam = await accounts.attachIdentity(player.id, {
      provider: P.STEAM,
      providerSubject: `  ${steamSubject}  `,
    });
    expect(steam).toMatchObject({
      playerId: player.id,
      provider: P.STEAM,
      providerSubject: steamSubject,
    });
    const replay = await accounts.attachIdentity(player.id, {
      provider: P.STEAM,
      providerSubject: steamSubject,
    });
    expect(replay.id).toBe(steam.id);
    expect(await identities().countBy({ playerId: player.id })).toBe(2);
    expect(
      (
        await accounts.findByIdentity(
          P.DISCORD,
          discordIdentity.providerSubject,
        )
      )?.id,
    ).toBe(player.id);
    expect((await accounts.findByIdentity(P.STEAM, steamSubject))?.id).toBe(
      player.id,
    );
    expect(await accounts.findByIdentity(P.STEAM, subject())).toBeNull();
    expect(await accounts.findByIdentity(P.DISCORD, steamSubject)).toBeNull();
  });
  it('never links one identity to two players, while providers keep independent subjects', async () => {
    const shared = subject();
    const owner = await accounts.createPlayer({
      displayName: 'Owner',
      identity: discord(shared),
    });
    const other = await accounts.createPlayer({ displayName: 'Other' });
    await expect(
      accounts.attachIdentity(other.id, discord(shared)),
    ).rejects.toBeInstanceOf(ConflictException);
    const before = await players().count();
    await expect(
      accounts.createPlayer({ displayName: 'Dup', identity: discord(shared) }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await players().count()).toBe(before);
    const steam = await accounts.attachIdentity(other.id, {
      provider: P.STEAM,
      providerSubject: shared,
    });
    expect(steam.playerId).toBe(other.id);
    expect((await accounts.findByIdentity(P.DISCORD, shared))?.id).toBe(
      owner.id,
    );
    expect((await accounts.findByIdentity(P.STEAM, shared))?.id).toBe(other.id);
    await expect(
      database.query(
        'INSERT INTO player_identities(player_id, provider, provider_subject) VALUES ($1, $2, $3)',
        [other.id, P.DISCORD, shared],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23505' } });
  });
  it('rejects orphan identities, unknown providers and invalid subjects without echoing them', async () => {
    await expect(
      database.query(
        'INSERT INTO player_identities(player_id, provider, provider_subject) VALUES ($1, $2, $3)',
        [randomUUID(), P.DISCORD, subject()],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23503' } });
    await expect(
      accounts.attachIdentity(randomUUID(), discord()),
    ).rejects.toBeInstanceOf(NotFoundException);
    const player = await accounts.createPlayer({ displayName: 'Validation' });
    await expect(
      database.query(
        'INSERT INTO player_identities(player_id, provider, provider_subject) VALUES ($1, $2, $3)',
        [player.id, 'GOOGLE', subject()],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23514' } });
    for (const provider of ['GOOGLE', 'discord', '', null])
      await expect(
        accounts.attachIdentity(player.id, {
          provider: provider as P,
          providerSubject: subject(),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    const secret = `secret-${randomUUID()}`;
    for (const providerSubject of [
      '',
      '  ',
      'x'.repeat(129),
      `${secret}\n`,
      '\ud800',
      123,
      null,
    ]) {
      const error = await accounts
        .attachIdentity(player.id, {
          provider: P.DISCORD,
          providerSubject: providerSubject as string,
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(
        JSON.stringify((error as BadRequestException).getResponse()),
      ).not.toContain(secret);
    }
    expect(await identities().countBy({ playerId: player.id })).toBe(0);
  });
  it('lets PostgreSQL resolve concurrent creation and attachment of the same identity', async () => {
    const identity = discord();
    const before = await players().count();
    const created = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        accounts.createPlayer({ displayName: `Racer ${i}`, identity }),
      ),
    );
    expect(created.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of created.filter((r) => r.status === 'rejected'))
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(
        ConflictException,
      );
    expect(await players().count()).toBe(before + 1);
    const contenders = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        accounts.createPlayer({ displayName: `Contender ${i}` }),
      ),
    );
    const contested = discord();
    const attached = await Promise.allSettled(
      contenders.map((p) => accounts.attachIdentity(p.id, contested)),
    );
    expect(attached.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await identities().countBy({
        provider: P.DISCORD,
        providerSubject: contested.providerSubject,
      }),
    ).toBe(1);
    // The same player racing itself converges on one identity.
    const self = contenders[0];
    const own = discord();
    const replays = await Promise.all(
      Array.from({ length: 6 }, () => accounts.attachIdentity(self.id, own)),
    );
    expect(new Set(replays.map((r) => r.id)).size).toBe(1);
  });
  it('exposes no HTTP player surface', async () => {
    const http = () => request(app.getHttpServer());
    for (const path of [
      '/api/v1/players',
      `/api/v1/players/${randomUUID()}`,
      '/api/v1/player/me',
      '/api/v1/player/login',
    ]) {
      await http().get(path).expect(404);
      await http().post(path).send({ displayName: 'x' }).expect(404);
    }
    const { body } = await http().get('/docs-json').expect(200);
    // Moderation's staff routes (game-servers/:id/players/:playerId/...) are unrelated.
    expect(
      Object.keys(body.paths).filter((p) => /^\/api\/v1\/players?\b/.test(p)),
    ).toEqual([]);
  });
  it('reverts only the player tables and reapplies cleanly', async () => {
    await database.undoLastMigration();
    expect(
      await database.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename LIKE 'player%'",
        [schema],
      ),
    ).toEqual([]);
    expect(
      await database.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename IN ('staff_users', 'server_control_operations') ORDER BY tablename",
        [schema],
      ),
    ).toEqual([
      { tablename: 'server_control_operations' },
      { tablename: 'staff_users' },
    ]);
    expect(await database.runMigrations()).toHaveLength(1);
    expect(await database.runMigrations()).toHaveLength(0);
    expect(
      (await database.driver.createSchemaBuilder().log()).upQueries,
    ).toEqual([]);
  });
});
