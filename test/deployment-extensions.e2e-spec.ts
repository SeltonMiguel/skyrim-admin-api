import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { DataSourceOptions } from 'typeorm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { compiledDatabaseArtifacts } from './compiled-database.js';
import { loadEnvironment } from '../src/config/environment.js';
import { createDatabaseOptions } from '../src/database/database.options.js';
import { schemaStatus } from '../src/database/schema-status.js';
import { setupApp } from '../src/setup-app.js';
import { AppExpressAdapter } from '../src/common/http/app-express.adapter.js';
import {
  ensureExtensions,
  MigrationPrerequisiteError,
  runMigrations,
} from '../src/ops/migration-runner.js';
import { databaseFindings } from '../src/ops/preflight.checks.js';

// Runtime = schema read/use only; migration runner = schema mutation (12.2).
// Extensions are per database, so this suite uses a brand-new database
// (template1 has no uuid-ossp), dropped at the end.
const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;

describeDatabase(
  'uuid-ossp is created by the migration runner only (12.2)',
  () => {
    let admin: DataSource, database: DataSource, app: INestApplication<App>;
    let options: DataSourceOptions, overrides: Partial<DataSourceOptions>;
    const name = `skyrim_ext_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const role = `${name}_noext`;
    const http = () => request(app.getHttpServer());
    const installed = async () =>
      (
        await admin.query(
          `SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'uuid-ossp'`,
        )
      )[0].n as number;
    let fresh: DataSource;

    beforeAll(async () => {
      options = createDatabaseOptions(loadEnvironment());
      if (options.type !== 'postgres') throw new Error('PostgreSQL required');
      const server = new DataSource(options);
      await server.initialize();
      await server.query(`CREATE DATABASE "${name}"`);
      await server.destroy();
      overrides = {
        database: name,
        ...(await compiledDatabaseArtifacts()),
      } as Partial<DataSourceOptions>;
      // Inspection connection to the new database.
      fresh = new DataSource({
        ...options,
        database: name,
      } as DataSourceOptions);
      await fresh.initialize();
      admin = fresh;
      expect(await installed()).toBe(0);
      // A: the application runtime connects to the empty database.
      database = new DataSource({
        ...options,
        ...overrides,
      } as DataSourceOptions);
      await database.initialize();
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
    afterAll(async () => {
      await app?.close();
      if (database?.isInitialized) await database.destroy();
      if (fresh?.isInitialized) await fresh.destroy();
      const server = new DataSource(options);
      await server.initialize();
      await server.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await server.query(`DROP ROLE IF EXISTS "${role}"`);
      await server.destroy();
    });

    it('A: the runtime never creates the extension; readiness and preflight fail clearly', async () => {
      // Connecting (DataSource + the whole application) created nothing.
      expect(await installed()).toBe(0);
      const ready = await http().get('/api/v1/ready').expect(503);
      expect(ready.body.checks).toMatchObject({
        database: true,
        migrations: false,
        extensions: false,
      });
      const config = loadEnvironment();
      const after = await databaseFindings(
        config,
        { requireCurrent: true },
        overrides,
      );
      expect(
        after.find((f) => f.check === 'extension_uuid_ossp'),
      ).toMatchObject({
        level: 'ERROR',
        detail: expect.stringContaining(
          'the application never creates extensions',
        ),
      });
      const before = await databaseFindings(
        config,
        { requireCurrent: false },
        overrides,
      );
      expect(before.find((f) => f.check === 'extension_uuid_ossp')?.level).toBe(
        'WARN',
      );
      // Neither /ready nor the preflight created it.
      expect(await installed()).toBe(0);
    });

    it('fails clearly when the migration role cannot create the extension', async () => {
      await fresh.query(
        `CREATE ROLE "${role}" LOGIN PASSWORD 'no-extension-role-pass'`,
      );
      await fresh.query(`GRANT CONNECT ON DATABASE "${name}" TO "${role}"`);
      const limited = new DataSource({
        ...options,
        database: name,
        username: role,
        password: 'no-extension-role-pass',
      } as DataSourceOptions);
      await limited.initialize();
      try {
        await expect(ensureExtensions(limited)).rejects.toThrow(
          MigrationPrerequisiteError,
        );
        await expect(ensureExtensions(limited)).rejects.toThrow(
          /CREATE EXTENSION IF NOT EXISTS "uuid-ossp"/,
        );
      } finally {
        await limited.destroy();
      }
      expect(await installed()).toBe(0);
    });

    it('B + C: the migration runner creates it explicitly, applies the 26 migrations, then the runtime is ready', async () => {
      const logged: string[] = [];
      const applied = await runMigrations(loadEnvironment(), overrides, (m) =>
        logged.push(m),
      );
      expect(logged).toEqual(['Created required extension uuid-ossp']);
      expect(applied).toHaveLength(26);
      expect(await installed()).toBe(1);
      expect((await schemaStatus(database)).pending).toEqual([]);
      // Idempotent: nothing created or applied the second time.
      const again: string[] = [];
      expect(
        await runMigrations(loadEnvironment(), overrides, (m) => again.push(m)),
      ).toEqual([]);
      expect(again).toEqual([]);
      // The running application becomes ready without a restart.
      expect((await http().get('/api/v1/ready').expect(200)).body).toEqual({
        status: 'ready',
      });
      const findings = await databaseFindings(
        loadEnvironment(),
        { requireCurrent: true },
        overrides,
      );
      expect(findings.filter((f) => f.level === 'ERROR')).toEqual([]);
    });
  },
);
