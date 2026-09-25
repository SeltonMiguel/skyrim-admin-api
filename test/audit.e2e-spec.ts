import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { compiledDatabaseArtifacts } from './compiled-database.js';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { setupApp } from '../src/setup-app.js';
import { AppExpressAdapter } from '../src/common/http/app-express.adapter.js';
import { RequestContext } from '../src/common/request-context/request-context.service.js';
import { loadEnvironment } from '../src/config/environment.js';
import { createDatabaseOptions } from '../src/database/database.options.js';
import { BootstrapCoordinatorService } from '../src/staff/bootstrap-coordinator.service.js';
import { PasswordService } from '../src/auth/password.service.js';
import {
  StaffUser,
  StaffStatus,
} from '../src/staff/entities/staff-user.entity.js';
import { StaffSession } from '../src/auth/entities/staff-session.entity.js';
import { AuditService } from '../src/audit/audit.service.js';
import { AuditLog } from '../src/audit/entities/audit-log.entity.js';
import {
  AuditAction,
  AuditOutcome,
  AuditResource,
} from '../src/audit/audit.types.js';
import { RoleName } from '../src/rbac/roles.js';

const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;

describeDatabase('Audit with real PostgreSQL', () => {
  let app: INestApplication<App>;
  let admin: DataSource;
  let database: DataSource;
  let coordinator: { id: string; accessToken: string; refreshToken: string };
  let bootstrap: BootstrapCoordinatorService;
  const schema = `audit_test_${randomUUID().replaceAll('-', '')}`;
  const password = 'audit-private-password-123';
  const http = () => request(app.getHttpServer());
  const entries = () => database.getRepository<AuditLog>('AuditLog');
  const records = (requestId: string) => entries().findBy({ requestId });
  const create = (
    role: RoleName = RoleName.SUPPORT,
    requestId: string = randomUUID(),
  ) =>
    http()
      .post('/api/v1/staff')
      .auth(coordinator.accessToken, { type: 'bearer' })
      .set('x-request-id', requestId)
      .send({
        username: `staff-${randomUUID()}`,
        displayName: 'Staff',
        password,
        role,
      });
  const login = (username: string, requestId: string = randomUUID()) =>
    http()
      .post('/api/v1/auth/login')
      .set('x-request-id', requestId)
      .send({ username, password });
  const list = (
    query: Record<string, string | number | undefined> = {},
    token = coordinator.accessToken,
  ) => http().get('/api/v1/audit').auth(token, { type: 'bearer' }).query(query);

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
    expect(await database.runMigrations()).toHaveLength(24);
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
    await database.undoLastMigration(); // Etapa 08 VIP Store
    await database.undoLastMigration(); // Etapa 07 World permission grants
    await database.undoLastMigration(); // Etapa 05 result size constraint
    await database.undoLastMigration(); // Etapa 04 permission grants
    await database.undoLastMigration();
    await database.undoLastMigration();
    await database.undoLastMigration();
    expect(
      await database.query(
        'SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename = $2',
        [schema, 'audit_logs'],
      ),
    ).toEqual([]);
    expect(
      await database.query(
        'SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = $2',
        [schema, 'reject_audit_log_mutation'],
      ),
    ).toEqual([]);
    expect(await database.runMigrations()).toHaveLength(23);
    expect(await database.runMigrations()).toHaveLength(0);
    bootstrap = new BootstrapCoordinatorService(
      database,
      new PasswordService(),
      new AuditService(database, new RequestContext()),
    );
    expect(
      await bootstrap.run({
        username: 'coordinator',
        displayName: 'Coordinator',
        password,
      }),
    ).toBe('created');
    expect(await bootstrap.run({})).toBe('already-exists');
    const { AppModule } = await import('../src/app.module.js');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DataSource)
      .useValue(database)
      .compile();
    app = module.createNestApplication(new AppExpressAdapter());
    app.useLogger(false);
    setupApp(app);
    await app.listen(0, '127.0.0.1');
    const { body } = await login('coordinator').expect(200);
    coordinator = {
      id: body.staff.id,
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
    };
  }, 30000);

  afterAll(async () => {
    await app?.close();
    if (database?.isInitialized) await database.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  it('creates audit_logs with matching entity metadata and useful indexes', async () => {
    expect(database.options.synchronize).toBe(false);
    expect(
      (await database.driver.createSchemaBuilder().log()).upQueries,
    ).toEqual([]);
    const columns: { column_name: string; data_type: string }[] =
      await database.query(
        'SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
        [schema, 'audit_logs'],
      );
    expect(columns).toContainEqual({
      column_name: 'metadata',
      data_type: 'jsonb',
    });
    expect(columns).toContainEqual({
      column_name: 'action',
      data_type: 'character varying',
    });
    expect(columns.map((column) => column.column_name)).not.toContain(
      'updated_at',
    );
    const indexes: { indexname: string }[] = await database.query(
      'SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = $2',
      [schema, 'audit_logs'],
    );
    expect(indexes).toHaveLength(8);
  });
  it.each([
    'UPDATE audit_logs SET outcome = outcome',
    'DELETE FROM audit_logs',
    'TRUNCATE TABLE audit_logs',
  ])('blocks direct mutation: %s', async (sql) => {
    const count = await entries().count();
    await expect(database.query(sql)).rejects.toThrow(
      'audit_logs is append-only',
    );
    expect(await entries().count()).toBe(count);
  });
  it('records bootstrap once with no invented HTTP context or actor', async () => {
    await bootstrap.run({});
    const logs = await entries().findBy({
      action: AuditAction.COORDINATOR_BOOTSTRAP,
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      outcome: 'SUCCESS',
      resourceType: 'STAFF_USER',
      resourceId: coordinator.id,
      actorStaffId: null,
      requestId: null,
      method: null,
      path: null,
      ipAddress: null,
      userAgent: null,
    });
  });
  it('records staff creation with actor snapshot and response request ID without credentials', async () => {
    const requestId: string = randomUUID();
    const response = await http()
      .post('/api/v1/staff?password=query-secret')
      .auth(coordinator.accessToken, { type: 'bearer' })
      .set('x-request-id', requestId)
      .set('User-Agent', 'audit-test-agent')
      .set('Cookie', 'session=cookie-secret')
      .send({
        username: `staff-${randomUUID()}`,
        displayName: 'Created',
        password,
        role: RoleName.SUPPORT,
      })
      .expect(201);
    expect(response.headers['x-request-id']).toBe(requestId);
    const logs = await records(requestId);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: 'STAFF_CREATE',
      outcome: 'SUCCESS',
      actorStaffId: coordinator.id,
      actorUsername: 'coordinator',
      actorDisplayName: 'Coordinator',
      actorRole: 'COORDINATOR',
      resourceType: 'STAFF_USER',
      resourceId: response.body.id,
      requestId,
      method: 'POST',
      path: '/api/v1/staff',
      statusCode: 201,
      userAgent: 'audit-test-agent',
      metadata: null,
    });
    expect(logs[0].ipAddress).toBeTruthy();
    const stored = JSON.stringify(logs);
    for (const secret of [
      password,
      coordinator.accessToken,
      'cookie-secret',
      'query-secret',
      'passwordHash',
      'refreshTokenHash',
    ])
      expect(stored).not.toContain(secret);
  });
  it('correlates a generated request ID when the client omits it', async () => {
    const response = await http()
      .patch(`/api/v1/staff/${coordinator.id}`)
      .auth(coordinator.accessToken, { type: 'bearer' })
      .send({ displayName: 'Coordinator' })
      .expect(200);
    expect(await records(response.headers['x-request-id'])).toHaveLength(1);
  });
  it('audits profile, role and status changes with explicit safe metadata', async () => {
    const { body: target } = await create().expect(201);
    const cases = [
      {
        suffix: '',
        body: { displayName: 'Changed' },
        action: 'STAFF_UPDATE',
        metadata: { changedFields: ['displayName'] },
      },
      {
        suffix: '/role',
        body: { role: 'MODERATOR' },
        action: 'STAFF_ROLE_CHANGE',
        metadata: { previousRole: 'SUPPORT', newRole: 'MODERATOR' },
      },
      {
        suffix: '/status',
        body: { status: 'DISABLED' },
        action: 'STAFF_STATUS_CHANGE',
        metadata: { previousStatus: 'ACTIVE', newStatus: 'DISABLED' },
      },
    ];
    for (const test of cases) {
      const requestId: string = randomUUID();
      await http()
        .patch(`/api/v1/staff/${target.id}${test.suffix}`)
        .auth(coordinator.accessToken, { type: 'bearer' })
        .set('x-request-id', requestId)
        .send(test.body)
        .expect(200);
      const logs = await records(requestId);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        action: test.action,
        outcome: 'SUCCESS',
        resourceId: target.id,
        statusCode: 200,
        metadata: test.metadata,
      });
    }
  });
  it('keeps the original actor snapshot after profile, role and status changes', async () => {
    const { body: actor } = await create(RoleName.COORDINATOR).expect(201);
    const { body: session } = await login(actor.username).expect(200);
    const requestId: string = randomUUID();
    await http()
      .patch(`/api/v1/staff/${actor.id}`)
      .auth(session.accessToken, { type: 'bearer' })
      .set('x-request-id', requestId)
      .send({
        username: `renamed-${randomUUID()}`,
        displayName: 'Renamed Actor',
      })
      .expect(200);
    await http()
      .patch(`/api/v1/staff/${actor.id}/role`)
      .auth(coordinator.accessToken, { type: 'bearer' })
      .send({ role: 'SUPPORT' })
      .expect(200);
    await http()
      .patch(`/api/v1/staff/${actor.id}/status`)
      .auth(coordinator.accessToken, { type: 'bearer' })
      .send({ status: 'DISABLED' })
      .expect(200);
    expect((await records(requestId))[0]).toMatchObject({
      actorStaffId: actor.id,
      actorUsername: actor.username,
      actorDisplayName: 'Staff',
      actorRole: 'COORDINATOR',
    });
  });
  it('keeps FAILURE after a transaction rolls back, including database uniqueness errors', async () => {
    const requestId: string = randomUUID();
    await http()
      .patch(`/api/v1/staff/${coordinator.id}/status`)
      .auth(coordinator.accessToken, { type: 'bearer' })
      .set('x-request-id', requestId)
      .send({ status: 'DISABLED' })
      .expect(409);
    const logs = await records(requestId);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: 'STAFF_STATUS_CHANGE',
      outcome: 'FAILURE',
      resourceId: coordinator.id,
      statusCode: 409,
    });
    expect(
      (
        await database
          .getRepository<StaffUser>('StaffUser')
          .findOneByOrFail({ id: coordinator.id })
      ).status,
    ).toBe(StaffStatus.ACTIVE);
    const duplicateId = randomUUID();
    await http()
      .post('/api/v1/staff')
      .auth(coordinator.accessToken, { type: 'bearer' })
      .set('x-request-id', duplicateId)
      .send({
        username: 'coordinator',
        displayName: 'Duplicate',
        password,
        role: 'SUPPORT',
      })
      .expect(409);
    expect((await records(duplicateId))[0]).toMatchObject({
      action: 'STAFF_CREATE',
      outcome: 'FAILURE',
      statusCode: 409,
    });
  });
  it('rolls back staff/session changes if SUCCESS audit cannot be written and persists FAILURE separately', async () => {
    const { body: target } = await create().expect(201);
    const { body: session } = await login(target.username).expect(200);
    await database.query(
      "ALTER TABLE audit_logs ADD CONSTRAINT test_reject_success CHECK (request_id <> 'audit-test-fail-success' OR outcome <> 'SUCCESS')",
    );
    try {
      await http()
        .patch(`/api/v1/staff/${target.id}/status`)
        .auth(coordinator.accessToken, { type: 'bearer' })
        .set('x-request-id', 'audit-test-fail-success')
        .send({ status: 'DISABLED' })
        .expect(503);
      expect(
        (
          await database
            .getRepository<StaffUser>('StaffUser')
            .findOneByOrFail({ id: target.id })
        ).status,
      ).toBe('ACTIVE');
      expect(
        (
          await database
            .getRepository<StaffSession>('StaffSession')
            .findBy({ staffUserId: target.id })
        ).every((entry) => entry.revokedAt === null),
      ).toBe(true);
      await http()
        .get('/api/v1/auth/me')
        .auth(session.accessToken, { type: 'bearer' })
        .expect(200);
      const logs = await records('audit-test-fail-success');
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ outcome: 'FAILURE', statusCode: 503 });
    } finally {
      await database.query(
        'ALTER TABLE audit_logs DROP CONSTRAINT test_reject_success',
      );
    }
  });
  it('returns 503 and rolls back if neither outcome can be persisted', async () => {
    const { body: target } = await create().expect(201);
    await database.query(
      "ALTER TABLE audit_logs ADD CONSTRAINT test_reject_all CHECK (request_id <> 'audit-test-fail-all')",
    );
    try {
      const response = await http()
        .patch(`/api/v1/staff/${target.id}`)
        .auth(coordinator.accessToken, { type: 'bearer' })
        .set('x-request-id', 'audit-test-fail-all')
        .send({ displayName: 'Must Roll Back' })
        .expect(503);
      expect(response.body.message).toBe('Audit persistence unavailable');
      expect(
        (
          await database
            .getRepository<StaffUser>('StaffUser')
            .findOneByOrFail({ id: target.id })
        ).displayName,
      ).toBe('Staff');
      expect(await records('audit-test-fail-all')).toHaveLength(0);
    } finally {
      await database.query(
        'ALTER TABLE audit_logs DROP CONSTRAINT test_reject_all',
      );
    }
  });
  it('audits login and logout, but not refresh or rejected login', async () => {
    const loginId = randomUUID();
    const { body: session } = await login('coordinator', loginId).expect(200);
    const loggedIn = await records(loginId);
    expect(loggedIn).toHaveLength(1);
    expect(loggedIn[0]).toMatchObject({
      action: 'AUTH_LOGIN',
      outcome: 'SUCCESS',
      actorStaffId: coordinator.id,
      resourceType: 'STAFF_SESSION',
      statusCode: 200,
    });
    const refreshId = randomUUID();
    const rotated = await http()
      .post('/api/v1/auth/refresh')
      .set('x-request-id', refreshId)
      .send({ refreshToken: session.refreshToken })
      .expect(200);
    expect(await records(refreshId)).toHaveLength(0);
    const logoutId = randomUUID();
    await http()
      .post('/api/v1/auth/logout')
      .auth(rotated.body.accessToken, { type: 'bearer' })
      .set('x-request-id', logoutId)
      .expect(204);
    expect((await records(logoutId))[0]).toMatchObject({
      action: 'AUTH_LOGOUT',
      outcome: 'SUCCESS',
      actorStaffId: coordinator.id,
      resourceId: loggedIn[0].resourceId,
      statusCode: 204,
    });
    const failedId = randomUUID();
    await http()
      .post('/api/v1/auth/login')
      .set('x-request-id', failedId)
      .send({ username: 'coordinator', password: 'wrong' })
      .expect(401);
    expect(await records(failedId)).toHaveLength(0);
    expect(
      JSON.stringify([...loggedIn, ...(await records(logoutId))]),
    ).not.toContain(session.accessToken);
  });
  it('rolls back successful credential login when audit is unavailable', async () => {
    const sessions = database.getRepository<StaffSession>('StaffSession');
    const count = await sessions.count();
    await database.query(
      "ALTER TABLE audit_logs ADD CONSTRAINT test_login_audit CHECK (request_id <> 'audit-test-login-fail')",
    );
    try {
      await login('coordinator', 'audit-test-login-fail').expect(503);
      expect(await sessions.count()).toBe(count);
    } finally {
      await database.query(
        'ALTER TABLE audit_logs DROP CONSTRAINT test_login_audit',
      );
    }
  });
  it('sanitizes sensitive nested metadata before persistence', async () => {
    const target = randomUUID();
    await app.get(AuditService).record({
      action: AuditAction.STAFF_UPDATE,
      outcome: AuditOutcome.SUCCESS,
      resourceId: target,
      metadata: {
        safe: true,
        password: 'private',
        passwordHash: 'private',
        nested: {
          refresh_token: 'private',
          JWT_ACCESS_SECRET: 'private',
          DB_PASSWORD: 'private',
          safe: 1,
        },
        values: [
          {
            Authorization: 'private',
            cookie: 'private',
            accessToken: 'private',
            safe: 2,
          },
        ],
      },
    });
    const entry = await entries().findOneByOrFail({ resourceId: target });
    expect(entry.metadata).toEqual({
      safe: true,
      nested: { safe: 1 },
      values: [{ safe: 2 }],
    });
    expect(JSON.stringify(entry)).not.toContain('private');
  });
  it.each([
    RoleName.COORDINATOR,
    RoleName.GENERAL_CHIEF,
    RoleName.ADMIN,
    RoleName.MODERATOR,
  ])('allows AUDIT_READ for %s on both endpoints', async (role) => {
    const { body: staff } = await create(role).expect(201);
    const { body: session } = await login(staff.username).expect(200);
    const response = await list({ limit: 1 }, session.accessToken).expect(200);
    await http()
      .get(`/api/v1/audit/${response.body.items[0].id}`)
      .auth(session.accessToken, { type: 'bearer' })
      .expect(200);
    if (role === RoleName.COORDINATOR)
      await http()
        .patch(`/api/v1/staff/${staff.id}/role`)
        .auth(coordinator.accessToken, { type: 'bearer' })
        .send({ role: 'SUPPORT' })
        .expect(200);
  });
  it.each([RoleName.SUPPORT, RoleName.DEV])(
    'denies %s without generating audit noise',
    async (role) => {
      const { body: staff } = await create(role).expect(201);
      const { body: session } = await login(staff.username).expect(200);
      const requestId: string = randomUUID();
      await list({}, session.accessToken)
        .set('x-request-id', requestId)
        .expect(403);
      await http()
        .get(`/api/v1/audit/${randomUUID()}`)
        .auth(session.accessToken, { type: 'bearer' })
        .expect(403);
      await http()
        .patch(`/api/v1/staff/${coordinator.id}/status`)
        .auth(session.accessToken, { type: 'bearer' })
        .set('x-request-id', requestId)
        .send({ status: 'DISABLED' })
        .expect(403);
      expect(await records(requestId)).toHaveLength(0);
    },
  );
  it('rejects anonymous queries and validates audit IDs', async () => {
    await http().get('/api/v1/audit').expect(401);
    await http().get(`/api/v1/audit/${randomUUID()}`).expect(401);
    await http()
      .get('/api/v1/audit/invalid')
      .auth(coordinator.accessToken, { type: 'bearer' })
      .expect(400);
    await http()
      .get(`/api/v1/audit/${randomUUID()}`)
      .auth(coordinator.accessToken, { type: 'bearer' })
      .expect(404);
  });
  it('filters, paginates and sorts without mutating records', async () => {
    const group = randomUUID();
    const actor = await database
      .getRepository<StaffUser>('StaffUser')
      .findOneByOrFail({ id: coordinator.id });
    const context = app.get(RequestContext);
    const audit = app.get(AuditService);
    const resourceId = randomUUID();
    const from = new Date(Date.now() - 10000).toISOString();
    for (let i = 0; i < 5; i++)
      await new Promise<void>((resolve, reject) =>
        context.run(group, () => {
          void audit
            .record({
              actor,
              action: AuditAction.STAFF_UPDATE,
              outcome: i % 2 ? AuditOutcome.FAILURE : AuditOutcome.SUCCESS,
              resourceType: AuditResource.STAFF_USER,
              resourceId,
            })
            .then(resolve, reject);
        }),
      );
    const to = new Date(Date.now() + 10000).toISOString();
    const all = await list({ requestId: group, limit: 100 }).expect(200);
    expect(all.body.total).toBe(5);
    const page1 = await list({ requestId: group, limit: 2, page: 1 }).expect(
      200,
    );
    const page2 = await list({ requestId: group, limit: 2, page: 2 }).expect(
      200,
    );
    const page3 = await list({ requestId: group, limit: 2, page: 3 }).expect(
      200,
    );
    expect(page1.body).toMatchObject({
      total: 5,
      page: 1,
      limit: 2,
      totalPages: 3,
    });
    const combined: AuditLog[] = [
      ...page1.body.items,
      ...page2.body.items,
      ...page3.body.items,
    ];
    expect(combined.map((item) => item.id)).toEqual(
      all.body.items.map((item: AuditLog) => item.id),
    );
    expect(new Set(combined.map((item) => item.id)).size).toBe(5);
    expect(combined.map((item) => item.createdAt)).toEqual(
      combined
        .map((item) => item.createdAt)
        .sort()
        .reverse(),
    );
    const filtered = await list({
      requestId: group,
      actorStaffId: coordinator.id,
      action: 'STAFF_UPDATE',
      outcome: 'SUCCESS',
      resourceType: 'STAFF_USER',
      resourceId,
      from,
      to,
    }).expect(200);
    expect(filtered.body.total).toBe(3);
    expect(
      (await list({ requestId: group, actorStaffId: randomUUID() }).expect(200))
        .body.total,
    ).toBe(0);
    expect(
      (await list({ requestId: group, from: to }).expect(200)).body.total,
    ).toBe(0);
    expect(
      (await list({ requestId: group, to: from }).expect(200)).body.total,
    ).toBe(0);
    const single = await http()
      .get(`/api/v1/audit/${combined[0].id}`)
      .auth(coordinator.accessToken, { type: 'bearer' })
      .expect(200);
    expect(single.body).toEqual(combined[0]);
  });
  it.each([
    { limit: 101 },
    { limit: 0 },
    { page: -1 },
    { page: 'abc' },
    { actorStaffId: 'invalid' },
    { action: 'ARBITRARY' },
    { outcome: 'INVALID' },
    { from: 'yesterday' },
    { from: '2026-09-20T00:00:00Z', to: '2026-09-19T00:00:00Z' },
    { order: 'actorStaffId' },
  ])('validates query %j', async (query) => {
    await list(query).expect(400);
  });
  it('isolates concurrent actor/request contexts and records exactly once per mutation', async () => {
    const { body: secondActor } = await create(RoleName.COORDINATOR).expect(
      201,
    );
    const { body: secondSession } = await login(secondActor.username).expect(
      200,
    );
    const cases = Array.from({ length: 8 }, (_, index) => ({
      requestId: randomUUID(),
      token: index % 2 ? secondSession.accessToken : coordinator.accessToken,
      actorId: index % 2 ? secondActor.id : coordinator.id,
      actorUsername: index % 2 ? secondActor.username : 'coordinator',
      userAgent: `concurrent-${index}`,
    }));
    const targets = await Promise.all(cases.map(() => create().expect(201)));
    await Promise.all(
      cases.map((item, index) =>
        http()
          .patch(`/api/v1/staff/${targets[index].body.id}`)
          .auth(item.token, { type: 'bearer' })
          .set('x-request-id', item.requestId)
          .set('User-Agent', item.userAgent)
          .send({ displayName: `Concurrent ${index}` })
          .expect(200),
      ),
    );
    for (const [index, item] of cases.entries()) {
      const logs = await records(item.requestId);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        actorStaffId: item.actorId,
        actorUsername: item.actorUsername,
        requestId: item.requestId,
        userAgent: item.userAgent,
        resourceId: targets[index].body.id,
        outcome: 'SUCCESS',
      });
    }
  });
  it('exposes only read routes and documents filters, pagination and responses', async () => {
    for (const path of ['/api/v1/audit', `/api/v1/audit/${randomUUID()}`]) {
      await http()
        .post(path)
        .auth(coordinator.accessToken, { type: 'bearer' })
        .send({})
        .expect(404);
      await http()
        .patch(path)
        .auth(coordinator.accessToken, { type: 'bearer' })
        .send({})
        .expect(404);
      await http()
        .put(path)
        .auth(coordinator.accessToken, { type: 'bearer' })
        .send({})
        .expect(404);
      await http()
        .delete(path)
        .auth(coordinator.accessToken, { type: 'bearer' })
        .expect(404);
    }
    const { body } = await http().get('/docs-json').expect(200);
    expect(Object.keys(body.paths['/api/v1/audit'])).toEqual(['get']);
    expect(Object.keys(body.paths['/api/v1/audit/{id}'])).toEqual(['get']);
    expect(body.paths['/api/v1/audit'].get.security).toEqual([{ bearer: [] }]);
    expect(
      body.paths['/api/v1/audit'].get.parameters
        .map((param: { name: string }) => param.name)
        .sort(),
    ).toEqual(
      [
        'page',
        'limit',
        'actorStaffId',
        'action',
        'outcome',
        'resourceType',
        'resourceId',
        'requestId',
        'from',
        'to',
      ].sort(),
    );
    expect(body.components.schemas.AuditPageDto.properties).toHaveProperty(
      'items',
    );
    expect(body.components.schemas.AuditLogDto.properties).not.toHaveProperty(
      'updatedAt',
    );
  });
});
