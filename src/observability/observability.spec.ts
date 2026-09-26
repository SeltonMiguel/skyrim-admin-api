import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { validateEnvironment } from '../config/environment.js';
import { RequestContext } from '../common/request-context/request-context.service.js';
import { AppLogger } from './app-logger.js';
import type { LogRecord } from './app-logger.js';
import { ALLOWED_LABELS, METRIC_PREFIX, Metrics } from './metrics.js';
import { MetricsController } from './metrics.controller.js';
import { REDACTED, redactText, redactValue } from './redaction.js';

const env = {
  ...parse(readFileSync('.env.example')),
  JWT_ACCESS_SECRET: randomBytes(48).toString('hex'),
  JWT_REFRESH_SECRET: randomBytes(48).toString('hex'),
  PLAYER_JWT_ACCESS_SECRET: randomBytes(48).toString('hex'),
  PLAYER_JWT_REFRESH_SECRET: randomBytes(48).toString('hex'),
  DB_SSL_MODE: 'disable',
};
const configOf = (raw: Record<string, string | undefined> = {}) => {
  const application = validateEnvironment({ ...env, ...raw });
  return { get: () => application } as never;
};
const JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuv';
const TOKEN = 'metrics-token-'.padEnd(40, 'x');

describe('Log redaction (12.3)', () => {
  it('masks secret keys at any depth and keeps identifiers', () => {
    expect(
      redactValue({
        password: 'p',
        nested: {
          refreshToken: 'r',
          credentialSecret: 's',
          challenge: 'c',
          authorization: 'Bearer abc',
          headers: [{ cookie: 'session=1' }],
        },
        credentialId: '00000000-0000-0000-0000-000000000001',
        sessionId: 'kept',
        dbPassword: 'x',
        metricsToken: 'y',
      }),
    ).toEqual({
      password: REDACTED,
      nested: {
        refreshToken: REDACTED,
        credentialSecret: REDACTED,
        challenge: REDACTED,
        authorization: REDACTED,
        headers: [{ cookie: REDACTED }],
      },
      credentialId: '00000000-0000-0000-0000-000000000001',
      sessionId: 'kept',
      dbPassword: REDACTED,
      metricsToken: REDACTED,
    });
  });
  it('masks tokens, bearer headers, PEM blocks and URL passwords inside text', () => {
    const text = redactText(
      `jwt ${JWT} header Bearer ${TOKEN} url postgres://skyrim:hunter2@db/app password=hunter3 ` +
        '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
    );
    for (const secret of [JWT, TOKEN, 'hunter2', 'hunter3', 'MIIB'])
      expect(text).not.toContain(secret);
    expect(text).toContain('postgres://skyrim:[REDACTED]@db/app');
  });
});

describe('Structured logger (12.3)', () => {
  const logger = (raw: Record<string, string> = {}) => {
    const context = new RequestContext();
    const instance = new AppLogger(
      configOf({ LOG_FORMAT: 'json', LOG_LEVEL: 'log', ...raw }),
      context,
    );
    const records: LogRecord[] = [];
    instance.sink = (record) => records.push(record);
    instance.echo = false;
    return { instance, records, context };
  };
  it('turns bracketed fields into JSON fields with requestId, context and level', () => {
    const { instance, records, context } = logger();
    context.run('req-1', () =>
      instance.log(
        'Game command dispatched [commandId=c1 gameServerId=s1 attempt=1]',
        'GameCommandWorker',
      ),
    );
    expect(records[0]).toMatchObject({
      level: 'log',
      context: 'GameCommandWorker',
      message: 'Game command dispatched',
      requestId: 'req-1',
      commandId: 'c1',
      gameServerId: 's1',
      attempt: '1',
    });
    expect(records[0].time).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
  it('redacts messages, object fields and stacks, and honours the level', () => {
    const { instance, records } = logger({ LOG_LEVEL: 'warn' });
    instance.log('dropped by level');
    instance.warn({ message: `leak ${JWT}`, refreshToken: 'r', eventId: 'e' });
    instance.error(
      'Unhandled exception',
      `Error: boom Bearer ${TOKEN}\n    at x`,
      'Filter',
    );
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      level: 'warn',
      refreshToken: REDACTED,
      eventId: 'e',
    });
    expect(records[1]).toMatchObject({ level: 'error', context: 'Filter' });
    expect(JSON.stringify(records)).not.toContain(JWT);
    expect(JSON.stringify(records)).not.toContain(TOKEN);
    expect((records[1].error as { stack: string }).stack).toContain('boom');
  });
});

