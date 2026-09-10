import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  INestApplication,
  Logger,
  Post,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { setTimeout } from 'node:timers/promises';
import { AppModule } from '../src/app.module.js';
import { RequestContext } from '../src/common/request-context/request-context.service.js';
import { setupApp } from '../src/setup-app.js';
import { AppExpressAdapter } from '../src/common/http/app-express.adapter.js';

// Test-only routes exercise global infrastructure without adding domains.
class ProbeDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  count: number;
}

@Controller({ path: '_test', version: '1' })
class ProbeController {
  constructor(private readonly context: RequestContext) {}

  @Post('validation')
  validate(@Body() dto: ProbeDto) {
    return { count: dto.count, transformed: dto instanceof ProbeDto };
  }

  @Get('context')
  async contextProbe() {
    const before = this.context.requestId;
    await setTimeout(10);
    return { before, after: this.context.requestId };
  }

  @Get('known-error')
  knownError() {
    throw new HttpException('Known failure', HttpStatus.CONFLICT);
  }

  @Get('unknown-error')
  unknownError() {
    throw new Error('Internal database password or stack details');
  }
}

describe('Foundation HTTP (e2e, substituted database boundary)', () => {
  let app: INestApplication<App>;
  const query = jest.fn<() => Promise<unknown>>();

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ProbeController],
    })
      .overrideProvider(DataSource)
      .useValue({ query, options: { type: 'postgres' }, isInitialized: false })
      .compile();
    app = module.createNestApplication(new AppExpressAdapter());
    app.useLogger(false);
    setupApp(app);
    await app.init();
  });

  beforeEach(() => query.mockReset().mockResolvedValue([{ '?column?': 1 }]));
  afterAll(async () => {
    await app?.close();
  });

  it('boots and checks the database on the versioned route', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200);
    expect(response.body).toEqual({ status: 'ok', database: 'up' });
    expect(query).toHaveBeenCalledWith('SELECT 1');
    expect(response.headers['x-request-id']).toMatch(
      /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/,
    );
  });

  it('preserves a supplied ID across asynchronous work', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/_test/context')
      .set('x-request-id', 'upstream-request:42')
      .expect(200);
    expect(response.headers['x-request-id']).toBe('upstream-request:42');
    expect(response.body).toEqual({
      before: 'upstream-request:42',
      after: 'upstream-request:42',
    });
  });

  it('isolates concurrent requests', async () => {
    await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        const id = `concurrent-${index}`;
        const response = await request(app.getHttpServer())
          .get('/api/v1/_test/context')
          .set('x-request-id', id)
          .expect(200);
        expect(response.body).toEqual({ before: id, after: id });
      }),
    );
  });

  it.each(['', 'a'.repeat(129), 'invalid value'])(
    'replaces an invalid ID (%s)',
    async (id) => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/health')
        .set('x-request-id', id)
        .expect(200);
      expect(response.headers['x-request-id']).toMatch(/^[\da-f-]{36}$/);
    },
  );

  it('returns standardized 503 when the query fails', async () => {
    query.mockRejectedValueOnce(new Error('private connection details'));
    const response = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('x-request-id', 'database-down')
      .expect(503);
    expect(response.body).toEqual({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'Database unavailable',
      path: '/api/v1/health',
      requestId: 'database-down',
      timestamp: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(response.body.timestamp as string))).toBe(
      false,
    );
    expect(response.text).not.toContain('private');
  });

  it.each(['/', '/health', '/api/health', '/api/v2/health', '/api/v1/missing'])(
    'returns standardized 404 for %s',
    async (path) => {
      const response = await request(app.getHttpServer()).get(path).expect(404);
      expect(response.body).toMatchObject({
        statusCode: 404,
        error: 'Not Found',
        path,
        requestId: response.headers['x-request-id'],
        timestamp: expect.any(String),
      });
    },
  );

  it('transforms DTO instances and explicitly typed numeric input', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/_test/validation')
      .send({ count: '2' })
      .expect(201);
    expect(response.body).toEqual({ count: 2, transformed: true });
  });

  it.each([{ count: 2, extra: true }, { count: 'invalid' }, { count: 0 }, {}])(
    'rejects invalid or unknown DTO properties: %j',
    async (payload) => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/_test/validation')
        .send(payload)
        .expect(400);
      expect(response.body).toMatchObject({
        statusCode: 400,
        error: 'Bad Request',
        message: expect.any(Array),
        path: '/api/v1/_test/validation',
        requestId: response.headers['x-request-id'],
      });
    },
  );

  it('correlates malformed JSON rejected before the controller', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/_test/validation')
      .set('Content-Type', 'application/json')
      .set('x-request-id', 'malformed-json')
      .send('{')
      .expect(400);
    expect(response.headers['x-request-id']).toBe('malformed-json');
    expect(response.body).toMatchObject({
      statusCode: 400,
      requestId: 'malformed-json',
    });
  });

  it('preserves HttpException status and string responses', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/_test/known-error')
      .expect(409);
    expect(response.body).toMatchObject({
      statusCode: 409,
      error: 'Conflict',
      message: 'Known failure',
    });
  });

  it('hides unknown error details while retaining correlation', async () => {
    const log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    try {
      const response = await request(app.getHttpServer())
        .get('/api/v1/_test/unknown-error')
        .expect(500);
      expect(response.body).toMatchObject({
        statusCode: 500,
        error: 'Internal Server Error',
        message: 'Internal server error',
        requestId: response.headers['x-request-id'],
      });
      expect(response.text).not.toContain('password');
      expect(response.body).not.toHaveProperty('stack');
    } finally {
      log.mockRestore();
    }
  });

  it('serves Swagger outside the API prefix with the versioned health path', async () => {
    const page = await request(app.getHttpServer()).get('/docs/').expect(200);
    expect(page.text).toContain('Swagger UI');
    expect(page.headers['x-request-id']).toBeDefined();
    const response = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);
    expect(response.body.info).toMatchObject({
      title: 'Skyrim Admin API',
      description: 'Administrative API for Skyrim Brasil / SkyMP',
      version: '0.1.0',
    });
    expect(response.body.paths).toHaveProperty('/api/v1/health');
  });
});
