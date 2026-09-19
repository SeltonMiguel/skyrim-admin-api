import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { setupApp } from '../src/setup-app.js';
import { AppExpressAdapter } from '../src/common/http/app-express.adapter.js';

const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;

describeDatabase('Foundation with real PostgreSQL', () => {
  let app: INestApplication<App>;
  let database: DataSource;

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module.js');
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication(new AppExpressAdapter());
    app.useLogger(false);
    setupApp(app);
    await app.init();
    database = app.get(DataSource);
  }, 30000);

  afterAll(async () => {
    await app?.close();
  });

  it('initializes PostgreSQL without automatic schema changes', () => {
    expect(database.isInitialized).toBe(true);
    expect(database.options.type).toBe('postgres');
    expect(database.options.synchronize).toBe(false);
    expect(database.options.migrationsRun).toBe(false);
  });

  it('checks the real database through HTTP', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200);
    expect(response.body).toEqual({ status: 'ok', database: 'up' });
  });
});
