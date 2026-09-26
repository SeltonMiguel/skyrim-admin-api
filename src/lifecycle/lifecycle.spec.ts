import { jest } from '@jest/globals';
import { GameCommandWorker } from '../game-agent/game-command.worker.js';
import { AgentWorkNotifier } from '../game-agent/agent-work.notifier.js';
import { ServerControlWorker } from '../server-control/server-control.worker.js';
import { VipDeliveryService } from '../vip-entitlements/vip-delivery.service.js';
import { configFindings } from '../ops/preflight.checks.js';
import { validateEnvironment } from '../config/environment.js';
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { randomBytes } from 'node:crypto';
import { TickDrain } from './tick-drain.js';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
};
const flush = async () => {
  for (let i = 0; i < 10; i++)
    await new Promise((resolve) => setImmediate(resolve));
};
const config = (value: object) => ({ get: () => value }) as never;

// Stop scheduling, then await the running tick (12.2), for every loop.
async function expectDrain(
  worker: {
    onApplicationBootstrap(): void;
    onModuleDestroy(): Promise<void>;
    tick(): Promise<unknown>;
  },
  release: () => void,
  calls: () => number,
) {
  const cleared = jest.spyOn(globalThis, 'clearInterval');
  worker.onApplicationBootstrap();
  const running = worker.tick();
  await flush();
  let drained = false;
  const destroying = worker.onModuleDestroy().then(() => {
    drained = true;
  });
  await flush();
  expect(cleared).toHaveBeenCalled();
  expect(drained).toBe(false);
  release();
  await running;
  await destroying;
  expect(drained).toBe(true);
  const before = calls();
  await worker.tick();
  expect(calls()).toBe(before);
  cleared.mockRestore();
}

describe('Worker draining on graceful shutdown (12.2)', () => {
  it('tracks one running tick', async () => {
    const drain = new TickDrain();
    await drain.wait();
    drain.begin();
    expect(drain.active).toBe(true);
    let done = false;
    const waiting = drain.wait().then(() => {
      done = true;
    });
    await flush();
    expect(done).toBe(false);
    drain.end();
    await waiting;
    expect(drain.active).toBe(false);
  });
  it('GameCommandWorker', async () => {
    const gate = deferred<number>();
    const receiver = {
      expireCommands: jest.fn(() => gate.promise),
      expirePending: jest.fn(async () => 0),
    };
    const worker = new GameCommandWorker(
      { activeSessions: () => [] } as never,
      {} as never,
      receiver as never,
      config({
        gameBridge: { workerIntervalMs: 60000 },
        agent: { maxInFlightCommands: 1 },
      }),
    );
    await expectDrain(
      worker,
      () => gate.resolve(0),
      () => receiver.expireCommands.mock.calls.length,
    );
  });
  it('ServerControlWorker', async () => {
    const gate = deferred<never[]>();
    const dispatcher = {
      expirePending: jest.fn(() => gate.promise),
      pendingIds: jest.fn(async () => []),
    };
    const worker = new ServerControlWorker(
      dispatcher as never,
      { expireResults: jest.fn(async () => []) } as never,
      config({ serverControl: { workerIntervalMs: 60000 } }),
    );
    await expectDrain(
      worker,
      () => gate.resolve([]),
      () => dispatcher.expirePending.mock.calls.length,
    );
  });
  it('VipDeliveryService', async () => {
    const gate = deferred<never[]>();
    const query = jest.fn(() => gate.promise);
    const worker = new VipDeliveryService(
      {
        query,
        manager: {
          getRepository: () => ({
            createQueryBuilder: () => {
              const builder = {
                select: () => builder,
                where: () => builder,
                orderBy: () => builder,
                addOrderBy: () => builder,
                take: () => builder,
                getMany: async () => [],
              };
              return builder;
            },
          }),
        },
      } as never,
      {} as never,
      {} as never,
      config({ vipDelivery: { workerIntervalMs: 60000 } }),
    );
    await expectDrain(
      worker,
      () => gate.resolve([]),
      () => query.mock.calls.length,
    );
  });
  it('AgentWorkNotifier', async () => {
    const gate = deferred<{ items: never[] }>();
    const work = { page: jest.fn(() => gate.promise) };
    const worker = new AgentWorkNotifier(
      {
        activeSessions: () => [{ gameServerId: 's', connectionId: 'c' }],
      } as never,
      work as never,
      { now: () => new Date() } as never,
      config({ agent: { workPushIntervalMs: 60000 } }),
    );
    await expectDrain(
      worker,
      () => gate.resolve({ items: [] }),
      () => work.page.mock.calls.length,
    );
  });
});

describe('Production preflight findings (12.2)', () => {
  const env = {
    ...parse(readFileSync('.env.example')),
    JWT_ACCESS_SECRET: randomBytes(48).toString('hex'),
    JWT_REFRESH_SECRET: randomBytes(48).toString('hex'),
    PLAYER_JWT_ACCESS_SECRET: randomBytes(48).toString('hex'),
    PLAYER_JWT_REFRESH_SECRET: randomBytes(48).toString('hex'),
    DB_SSL_MODE: 'disable',
  };
  const levels = (raw: Record<string, string>) =>
    Object.fromEntries(
      configFindings(validateEnvironment(raw)).map((f) => [f.check, f.level]),
    );
  it('flags a non-production mode as an error and unsafe defaults as warnings', () => {
    expect(levels(env)).toMatchObject({
      NODE_ENV: 'ERROR',
      SINGLE_INSTANCE_LOCK_ENABLED: 'ERROR',
      TRUST_PROXY: 'WARN',
      CORS_ORIGINS: 'WARN',
      SECURITY_HSTS_MAX_AGE_SECONDS: 'WARN',
      SWAGGER_ENABLED: 'WARN',
    });
  });
  it('accepts an explicit production configuration', () => {
    const findings = levels({
      ...env,
      NODE_ENV: 'production',
      TRUST_PROXY: '10.0.0.0/8',
      CORS_ORIGINS: 'https://admin.example.com',
      SECURITY_HSTS_MAX_AGE_SECONDS: '31536000',
      DB_HOST: 'db.internal',
      DB_SSL_MODE: 'verify-full',
    });
    expect(Object.values(findings)).not.toContain('ERROR');
    expect(Object.values(findings)).not.toContain('WARN');
    expect(
      levels({ ...env, NODE_ENV: 'production', DB_HOST: 'db.internal' })
        .DB_SSL_MODE,
    ).toBe('WARN');
  });
});
