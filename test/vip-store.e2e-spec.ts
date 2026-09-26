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
import { RoleName as R } from '../src/rbac/roles.js';
import type { VipOffer } from '../src/vip-store/entities/vip-offer.entity.js';
const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;
describeDatabase('VIP Store with real PostgreSQL', () => {
  let admin: DataSource, database: DataSource, app: INestApplication<App>;
  const schema = `vip_test_${randomUUID().replaceAll('-', '')}`;
  const tokens = new Map<R, string>(),
    staffIds = new Map<R, string>();
  const base = '/api/v1/admin/vip-store/offers',
    catalog = '/api/v1/vip-store/offers';
  const http = () => request(app.getHttpServer());
  const sample = () => ({
    code: `offer_${randomUUID()}`,
    name: 'VIP offer',
    description: 'Benefits\nPlain text',
    priceMinor: 1990,
    currency: 'BRL',
    rewards: [
      { type: 'ITEM', itemId: 'opaque:item', quantity: 3 },
      { type: 'HORSE', horseId: 'opaque:horse' },
      { type: 'TITLE', titleId: 'opaque:title' },
      { type: 'SPELL', spellId: 'opaque:spell' },
    ],
  });
  const post = (role = R.COORDINATOR) =>
    http().post(base).auth(tokens.get(role)!, { type: 'bearer' });
  const patch = (id: string, role = R.COORDINATOR) =>
    http().patch(`${base}/${id}`).auth(tokens.get(role)!, { type: 'bearer' });
  const active = (id: string, role = R.COORDINATOR) =>
    http()
      .patch(`${base}/${id}/active`)
      .auth(tokens.get(role)!, { type: 'bearer' });
  const get = (path = base, role = R.COORDINATOR) =>
    http().get(path).auth(tokens.get(role)!, { type: 'bearer' });
  const offers = () => database.getRepository<VipOffer>('VipOffer');
  const audits = (id: string) =>
    database.query(
      'SELECT * FROM audit_logs WHERE resource_id=$1 ORDER BY created_at,id',
      [id],
    );
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
    expect(await database.runMigrations()).toHaveLength(27);
    await database.undoLastMigration(); // Etapa 12.5 Multi-instance
    await database.undoLastMigration(); // Etapa 12.4 Operational Recovery
    await database.undoLastMigration(); // Etapa 11.4 Agent Domain Events
    await database.undoLastMigration(); // Etapa 11.3 Server Control Transport
    await database.undoLastMigration(); // Etapa 11.1 Game Agent Transport
    await database.undoLastMigration(); // Etapa 10.17 VIP Entitlements
    await database.undoLastMigration(); // Etapa 10.16 Player Settings
    await database.undoLastMigration(); // Etapa 10.15 Player Chat
    await database.undoLastMigration(); // Etapa 10.14 Player Marketplace
    await database.undoLastMigration(); // Etapa 10.13 Player Trades
    await database.undoLastMigration(); // Etapa 10.12 Economy
    await database.undoLastMigration(); // Etapa 10.9 Player Guilds
    await database.undoLastMigration(); // Etapa 10.8 Player Groups
    await database.undoLastMigration(); // Etapa 10.7 Professions
    await database.undoLastMigration(); // Etapa 10.4 Player Characters
    await database.undoLastMigration(); // Etapa 10.3 Player Sessions
    await database.undoLastMigration(); // Etapa 10.2 Generic Actor
    await database.undoLastMigration(); // Etapa 10.1 Player Accounts
    await database.undoLastMigration(); // Etapa 09 Server Control
    await database.undoLastMigration();
    expect(await database.query('SELECT * FROM permissions')).toHaveLength(35);
    expect(await database.query('SELECT * FROM role_permissions')).toHaveLength(
      92,
    );
    expect(
      await database.query(
        "SELECT * FROM pg_tables WHERE schemaname=$1 AND tablename='vip_offers'",
        [schema],
      ),
    ).toEqual([]);
    expect(
      await database.query(
        "SELECT * FROM role_permissions WHERE permission_name='VIP_STORE_WRITE'",
      ),
    ).toEqual([
      { role_name: 'COORDINATOR', permission_name: 'VIP_STORE_WRITE' },
    ]);
    expect(await database.runMigrations()).toHaveLength(20);
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
    const password = 'VIP-Store-Test-Password-42',
      hash = await new PasswordService().hash(password);
    for (const role of Object.values(R)) {
      const id = randomUUID();
      staffIds.set(role, id);
      await database.query(
        'INSERT INTO staff_users(id,username,display_name,password_hash,role_name) VALUES ($1,$2,$3,$4,$5)',
        [id, role.toLowerCase(), role, hash, role],
      );
      const { body } = await http()
        .post('/api/v1/auth/login')
        .send({ username: role.toLowerCase(), password })
        .expect(200);
      tokens.set(role, body.accessToken);
    }
  }, 30000);
  beforeEach(async () => {
    await database.query('DELETE FROM vip_offers');
  });
  afterEach(async () => {
    expect(await database.query('SELECT id FROM game_commands')).toEqual([]);
  });
  afterAll(async () => {
    await app?.close();
    if (database?.isInitialized) await database.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });
  it('has matching schema and the single additional Coordinator read grant', async () => {
    expect(database.options.synchronize).toBe(false);
    expect(await database.showMigrations()).toBe(false);
    const diff = await database.driver.createSchemaBuilder().log();
    expect(diff.upQueries).toEqual([]);
    expect(diff.downQueries).toEqual([]);
    expect(await database.query('SELECT * FROM permissions')).toHaveLength(45);
    expect(await database.query('SELECT * FROM role_permissions')).toHaveLength(
      116,
    );
    expect(
      await database.query(
        "SELECT * FROM role_permissions WHERE permission_name LIKE 'VIP_STORE_%' ORDER BY permission_name",
      ),
    ).toEqual([
      { role_name: 'COORDINATOR', permission_name: 'VIP_STORE_READ' },
      { role_name: 'COORDINATOR', permission_name: 'VIP_STORE_WRITE' },
    ]);
  });
  it.each(Object.values(R))(
    'enforces admin read/create/update/active permissions for %s',
    async (role) => {
      const { body: offer } = await post().send(sample()).expect(201);
      const allowed = role === R.COORDINATOR;
      await get(base, role).expect(allowed ? 200 : 403);
      await get(`${base}/${offer.id}`, role).expect(allowed ? 200 : 403);
      await post(role)
        .send(sample())
        .expect(allowed ? 201 : 403);
      await patch(offer.id, role)
        .send({ priceMinor: 1234 })
        .expect(allowed ? 200 : 403);
      await active(offer.id, role)
        .send({ active: true })
        .expect(allowed ? 200 : 403);
      expect(
        (await offers().findOneByOrFail({ id: offer.id })).priceMinor,
      ).toBe(allowed ? 1234 : 1990);
      expect(await audits(offer.id)).toHaveLength(allowed ? 3 : 1);
    },
  );
  it('requires staff authentication only on admin endpoints and rechecks current grants', async () => {
    await http().get(base).expect(401);
    await http().post(base).send(sample()).expect(401);
    const { body } = await post()
      .send({ ...sample(), active: true })
      .expect(201);
    await http().patch(`${base}/${body.id}`).send({ name: 'x' }).expect(401);
    await http()
      .patch(`${base}/${body.id}/active`)
      .send({ active: false })
      .expect(401);
    await http().get(catalog).expect(200);
    await http().get(`${catalog}/${body.code}`).expect(200);
    await database.query(
      "DELETE FROM role_permissions WHERE role_name='COORDINATOR' AND permission_name='VIP_STORE_WRITE'",
    );
    try {
      await patch(body.id).send({ priceMinor: 10 }).expect(403);
      await get().expect(200);
    } finally {
      await database.query(
        "INSERT INTO role_permissions VALUES ('COORDINATOR','VIP_STORE_WRITE')",
      );
    }
  });
  it('creates disabled by default with stable code/UUID and audits only allowlisted metadata', async () => {
    const input = { ...sample(), code: '  VIP_GOLD  ', name: ' VIP Gold ' },
      requestId = randomUUID();
    const { body } = await post()
      .set('x-request-id', requestId)
      .send(input)
      .expect(201);
    expect(body).toMatchObject({
      code: 'vip_gold',
      name: 'VIP Gold',
      active: false,
      sortOrder: 0,
      priceMinor: 1990,
      currency: 'BRL',
      rewards: input.rewards,
    });
    expect(body.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(body.createdAt).toBe(body.updatedAt);
    expect((await get(`${base}/${body.id}`).expect(200)).body).toEqual(body);
    await http().get(`${catalog}/vip_gold`).expect(404);
    const entries = await audits(body.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'VIP_OFFER_CREATED',
      outcome: 'SUCCESS',
      resource_type: 'VIP_OFFER',
      status_code: 201,
      actor_staff_id: staffIds.get(R.COORDINATOR),
      request_id: requestId,
    });
    expect(entries[0].metadata).toEqual({
      code: 'vip_gold',
      priceMinor: 1990,
      currency: 'BRL',
      active: false,
      rewardCount: 4,
      // 10.17: explicit scope, conservative default.
      entitlementScope: 'CHARACTER',
    });
    expect(JSON.stringify(entries[0].metadata)).not.toMatch(
      /opaque:|description|payload|rewards|token|password/,
    );
  });
  it('audits previous/new price and serializes independent updates without losing fields', async () => {
    const { body } = await post().send(sample()).expect(201);
    await Promise.all([
      patch(body.id).send({ priceMinor: 2500 }).expect(200),
      patch(body.id).send({ name: 'New name', sortOrder: 7 }).expect(200),
    ]);
    const final = (await get(`${base}/${body.id}`).expect(200)).body;
    expect(final).toMatchObject({
      id: body.id,
      code: body.code,
      priceMinor: 2500,
      name: 'New name',
      sortOrder: 7,
      rewards: body.rewards,
    });
    const entries = (await audits(body.id)).filter(
      (e: { action: string }) => e.action === 'VIP_OFFER_UPDATED',
    );
    expect(entries).toHaveLength(2);
    expect(
      entries.find((e: { metadata: { changedFields: string[] } }) =>
        e.metadata.changedFields.includes('priceMinor'),
      ).metadata,
    ).toEqual({
      code: body.code,
      changedFields: ['priceMinor'],
      previousPriceMinor: 1990,
      newPriceMinor: 2500,
      previousCurrency: 'BRL',
      newCurrency: 'BRL',
    });
    const same = await patch(body.id).send({ priceMinor: 2500 }).expect(200);
    expect(same.body.priceMinor).toBe(2500);
    expect((await audits(body.id)).at(-1).metadata).toEqual({
      code: body.code,
      changedFields: [],
    });
  });
  it('activates/disables without deleting or changing stable identity and records explicit actions', async () => {
    const { body } = await post().send(sample()).expect(201);
    await active(body.id).send({ active: true }).expect(200);
    await http().get(`${catalog}/${body.code}`).expect(200);
    await active(body.id).send({ active: false }).expect(200);
    await http().get(`${catalog}/${body.code}`).expect(404);
    expect((await get(`${base}/${body.id}`).expect(200)).body).toMatchObject({
      id: body.id,
      code: body.code,
      active: false,
    });
    const entries = await audits(body.id);
    expect(entries.map((e: { action: string }) => e.action)).toEqual([
      'VIP_OFFER_CREATED',
      'VIP_OFFER_ACTIVATED',
      'VIP_OFFER_DEACTIVATED',
    ]);
    expect(entries[1].metadata).toEqual({
      code: body.code,
      previousActive: false,
      newActive: true,
    });
    expect(entries[2].metadata).toEqual({
      code: body.code,
      previousActive: true,
      newActive: false,
    });
    await http()
      .delete(`${base}/${body.id}`)
      .auth(tokens.get(R.COORDINATOR)!, { type: 'bearer' })
      .expect(404);
  });
  it('exposes only active offers with deterministic ordering, bounded pagination and explicit public DTOs', async () => {
    for (const [code, sortOrder, isActive] of [
      ['vip_z', 1, true],
      ['vip_b', 0, true],
      ['vip_a', 0, true],
      ['vip_hidden', 0, false],
    ] as const)
      await post()
        .send({ ...sample(), code, sortOrder, active: isActive })
        .expect(201);
    const { body, headers } = await http()
      .get(catalog)
      .query({ page: 1, limit: 2 })
      .expect(200);
    expect(headers['cache-control']).toBe('no-store');
    expect(body).toMatchObject({ total: 3, page: 1, limit: 2, totalPages: 2 });
    expect(body.items.map((o: { code: string }) => o.code)).toEqual([
      'vip_a',
      'vip_b',
    ]);
    expect(
      (
        await http().get(catalog).query({ page: 2, limit: 2 }).expect(200)
      ).body.items.map((o: { code: string }) => o.code),
    ).toEqual(['vip_z']);
    const { body: offer } = await http().get(`${catalog}/vip_a`).expect(200);
    expect(Object.keys(offer).sort()).toEqual(
      [
        'id',
        'code',
        'name',
        'description',
        'priceMinor',
        'currency',
        'rewards',
        'entitlementScope',
      ].sort(),
    );
    expect(body.items[0]).toEqual(offer);
    expect((await get().expect(200)).body.total).toBe(4);
    await http().get(`${catalog}/vip_hidden`).expect(404);
    await http().get(catalog).query({ active: false }).expect(400);
    for (const query of [
      { limit: 101 },
      { page: 0 },
      { limit: 'x' },
      { page: 1000001 },
    ])
      await http().get(catalog).query(query).expect(400);
    expect(
      (await http().get(catalog).query({ page: 99 }).expect(200)).body.items,
    ).toEqual([]);
  });
  it('handles normalized duplicate codes concurrently through the PostgreSQL unique constraint', async () => {
    const input = sample();
    const responses = await Promise.all([
      post().send(input),
      post().send({ ...input, code: ` ${input.code.toUpperCase()} ` }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await offers().count()).toBe(1);
    const id = responses.find((r) => r.status === 201)!.body.id;
    expect(await audits(id)).toHaveLength(1);
    expect(
      (
        await database.query(
          "SELECT * FROM audit_logs WHERE action='VIP_OFFER_CREATED' AND outcome='FAILURE'",
        )
      ).length,
    ).toBeGreaterThan(0);
    await active(id).send({ active: false }).expect(200);
    await post().send(input).expect(409);
  });
  it.each(['create', 'update', 'active'])(
    'rolls back %s when Audit persistence fails',
    async (operation) => {
      const { body } = await post().send(sample()).expect(201),
        requestId = randomUUID();
      await database.query(
        `ALTER TABLE audit_logs ADD CONSTRAINT vip_audit_failure CHECK (request_id <> '${requestId}')`,
      );
      try {
        if (operation === 'create')
          await post()
            .set('x-request-id', requestId)
            .send(sample())
            .expect(503);
        if (operation === 'update')
          await patch(body.id)
            .set('x-request-id', requestId)
            .send({ priceMinor: 555 })
            .expect(503);
        if (operation === 'active')
          await active(body.id)
            .set('x-request-id', requestId)
            .send({ active: true })
            .expect(503);
        expect(await offers().count()).toBe(1);
        expect((await get(`${base}/${body.id}`).expect(200)).body).toEqual(
          body,
        );
        expect(await audits(body.id)).toHaveLength(1);
      } finally {
        await database.query(
          'ALTER TABLE audit_logs DROP CONSTRAINT vip_audit_failure',
        );
      }
    },
  );
  it.each([
    { code: 'ab' },
    { code: 'a'.repeat(65) },
    { code: 'bad code' },
    { code: 'a\ncode' },
    { name: '' },
    { name: ' ' },
    { name: 'x'.repeat(101) },
    { name: 'x\n' },
    { name: '\ud800' },
    { description: null },
    { description: 'x'.repeat(2001) },
    { description: 'x\u0000' },
    { priceMinor: -1 },
    { priceMinor: 1.1 },
    { priceMinor: '100' },
    { priceMinor: 2147483648 },
    { priceMinor: null },
    { currency: 'USD' },
    { currency: 'brl' },
    { currency: 'XYZ' },
    { active: 'true' },
    { active: null },
    { sortOrder: -1 },
    { sortOrder: 1.5 },
    { sortOrder: null },
    { rewards: [] },
    {
      rewards: Array.from({ length: 21 }, () => ({
        type: 'TITLE',
        titleId: 't',
      })),
    },
    { rewards: [{ type: 'ITEM', itemId: 'i', quantity: 0 }] },
    { rewards: [{ type: 'ITEM', itemId: 'i', quantity: 10001 }] },
    { rewards: [{ type: 'HORSE', horseId: 'h', quantity: 1 }] },
    { rewards: [{ type: 'SPELL', spellId: 's', characterId: 'c' }] },
    { rewards: [{ type: 'TITLE', titleId: '' }] },
    { rewards: [{ type: 'TITLE', titleId: 'x'.repeat(129) }] },
    { rewards: [{ type: 'SCRIPT', script: 'x' }] },
    { rewards: [{ type: 'ITEM', itemId: 'i', quantity: 1, rawCommand: 'x' }] },
    { actorStaffId: randomUUID() },
    { createdAt: '2020-01-01' },
    { rawCommand: 'x' },
  ])('rejects invalid creation %# without persisting', async (invalid) => {
    await post()
      .send({ ...sample(), ...invalid })
      .expect(400);
    expect(await offers().count()).toBe(0);
  });
  it('rejects missing required fields, immutable fields, empty/null patches and invalid active state', async () => {
    for (const field of [
      'code',
      'name',
      'description',
      'priceMinor',
      'currency',
      'rewards',
    ]) {
      const input: Record<string, unknown> = sample();
      delete input[field];
      await post().send(input).expect(400);
    }
    const { body } = await post().send(sample()).expect(201);
    for (const value of [
      {},
      { code: 'new_code' },
      { active: true },
      { priceMinor: null },
      { rewards: null },
      { description: null },
      { sortOrder: null },
      { requestedByStaffId: randomUUID() },
    ])
      await patch(body.id).send(value).expect(400);
    for (const value of [
      {},
      { active: 'false' },
      { active: null },
      { active: true, code: 'new_code' },
    ])
      await active(body.id).send(value).expect(400);
    expect((await get(`${base}/${body.id}`).expect(200)).body).toEqual(body);
    await get(`${base}/invalid`).expect(400);
    await get(`${base}/${randomUUID()}`).expect(404);
    await patch(randomUUID()).send({ name: 'missing' }).expect(404);
    await active(randomUUID()).send({ active: true }).expect(404);
    await http().get(`${catalog}/valid_missing`).expect(404);
  });
  it('accepts integer price boundaries and typed reward updates without triggering delivery', async () => {
    const { body } = await post()
      .send({
        ...sample(),
        priceMinor: 0,
        description: '',
        rewards: [{ type: 'ITEM', itemId: ' i ', quantity: 10000 }],
      })
      .expect(201);
    expect(body.rewards).toEqual([
      { type: 'ITEM', itemId: 'i', quantity: 10000 },
    ]);
    const updated = await patch(body.id)
      .send({
        priceMinor: 2147483647,
        rewards: [{ type: 'SPELL', spellId: ' s ' }],
      })
      .expect(200);
    expect(updated.body).toMatchObject({
      priceMinor: 2147483647,
      rewards: [{ type: 'SPELL', spellId: 's' }],
    });
    const entry = (await audits(body.id)).at(-1);
    expect(entry.metadata).toMatchObject({
      previousPriceMinor: 0,
      newPriceMinor: 2147483647,
      previousRewardCount: 1,
      newRewardCount: 1,
    });
    expect(JSON.stringify(entry.metadata)).not.toContain('spellId');
  });
  it('enforces money, code, rewards and ordering constraints for direct DB writes', async () => {
    const { body } = await post().send(sample()).expect(201);
    for (const [column, value] of [
      ['price_minor', -1],
      ['currency', 'USD'],
      ['sort_order', -1],
      ['code', 'bad code'],
      ['rewards', '{}'],
    ] as const)
      await expect(
        database.query(`UPDATE vip_offers SET ${column}=$1 WHERE id=$2`, [
          value,
          body.id,
        ]),
      ).rejects.toMatchObject({ driverError: { code: '23514' } });
  });
  it('documents distinct public/admin DTOs and no checkout, delete or execution endpoint', async () => {
    const { body } = await http().get('/docs-json').expect(200);
    expect(body.paths[base].post.security).toEqual([{ bearer: [] }]);
    expect(body.paths[catalog].get.security ?? []).toEqual([]);
    expect(
      body.components.schemas.VipOfferPublicDto.properties,
    ).not.toHaveProperty('active');
    expect(
      body.components.schemas.VipOfferPublicDto.properties,
    ).not.toHaveProperty('createdAt');
    expect(
      body.components.schemas.UpdateVipOfferDto.properties,
    ).not.toHaveProperty('code');
    expect(
      body.components.schemas.CreateVipOfferDto.properties.rewards.items.oneOf,
    ).toHaveLength(4);
    for (const suffix of ['checkout', 'purchase', 'payment', 'execute'])
      await http().post(`/api/v1/vip-store/${suffix}`).send({}).expect(404);
  });
});