describe('Metrics registry (12.3)', () => {
  it('uses only closed-enum labels and Prometheus naming on every custom metric', async () => {
    const metrics = new Metrics(configOf());
    const all = await metrics.registry.getMetricsAsJSON();
    const custom = all.filter(
      (m) =>
        !m.name.startsWith(`${METRIC_PREFIX}process_`) &&
        !m.name.startsWith(`${METRIC_PREFIX}nodejs_`),
    );
    expect(custom.length).toBeGreaterThan(40);
    for (const metric of custom) {
      expect(metric.name.startsWith(METRIC_PREFIX)).toBe(true);
      if (String(metric.type) === 'counter')
        expect(metric.name).toMatch(/_total$/);
      const labels = new Set<string>();
      for (const value of metric.values ?? [])
        for (const label of Object.keys(value.labels ?? {}))
          if (label !== 'le') labels.add(label);
      for (const label of (metric as unknown as { labelNames?: string[] })
        .labelNames ?? [])
        labels.add(label);
      for (const label of labels) expect(ALLOWED_LABELS.has(label)).toBe(true);
    }
    const text = await metrics.render();
    expect(text).toContain(`${METRIC_PREFIX}app_info{`);
    expect(text).toContain(`${METRIC_PREFIX}process_resident_memory_bytes`);
    expect(text).toContain(`${METRIC_PREFIX}nodejs_eventloop_lag_seconds`);
  });
  it('never declares an identifier-like label', () => {
    for (const forbidden of [
      'id',
      'player_id',
      'staff_id',
      'game_server_id',
      'command_id',
      'operation_id',
      'event_id',
      'work_id',
      'ip',
      'username',
      'path',
      'url',
    ])
      expect(ALLOWED_LABELS.has(forbidden)).toBe(false);
  });
});

describe('GET /metrics protection (12.3)', () => {
  const controller = (raw: Record<string, string>) =>
    new MetricsController(new Metrics(configOf(raw)), configOf(raw));
  const response = () =>
    ({ setHeader: () => undefined }) as unknown as import('express').Response;
  it('is a 404 when disabled (the production default)', async () => {
    await expect(
      controller({ METRICS_ENABLED: 'false' }).scrape(undefined, response()),
    ).rejects.toThrow(NotFoundException);
    expect(
      validateEnvironment({
        ...env,
        NODE_ENV: 'production',
        METRICS_BEARER_TOKEN: TOKEN,
      }).observability.metricsEnabled,
    ).toBe(false);
  });
  it('requires a token in production when enabled', () => {
    expect(() =>
      validateEnvironment({
        ...env,
        NODE_ENV: 'production',
        METRICS_ENABLED: 'true',
      }),
    ).toThrow(/^Invalid environment variables: METRICS_BEARER_TOKEN$/);
    expect(() =>
      validateEnvironment({ ...env, METRICS_BEARER_TOKEN: 'short' }),
    ).toThrow('METRICS_BEARER_TOKEN');
  });
  it('checks the bearer token in constant time and answers Prometheus text', async () => {
    const guarded = controller({
      METRICS_ENABLED: 'true',
      METRICS_BEARER_TOKEN: TOKEN,
    });
    for (const header of [
      undefined,
      'Bearer wrong',
      `Basic ${TOKEN}`,
      `Bearer ${TOKEN}x`,
    ])
      await expect(guarded.scrape(header, response())).rejects.toThrow(
        UnauthorizedException,
      );
    expect(await guarded.scrape(`Bearer ${TOKEN}`, response())).toContain(
      'skyrim_admin_app_info',
    );
  });
  it('validates log settings and bounded build labels', () => {
    const config = validateEnvironment({
      ...env,
      APP_VERSION: '1.2.3',
      GIT_SHA: 'abcdef1',
    });
    expect(config.observability).toMatchObject({
      metricsEnabled: true,
      collectionIntervalMs: 15000,
      logFormat: 'pretty',
      logLevel: 'log',
      version: '1.2.3',
      gitSha: 'abcdef1',
    });
    expect(
      validateEnvironment({ ...env, NODE_ENV: 'production' }).observability
        .logFormat,
    ).toBe('json');
    for (const [key, value] of [
      ['LOG_LEVEL', 'trace'],
      ['LOG_FORMAT', 'xml'],
      ['APP_VERSION', 'has space'],
      ['GIT_SHA', 'not-hex'],
      ['METRICS_COLLECTION_INTERVAL_MS', '10'],
    ])
      expect(() => validateEnvironment({ ...env, [key]: value })).toThrow(key);
  });
});
