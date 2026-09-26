import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { DataSourceOptions } from 'typeorm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { compiledDatabaseArtifacts } from './compiled-database.js';
import { loadEnvironment } from '../src/config/environment.js';
import { createDatabaseOptions } from '../src/database/database.options.js';
import { setupApp } from '../src/setup-app.js';
import { AppExpressAdapter } from '../src/common/http/app-express.adapter.js';
import { LifecycleService } from '../src/lifecycle/lifecycle.service.js';
import { runMigrations } from '../src/ops/migration-runner.js';
import { databaseFindings } from '../src/ops/preflight.checks.js';

// Probes and schema readiness (12.2), without the single-instance lock.
const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;

describeDatabase('Deployment probes and migration readiness (12.2)', () => {
  let admin: DataSource, database: DataSource, app: INestApplication<App>;
  let overrides: Partial<DataSourceOptions>;
  const schema = `deploy_ready_test_${randomUUID().replaceAll('-', '')}`;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const options = createDatabaseOptions(loadEnvironment());
    if (options.type !== 'postgres') throw new Error('PostgreSQL required');
    admin = new DataSource(options);
    await admin.initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    overrides = {
      schema,
      ...(await compiledDatabaseArtifacts()),
      extra: { options: `-c search_path=${schema},public` },
    } as Partial<DataSourceOptions>;
    database = new DataSource({
      ...options,
      ...overrides,
      extra: { ...options.extra, options: `-c search_path=${schema},public` },
    } as DataSourceOptions);
    await database.initialize();
    // A schema one migration behind this build.
    expect(await database.runMigrations()).toHaveLength(26);
    await database.undoLastMigration();
    const { AppModule } = await import('../src/app.module.js');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DataSource)
      .useValue(database)
      .compile();
    app = module.createNestApplication(new AppExpressAdapter());
    app.useLogger(false);
    setupApp(app);
    await app.listen(0, '127.0.0.1');
  }, 60000);
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await app?.close();
    if (database?.isInitialized) await database.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  it('answers liveness without touching the database', async () => {
    const query = jest.spyOn(database, 'query');
    const live = await http().get('/api/v1/live').expect(200);
    expect(live.body).toEqual({ status: 'live' });
    expect(live.headers['cache-control']).toBe('no-store');
    expect(query).not.toHaveBeenCalled();
  });

  it('is not ready with a pending migration, until the runner applies it', async () => {
    const pending = await http().get('/api/v1/ready').expect(503);
    expect(pending.body).toEqual({
      status: 'not_ready',
      checks: {
        bootstrapped: true,
        shuttingDown: false,
        singleInstanceLock: true,
        database: true,
        migrations: false,
        extensions: true,
      },
    });
    expect(JSON.stringify(pending.body).length).toBeLessThan(256);
    // The preflight sees the same thing; /ready itself never migrates.
    const config = loadEnvironment();
    const before = await databaseFindings(
      config,
      { requireCurrent: true },
      overrides,
    );
    expect(before.find((f) => f.check === 'migrations')).toMatchObject({
      level: 'ERROR',
      detail: expect.stringContaining('1 pending'),
    });
    await http().get('/api/v1/ready').expect(503);
    expect(
      (
        await database.query(
          "SELECT count(*)::int AS n FROM migrations WHERE name = 'OperationalRecovery1790050000000'",
        )
      )[0].n,
    ).toBe(0);
    // The runner (with its own timeouts and the instance lock) applies it.
    expect(await runMigrations(config, overrides)).toEqual([
      'OperationalRecovery1790050000000',
    ]);
    expect(await http().get('/api/v1/ready').expect(200)).toMatchObject({
      body: { status: 'ready' },
    });
    const after = await databaseFindings(
      config,
      { requireCurrent: true },
      overrides,
    );
    expect(after.filter((f) => f.level === 'ERROR')).toEqual([]);
    expect(after.find((f) => f.check === 'migrations')?.detail).toContain(
      '0 pending',
    );
    expect(after.find((f) => f.check === 'extension_uuid_ossp')?.level).toBe(
      'OK',
    );
    expect(await runMigrations(config, overrides)).toEqual([]);
  });

  it('is not ready when the database fails, and keeps /health as the legacy database ping', async () => {
    await http().get('/api/v1/health').expect(200);
    jest.spyOn(database, 'query').mockRejectedValue(new Error('down'));
    const down = await http().get('/api/v1/ready').expect(503);
    expect(down.body.checks).toMatchObject({ database: false });
    expect(JSON.stringify(down.body)).not.toMatch(
      /"down"|password|host|error|stack/i,
    );
    await http().get('/api/v1/health').expect(503);
    await http().get('/api/v1/live').expect(200);
  });

  it('stops being ready as soon as shutdown begins, before anything closes', async () => {
    await http().get('/api/v1/ready').expect(200);
    app.get(LifecycleService).beginShutdown();
    const draining = await http().get('/api/v1/ready').expect(503);
    expect(draining.body.checks).toMatchObject({ shuttingDown: true });
    await http().get('/api/v1/live').expect(200);
  });
});
