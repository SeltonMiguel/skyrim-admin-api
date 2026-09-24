import { AuditService } from '../src/audit/audit.service.js';
import { RequestContext } from '../src/common/request-context/request-context.service.js';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { jest } from '@jest/globals';
import { decodeJwt } from 'jose';
import type { ApplicationConfig } from '../src/config/environment.js';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { compiledDatabaseArtifacts } from './compiled-database.js';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { setupApp } from '../src/setup-app.js';
import { AppExpressAdapter } from '../src/common/http/app-express.adapter.js';
import { loadEnvironment } from '../src/config/environment.js';
import { createDatabaseOptions } from '../src/database/database.options.js';
import { BootstrapCoordinatorService } from '../src/staff/bootstrap-coordinator.service.js';
import { PasswordService } from '../src/auth/password.service.js';
import { ROLE_PERMISSIONS } from '../src/rbac/role-permissions.js';
import { RoleName } from '../src/rbac/roles.js';
import { Permission } from '../src/rbac/permissions.js';
import { StaffUser } from '../src/staff/entities/staff-user.entity.js';
import { StaffSession } from '../src/auth/entities/staff-session.entity.js';
import { StaffService } from '../src/staff/staff.service.js';

const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;

describeDatabase('Auth + RBAC with real PostgreSQL', () => {
  let app: INestApplication<App>;
  let admin: DataSource;
  let database: DataSource;
  let coordinator: { id: string; accessToken: string; refreshToken: string };
  let bootstrapResults: string[];
  const schema = `auth_test_${randomUUID().replaceAll('-', '')}`;
  const password = 'test-admin-password-123';
  const credentials = {
    username: ' Coordinator ',
    displayName: 'Coordinator',
    password,
  };
  const http = () => request(app.getHttpServer());
  const login = (username: string, suppliedPassword = password) =>
    http()
      .post('/api/v1/auth/login')
      .send({ username, password: suppliedPassword });
  const create = (role: RoleName = RoleName.SUPPORT) =>
    http()
      .post('/api/v1/staff')
      .auth(coordinator.accessToken, { type: 'bearer' })
      .send({
        username: `staff-${randomUUID()}`,
        displayName: 'Staff',
        password,
        role,
      });
  const refresh = (refreshToken: string) =>
    http().post('/api/v1/auth/refresh').send({ refreshToken });

  beforeAll(async () => {
    const options = createDatabaseOptions(loadEnvironment());
    if (options.type !== 'postgres') throw new Error('PostgreSQL required');
    admin = new DataSource(options);
    await admin.initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    database = new DataSource({
      ...options,
      type: 'postgres',
      schema,
      ...(await compiledDatabaseArtifacts()),
      extra: { ...options.extra, options: `-c search_path=${schema},public` },
    });
    await database.initialize();
    // Exercise migration, rollback, reproducibility and no-op rerun in an isolated schema.
    expect(await database.runMigrations()).toHaveLength(16);
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
    await database.undoLastMigration();
    expect(
      await database.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename = 'staff_users'`,
        [schema],
      ),
    ).toHaveLength(0);
    expect(await database.runMigrations()).toHaveLength(16);
    expect(await database.runMigrations()).toHaveLength(0);
    const bootstrap = new BootstrapCoordinatorService(
      database,
      new PasswordService(),
      new AuditService(database, new RequestContext()),
    );
    await expect(
      bootstrap.run({ ...credentials, password: 'short' }),
    ).rejects.toThrow('BOOTSTRAP_COORDINATOR');
    bootstrapResults = await Promise.all([
      bootstrap.run(credentials),
      bootstrap.run(credentials),
    ]);
    const { AppModule } = await import('../src/app.module.js');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DataSource)
      .useValue(database)
      .compile();
    app = module.createNestApplication(new AppExpressAdapter());
    app.useLogger(false);
    setupApp(app);
    await app.listen(0, '127.0.0.1');
    const response = await login('coordinator').expect(200);
    coordinator = { id: response.body.staff.id, ...response.body };
  }, 30000);

  afterAll(async () => {
    await app?.close();
    if (database?.isInitialized) await database.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  it('executes migrations and records them without synchronize', async () => {
    expect(database.options.synchronize).toBe(false);
    expect(await database.showMigrations()).toBe(false);
    expect(
      (await database.driver.createSchemaBuilder().log()).upQueries,
    ).toEqual([]);
    expect(
      await database.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = $1`,
        [schema],
      ),
    ).toHaveLength(26);
  });
  it('seeds the six roles and complete permission catalog', async () => {
    const roles: { name: string }[] = await database.query(
      'SELECT name FROM roles',
    );
    const permissions: { name: string }[] = await database.query(
      'SELECT name FROM permissions',
    );
    expect(roles.map((role) => role.name).sort()).toEqual(
      Object.values(RoleName).sort(),
    );
    expect(permissions.map((permission) => permission.name).sort()).toEqual(
      Object.values(Permission).sort(),
    );
  });
  it.each(Object.values(RoleName))(
    'persists the exact grants for %s',
    async (role) => {
      const rows: { permission_name: Permission }[] = await database.query(
        'SELECT permission_name FROM role_permissions WHERE role_name = $1',
        [role],
      );
      expect(rows.map((row) => row.permission_name).sort()).toEqual(
        [...ROLE_PERMISSIONS[role]].sort(),
      );
    },
  );
  it('bootstraps once even concurrently and never changes an existing coordinator', async () => {
    expect(bootstrapResults.sort()).toEqual(['already-exists', 'created']);
    const bootstrap = app.get(BootstrapCoordinatorService);
    expect(await bootstrap.run({})).toBe('already-exists');
    expect(
      await database
        .getRepository<StaffUser>('StaffUser')
        .countBy({ roleName: RoleName.COORDINATOR }),
    ).toBe(1);
  });
  it('logs in with normalized username and returns only public staff information', async () => {
    const result = await login(' COORDINATOR ').expect(200);
    expect(result.body).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      expiresIn: 900,
      staff: {
        username: 'coordinator',
        role: 'COORDINATOR',
        lastLoginAt: expect.any(String),
      },
    });
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.text).not.toMatch(
      /passwordHash|refreshTokenHash|password_hash|refresh_token_hash/,
    );
    const sessions: { refresh_token_hash: string }[] = await database.query(
      'SELECT refresh_token_hash FROM staff_sessions',
    );
    expect(
      sessions.every((session) =>
        /^[0-9a-f]{64}$/.test(session.refresh_token_hash),
      ),
    ).toBe(true);
    const [staff]: { password_hash: string }[] = await database.query(
      'SELECT password_hash FROM staff_users WHERE id = $1',
      [coordinator.id],
    );
    expect(staff.password_hash).toMatch(/^\$argon2id\$/);
  });
  it('returns generic invalid-credential responses for missing user and wrong password', async () => {
    const missing = await login('missing-staff').expect(401);
    const wrong = await login('coordinator', 'wrong').expect(401);
    expect(missing.body.message).toBe('Invalid credentials');
    expect(wrong.body.message).toBe(missing.body.message);
  });
  it('serves me with current permissions', async () => {
    const response = await http()
      .get('/api/v1/auth/me')
      .auth(coordinator.accessToken, { type: 'bearer' })
      .expect(200);
    expect(response.body.id).toBe(coordinator.id);
    expect(response.body.permissions.sort()).toEqual(
      Object.values(Permission).sort(),
    );
  });
  it('rejects me without a token, with garbage, or with a refresh token', async () => {
    await http().get('/api/v1/auth/me').expect(401);
    await http()
      .get('/api/v1/auth/me')
      .auth('invalid', { type: 'bearer' })
      .expect(401);
    await http()
      .get('/api/v1/auth/me')
      .auth(coordinator.refreshToken, { type: 'bearer' })
      .expect(401);
    await refresh(coordinator.accessToken).expect(401);
  });
  it('rotates refresh and rejects reuse while preserving the new token', async () => {
    const { body } = await login('coordinator').expect(200);
    const rotated = await refresh(body.refreshToken).expect(200);
    expect(rotated.body.refreshToken).not.toBe(body.refreshToken);
    expect(rotated.body.accessToken).not.toBe(body.accessToken);
    await refresh(body.refreshToken).expect(401);
    await refresh(rotated.body.refreshToken).expect(200);
  });
  it('sets the absolute session expiry at login using JWT_REFRESH_TTL', async () => {
    const { body } = await login('coordinator').expect(200);
    const claims = decodeJwt(body.refreshToken);
    const session = await database
      .getRepository<StaffSession>('StaffSession')
      .findOneByOrFail({ id: claims.sid as string });
    const ttl = app
      .get(ConfigService)
      .getOrThrow<ApplicationConfig>('application').jwt.refreshTtl;
    expect(claims.exp! - claims.iat!).toBe(ttl);
    expect(session.expiresAt.getTime()).toBe((claims.iat! + ttl) * 1000);
    expect(body.refreshExpiresAt).toBe(session.expiresAt.toISOString());
  });
  it('preserves the database expiry and bounds JWT expiry across multiple refreshes', async () => {
    const { body } = await login('coordinator').expect(200);
    const claims = decodeJwt(body.refreshToken);
    const sessions = database.getRepository<StaffSession>('StaffSession');
    const original = await sessions.findOneByOrFail({
      id: claims.sid as string,
    });
    const expiresAt = original.expiresAt.getTime();
    const issuedAt = claims.iat! * 1000;
    // Advance application time only; PostgreSQL and HTTP timers keep running.
    const clock = jest.spyOn(Date, 'now');
    try {
      let token = body.refreshToken as string;
      for (const fraction of [0.25, 0.5, 0.75]) {
        clock.mockReturnValue(
          issuedAt + Math.floor((expiresAt - issuedAt) * fraction),
        );
        const rotated = await refresh(token).expect(200);
        expect(rotated.body.refreshToken).not.toBe(token);
        expect(decodeJwt(rotated.body.refreshToken).exp! * 1000).toBe(
          expiresAt,
        );
        expect(rotated.body.refreshExpiresAt).toBe(
          original.expiresAt.toISOString(),
        );
        const stored = await sessions.findOneByOrFail({ id: original.id });
        expect(stored.expiresAt.getTime()).toBe(expiresAt);
        expect(stored.lastUsedAt).toBeInstanceOf(Date);
        await refresh(token).expect(401);
        token = rotated.body.refreshToken;
      }
      await refresh(token).expect(200);
    } finally {
      clock.mockRestore();
    }
  });
  it('rejects the expired session and gives a new login its own session and deadline', async () => {
    const { body } = await login('coordinator').expect(200);
    const claims = decodeJwt(body.refreshToken);
    const sessions = database.getRepository<StaffSession>('StaffSession');
    const original = await sessions.findOneByOrFail({
      id: claims.sid as string,
    });
    const clock = jest
      .spyOn(Date, 'now')
      .mockReturnValue(original.expiresAt.getTime());
    try {
      await refresh(body.refreshToken).expect(401);
      await http()
        .get('/api/v1/auth/me')
        .auth(body.accessToken, { type: 'bearer' })
        .expect(401);
      clock.mockReturnValue(original.expiresAt.getTime() + 1000);
      const fresh = await login('coordinator').expect(200);
      const freshClaims = decodeJwt(fresh.body.refreshToken);
      expect(freshClaims.sid).not.toBe(claims.sid);
      const session = await sessions.findOneByOrFail({
        id: freshClaims.sid as string,
      });
      const ttl = app
        .get(ConfigService)
        .getOrThrow<ApplicationConfig>('application').jwt.refreshTtl;
      expect(session.expiresAt.getTime()).toBe(
        original.expiresAt.getTime() + 1000 + ttl * 1000,
      );
      expect(
        (await sessions.findOneByOrFail({ id: original.id })).expiresAt,
      ).toEqual(original.expiresAt);
      await http()
        .get('/api/v1/auth/me')
        .auth(fresh.body.accessToken, { type: 'bearer' })
        .expect(200);
    } finally {
      clock.mockRestore();
    }
  });
  it('allows exactly one concurrent use of a refresh token', async () => {
    const { body } = await login('coordinator').expect(200);
    const responses = await Promise.all([
      refresh(body.refreshToken),
      refresh(body.refreshToken),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 401,
    ]);
    await refresh(
      responses.find((response) => response.status === 200)!.body.refreshToken,
    ).expect(200);
  });
  it('logout invalidates access and refresh for only the current session', async () => {
    const { body } = await login('coordinator').expect(200);
    await http()
      .post('/api/v1/auth/logout')
      .auth(body.accessToken, { type: 'bearer' })
      .expect(204);
    await refresh(body.refreshToken).expect(401);
    await http()
      .get('/api/v1/auth/me')
      .auth(body.accessToken, { type: 'bearer' })
      .expect(401);
    await http()
      .get('/api/v1/auth/me')
      .auth(coordinator.accessToken, { type: 'bearer' })
      .expect(200);
  });
  it('rejects expired sessions even with a cryptographically valid token', async () => {
    const created = await create().expect(201);
    const { body } = await login(created.body.username).expect(200);
    await database
      .getRepository<StaffSession>('StaffSession')
      .update({ staffUserId: created.body.id }, { expiresAt: new Date(0) });
    await refresh(body.refreshToken).expect(401);
    await http()
      .get('/api/v1/auth/me')
      .auth(body.accessToken, { type: 'bearer' })
      .expect(401);
  });
  it.each([
    RoleName.SUPPORT,
    RoleName.DEV,
    RoleName.GENERAL_CHIEF,
    RoleName.ADMIN,
    RoleName.MODERATOR,
  ])('denies staff management for %s', async (role) => {
    const created = await create(role).expect(201);
    const { body } = await login(created.body.username).expect(200);
    const endpoints = [
      http().get('/api/v1/staff'),
      http().get(`/api/v1/staff/${coordinator.id}`),
      http().post('/api/v1/staff').send({}),
      http().patch(`/api/v1/staff/${coordinator.id}`).send({}),
      http()
        .patch(`/api/v1/staff/${coordinator.id}/role`)
        .send({ role: 'SUPPORT' }),
      http()
        .patch(`/api/v1/staff/${coordinator.id}/status`)
        .send({ status: 'DISABLED' }),
    ];
    for (const endpoint of endpoints)
      await endpoint.auth(body.accessToken, { type: 'bearer' }).expect(403);
  });
  it('protects all staff endpoints from unauthenticated callers', async () => {
    await http().get('/api/v1/staff').expect(401);
    await http().get(`/api/v1/staff/${coordinator.id}`).expect(401);
    await http().post('/api/v1/staff').send({}).expect(401);
    for (const suffix of ['', '/role', '/status'])
      await http()
        .patch(`/api/v1/staff/${coordinator.id}${suffix}`)
        .send({})
        .expect(401);
  });
  it('allows Coordinator to create, list, read and update a normalized staff profile', async () => {
    const username = `user-${randomUUID()}`;
    const created = await http()
      .post('/api/v1/staff')
      .auth(coordinator.accessToken, { type: 'bearer' })
      .send({
        username: ` ${username.toUpperCase()} `,
        displayName: 'Staff',
        password,
        role: 'SUPPORT',
      })
      .expect(201);
    expect(created.body.username).toBe(username);
    expect(created.text).not.toContain('Hash');
    const read = await http()
      .get(`/api/v1/staff/${created.body.id}`)
      .auth(coordinator.accessToken, { type: 'bearer' })
      .expect(200);
    expect(read.body).toEqual(created.body);
    const list = await http()
      .get('/api/v1/staff')
      .auth(coordinator.accessToken, { type: 'bearer' })
      .expect(200);
    expect(
      list.body.some((staff: { id: string }) => staff.id === created.body.id),
    ).toBe(true);
    await http()
      .patch(`/api/v1/staff/${created.body.id}`)
      .auth(coordinator.accessToken, { type: 'bearer' })
      .send({ displayName: 'Renamed' })
      .expect(200)
      .expect(({ body }) => expect(body.displayName).toBe('Renamed'));
    await http()
      .post('/api/v1/staff')
      .auth(coordinator.accessToken, { type: 'bearer' })
      .send({
        username: username.toUpperCase(),
        displayName: 'Duplicate',
        password,
        role: 'SUPPORT',
      })
      .expect(409);
  });
  it('applies role changes to already issued tokens immediately', async () => {
    const created = await create().expect(201);
    const { body } = await login(created.body.username).expect(200);
    await http()
      .get('/api/v1/staff')
      .auth(body.accessToken, { type: 'bearer' })
      .expect(403);
    await http()
      .patch(`/api/v1/staff/${created.body.id}/role`)
      .auth(coordinator.accessToken, { type: 'bearer' })
      .send({ role: 'COORDINATOR' })
      .expect(200);
    await http()
      .get('/api/v1/staff')
      .auth(body.accessToken, { type: 'bearer' })
      .expect(200);
    await http()
      .patch(`/api/v1/staff/${created.body.id}/role`)
      .auth(coordinator.accessToken, { type: 'bearer' })
      .send({ role: 'SUPPORT' })
      .expect(200);
    await http()
      .get('/api/v1/staff')
      .auth(body.accessToken, { type: 'bearer' })
      .expect(403);
  });
  it('reads changed database grants without trusting cached or JWT permissions', async () => {
    const created = await create().expect(201);
    const { body } = await login(created.body.username).expect(200);
    await database.query(
      "DELETE FROM role_permissions WHERE role_name = 'SUPPORT'",
    );
    try {
      const response = await http()
        .get('/api/v1/auth/me')
        .auth(body.accessToken, { type: 'bearer' })
        .expect(200);
      expect(response.body.permissions).toEqual([]);
    } finally {
      await database.query(
        "INSERT INTO role_permissions VALUES ('SUPPORT', 'PLAYER_TELEPORT_TO_STAFF'), ('SUPPORT', 'DASHBOARD_READ'), ('SUPPORT', 'GAME_BRIDGE_READ')",
      );
    }
  });
  it('disables staff, revokes every session and does not revive tokens on reactivation', async () => {
    const created = await create().expect(201);
    const { body: first } = await login(created.body.username).expect(200);
    const { body: second } = await login(created.body.username).expect(200);
    const endpoint = `/api/v1/staff/${created.body.id}/status`;
    await http()
      .patch(endpoint)
      .auth(coordinator.accessToken, { type: 'bearer' })
      .send({ status: 'DISABLED' })
      .expect(200);
    await login(created.body.username).expect(401);
    for (const pair of [first, second]) {
      await refresh(pair.refreshToken).expect(401);
      await http()
        .get('/api/v1/auth/me')
        .auth(pair.accessToken, { type: 'bearer' })
        .expect(401);
    }
    await http()
      .patch(endpoint)
      .auth(coordinator.accessToken, { type: 'bearer' })
      .send({ status: 'ACTIVE' })
      .expect(200);
    await refresh(first.refreshToken).expect(401);
    await login(created.body.username).expect(200);
  });
  it('refuses removing the last active coordinator', async () => {
    await http()
      .patch(`/api/v1/staff/${coordinator.id}/status`)
      .auth(coordinator.accessToken, { type: 'bearer' })
      .send({ status: 'DISABLED' })
      .expect(409);
    await http()
      .patch(`/api/v1/staff/${coordinator.id}/role`)
      .auth(coordinator.accessToken, { type: 'bearer' })
      .send({ role: 'SUPPORT' })
      .expect(409);
  });
  it('serializes concurrent changes so the last active coordinator survives', async () => {
    const created = await create(RoleName.COORDINATOR).expect(201);
    const service = app.get(StaffService);
    const actor = await database
      .getRepository<StaffUser>('StaffUser')
      .findOneByOrFail({ id: coordinator.id });
    const results = await Promise.allSettled([
      service.updateRole(coordinator.id, RoleName.SUPPORT, actor),
      service.updateRole(created.body.id, RoleName.SUPPORT, actor),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(
      await database.getRepository<StaffUser>('StaffUser').countBy({
        roleName: RoleName.COORDINATOR,
        status: 'ACTIVE' as StaffUser['status'],
      }),
    ).toBe(1);
    await service.updateRole(coordinator.id, RoleName.COORDINATOR, actor);
    await service.updateRole(created.body.id, RoleName.SUPPORT, actor);
  });
  it('validates UUIDs, role/status values and rejects mass assignment and weak passwords', async () => {
    await http()
      .get('/api/v1/staff/invalid')
      .auth(coordinator.accessToken, { type: 'bearer' })
      .expect(400);
    await http()
      .get(`/api/v1/staff/${randomUUID()}`)
      .auth(coordinator.accessToken, { type: 'bearer' })
      .expect(404);
    const base = {
      username: 'valid-staff',
      displayName: 'Staff',
      password,
      role: 'SUPPORT',
    };
    for (const extra of [
      { password: 'short' },
      { password: ' '.repeat(12) },
      { passwordHash: 'injected' },
      { role: 'SUPERADMIN' },
      { status: 'ACTIVE' },
      { username: 'bad name' },
    ])
      await http()
        .post('/api/v1/staff')
        .auth(coordinator.accessToken, { type: 'bearer' })
        .send({ ...base, ...extra })
        .expect(400);
    await http()
      .patch(`/api/v1/staff/${coordinator.id}`)
      .auth(coordinator.accessToken, { type: 'bearer' })
      .send({ role: 'SUPPORT' })
      .expect(400);
    await http()
      .patch(`/api/v1/staff/${coordinator.id}`)
      .auth(coordinator.accessToken, { type: 'bearer' })
      .send({ displayName: null })
      .expect(400);
    await http()
      .patch(`/api/v1/staff/${coordinator.id}/role`)
      .auth(coordinator.accessToken, { type: 'bearer' })
      .send({ role: 'ARBITRARY' })
      .expect(400);
    await http()
      .patch(`/api/v1/staff/${coordinator.id}/status`)
      .auth(coordinator.accessToken, { type: 'bearer' })
      .send({ status: 'UNKNOWN' })
      .expect(400);
  });
  it('documents every endpoint and bearer auth without hash schemas', async () => {
    const { body, text } = await http().get('/docs-json').expect(200);
    expect(body.components.securitySchemes.bearer).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    for (const path of [
      '/auth/login',
      '/auth/refresh',
      '/auth/logout',
      '/auth/me',
      '/staff',
      '/staff/{id}',
      '/staff/{id}/role',
      '/staff/{id}/status',
    ])
      expect(body.paths).toHaveProperty(`/api/v1${path}`);
    expect(body.paths['/api/v1/staff'].get.security).toEqual([{ bearer: [] }]);
    expect(
      body.components.schemas.CreateStaffDto.properties.password.writeOnly,
    ).toBe(true);
    expect(text).not.toMatch(/passwordHash|refreshTokenHash/);
  });
});
