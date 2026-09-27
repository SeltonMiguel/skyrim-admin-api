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

describe('ServerControl worker wake-up (12.6B)', () => {
  const setup = () => {
    let running = 0;
    let peak = 0;
    const gates: ReturnType<typeof deferred<never[]>>[] = [];
    const dispatcher = {
      expirePending: jest.fn(() => {
        running += 1;
        peak = Math.max(peak, running);
        const gate = deferred<never[]>();
        gates.push(gate);
        return gate.promise.finally(() => {
          running -= 1;
        });
      }),
      pendingIds: jest.fn(async () => []),
    };
    const handlers: (() => void)[] = [];
    const cluster = {
      subscribe: jest.fn((kind: string, handler: () => void) => {
        if (kind === 'SERVER_CONTROL_WORK') handlers.push(handler);
      }),
    };
    const worker = new ServerControlWorker(
      dispatcher as never,
      { expireResults: jest.fn(async () => []) } as never,
      config({ serverControl: { workerIntervalMs: 60000 } }),
      undefined,
      cluster as never,
    );
    const ticks = () => dispatcher.expirePending.mock.calls.length;
    return { worker, handlers, gates, ticks, peak: () => peak };
  };
  it('coalesces hints into one tick and never overlaps ticks', async () => {
    const { worker, handlers, gates, ticks, peak } = setup();
    worker.onApplicationBootstrap();
    expect(handlers).toHaveLength(1);
    handlers[0]();
    handlers[0]();
    worker.wake();
    await flush();
    expect(ticks()).toBe(1);
    // Hints during the running tick: exactly one follow-up, after it.
    handlers[0]();
    worker.wake();
    await flush();
    expect(ticks()).toBe(1);
    gates[0].resolve([]);
    await flush();
    expect(ticks()).toBe(2);
    gates[1].resolve([]);
    await flush();
    expect(ticks()).toBe(2);
    expect(peak()).toBe(1);
    await worker.onModuleDestroy();
  });
  it('ignores hints after shutdown started', async () => {
    const { worker, handlers, ticks } = setup();
    worker.onApplicationBootstrap();
    await worker.onModuleDestroy();
    handlers[0]();
    await flush();
    expect(ticks()).toBe(0);
  });
  it('drops a pending follow-up when shutdown starts during a tick', async () => {
    const { worker, handlers, gates, ticks } = setup();
    worker.onApplicationBootstrap();
    handlers[0]();
    await flush();
    handlers[0]();
    const destroying = worker.onModuleDestroy();
    gates[0].resolve([]);
    await destroying;
    await flush();
    expect(ticks()).toBe(1);
  });
  it('skips, never overlaps, a polling tick during a woken tick', async () => {
    const { worker, handlers, gates, ticks, peak } = setup();
    worker.onApplicationBootstrap();
    handlers[0]();
    await flush();
    expect(await worker.tick()).toBe(0);
    expect(ticks()).toBe(1);
    gates[0].resolve([]);
    await flush();
    expect(peak()).toBe(1);
    await worker.onModuleDestroy();
  });
  it('keeps polling on its interval without any hint', async () => {
    const polled = jest.fn(async () => []);
    const worker = new ServerControlWorker(
      { expirePending: polled, pendingIds: jest.fn(async () => []) } as never,
      { expireResults: jest.fn(async () => []) } as never,
      config({ serverControl: { workerIntervalMs: 10 } }),
      undefined,
      { subscribe: jest.fn() } as never,
    );
    worker.onApplicationBootstrap();
    // Intentional elapsed time: several polling intervals.
    await new Promise((resolve) => setTimeout(resolve, 80));
    await worker.onModuleDestroy();
    expect(polled.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('GameCommand worker wake-up (12.6B)', () => {
  const setup = (active = true) => {
    let running = 0;
    let peak = 0;
    const gates: ReturnType<typeof deferred<void>>[] = [];
    const receiver = {
      expireCommands: jest.fn(() => {
        running += 1;
        peak = Math.max(peak, running);
        const gate = deferred<void>();
        gates.push(gate);
        return gate.promise.finally(() => {
          running -= 1;
        });
      }),
      expirePending: jest.fn(async () => 0),
    };
    const local: (() => void)[] = [];
    const remote: (() => void)[] = [];
    const worker = new GameCommandWorker(
      {
        activeSessions: () => (active ? [{ gameServerId: 'a' }] : []),
        getSession: () => undefined,
      } as never,
      {} as never,
      receiver as never,
      config({
        gameBridge: { workerIntervalMs: 60000 },
        agent: { maxInFlightCommands: 1 },
      }),
      undefined,
      { onWork: (listener: () => void) => local.push(listener) } as never,
      {
        subscribe: jest.fn((kind: string, handler: () => void) => {
          if (kind === 'GAME_COMMAND_WORK') remote.push(handler);
        }),
      } as never,
    );
    const ticks = () => receiver.expireCommands.mock.calls.length;
    return { worker, local, remote, gates, ticks, peak: () => peak };
  };
  it('coalesces local and bus hints into one tick and never overlaps ticks', async () => {
    const { worker, local, remote, gates, ticks, peak } = setup();
    worker.onApplicationBootstrap();
    expect([local.length, remote.length]).toEqual([1, 1]);
    local[0]();
    remote[0]();
    worker.wake();
    await flush();
    expect(ticks()).toBe(1);
    // Hints during the running tick: exactly one follow-up, after it.
    local[0]();
    remote[0]();
    expect(await worker.tick()).toBe(0);
    await flush();
    expect(ticks()).toBe(1);
    gates[0].resolve();
    await flush();
    expect(ticks()).toBe(2);
    gates[1].resolve();
    await flush();
    expect(ticks()).toBe(2);
    expect(peak()).toBe(1);
    await worker.onModuleDestroy();
  });
  it('ignores hints without a local ACTIVE Agent session', async () => {
    const { worker, local, remote, ticks } = setup(false);
    worker.onApplicationBootstrap();
    local[0]();
    remote[0]();
    await flush();
    expect(ticks()).toBe(0);
    await worker.onModuleDestroy();
  });
  it('ignores hints after shutdown and drops a pending follow-up', async () => {
    const { worker, local, remote, gates, ticks } = setup();
    worker.onApplicationBootstrap();
    local[0]();
    await flush();
    remote[0]();
    const destroying = worker.onModuleDestroy();
    gates[0].resolve();
    await destroying;
    local[0]();
    await flush();
    expect(ticks()).toBe(1);
  });
  it('keeps polling on its interval without any hint', async () => {
    const polled = jest.fn(async () => undefined);
    const worker = new GameCommandWorker(
      { activeSessions: () => [] } as never,
      {} as never,
      { expireCommands: polled, expirePending: jest.fn(async () => 0) } as never,
      config({
        gameBridge: { workerIntervalMs: 10 },
        agent: { maxInFlightCommands: 1 },
      }),
      undefined,
      { onWork: jest.fn() } as never,
      { subscribe: jest.fn() } as never,
    );
    worker.onApplicationBootstrap();
    // Intentional elapsed time: several polling intervals.
    await new Promise((resolve) => setTimeout(resolve, 80));
    await worker.onModuleDestroy();
    expect(polled.mock.calls.length).toBeGreaterThanOrEqual(2);
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
