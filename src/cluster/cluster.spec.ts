import { ConfigService } from '@nestjs/config';
import { readFileSync, globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DataSource } from 'typeorm';
import { validateEnvironment } from '../config/environment.js';
import type { ApplicationConfig } from '../config/environment.js';
import { LifecycleService } from '../lifecycle/lifecycle.service.js';
import { RealtimeEventBus } from '../realtime-events/realtime-event-bus.js';
import type { RealtimeEnvelope } from '../realtime-events/realtime-event-bus.js';
import { RealtimeSessionControl } from '../realtime-events/realtime-session-control.js';
import { ClusterBus } from './cluster-bus.js';
import type { ClusterKind, ClusterPayload } from './cluster-bus.js';
import { ClusterRelay } from './cluster-relay.js';
import { InstanceIdentity } from './instance-identity.js';
import { bucketHash, PostgresRateLimiter } from './pg-rate-limiter.js';

const env = (extra: Record<string, string> = {}) =>
  new ConfigService<{ application: ApplicationConfig }, true>({
    application: validateEnvironment({
      NODE_ENV: 'test',
      DB_HOST: 'local',
      DB_USERNAME: 'test',
      DB_PASSWORD: 'test',
      DB_DATABASE: 'test',
      ...extra,
    }),
  });
const noDatabase = {
  query: async () => {
    throw new Error('no database in unit tests');
  },
} as unknown as DataSource;

describe('Instance identity and topology (12.5)', () => {
  it('gives every execution its own random id', () => {
    const a = new InstanceIdentity();
    const b = new InstanceIdentity();
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.id).not.toBe(b.id);
  });
  it('never takes the global lock in MULTI and keeps it in SINGLE production', () => {
    const multi = new LifecycleService(
      env({ BACKEND_TOPOLOGY: 'MULTI' }),
      new InstanceIdentity(),
    );
    expect(multi.topology).toBe('MULTI');
    expect(multi.lockRequired).toBe(false);
    expect(multi.state().lock).toBe(true);
    const single = new LifecycleService(
      env({ SINGLE_INSTANCE_LOCK_ENABLED: 'true' }),
      new InstanceIdentity(),
    );
    expect(single.topology).toBe('SINGLE');
    expect(single.lockRequired).toBe(true);
  });
});

describe('Shared rate limiter (12.5)', () => {
  it('stores only a scoped SHA-256 of the key', () => {
    const hash = bucketHash('staff-login-ip', '203.0.113.7');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('203.0.113.7');
    expect(bucketHash('other', '203.0.113.7')).not.toBe(hash);
  });
  it('fails closed when the store is unavailable', async () => {
    const limiter = new PostgresRateLimiter(noDatabase, 60000);
    const rule = { limit: 5, windowMs: 60000 };
    expect(await limiter.consume('s', 'k', rule)).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
    expect((await limiter.check('s', 'k', rule)).allowed).toBe(false);
    await expect(limiter.reset('s')).resolves.toBeUndefined();
  });
});

describe('Cluster bus and relay (12.5)', () => {
  it('is inert in SINGLE: publish is a no-op, nothing is relayed', async () => {
    const config = env();
    const bus = new ClusterBus(noDatabase, new InstanceIdentity(), config);
    expect(bus.enabled).toBe(false);
    await expect(bus.publish('REALTIME', {})).resolves.toBeUndefined();
    const events = new RealtimeEventBus();
    const relayed: unknown[] = [];
    new ClusterRelay(bus, events, new RealtimeSessionControl()).onModuleInit();
    events.subscribe((envelope) => relayed.push(envelope.type));
    events.publish('PLAYER_SETTINGS_UPDATED', {}, { playerIds: ['p'] });
    expect(relayed).toEqual(['PLAYER_SETTINGS_UPDATED']);
  });
  it('relays in MULTI and re-validates what it receives', async () => {
    const handlers = new Map<ClusterKind, (p: ClusterPayload) => void>();
    const published: [ClusterKind, ClusterPayload][] = [];
    const bus = {
      enabled: true,
      publish: async (kind: ClusterKind, payload: ClusterPayload) => {
        published.push([kind, payload]);
      },
      subscribe: (kind: ClusterKind, handler: (p: ClusterPayload) => void) => {
        handlers.set(kind, handler);
        return () => undefined;
      },
    } as unknown as ClusterBus;
    const events = new RealtimeEventBus();
    const control = new RealtimeSessionControl();
    new ClusterRelay(bus, events, control).onModuleInit();
    const delivered: string[] = [];
    events.subscribe((envelope, recipients) =>
      delivered.push(`${envelope.type}:${recipients.playerIds.join(',')}`),
    );
    const closed: string[] = [];
    control.subscribe((sessionId) => closed.push(sessionId));
    control.subscribeAccounts((playerId) => closed.push(`account:${playerId}`));
    // Local publish: delivered here, relayed once.
    events.publish('PLAYER_SETTINGS_UPDATED', {}, { playerIds: ['p1'] });
    control.playerSessionRevoked('s1');
    expect(published.map(([kind]) => kind)).toEqual([
      'REALTIME',
      'PLAYER_SESSION_REVOKED',
    ]);
    // Remote messages: local fan-out only, never relayed again.
    const envelope: RealtimeEnvelope = {
      eventId: 'e',
      type: 'PLAYER_SETTINGS_UPDATED',
      occurredAt: new Date().toISOString(),
      data: {},
    };
    handlers.get('REALTIME')!({
      envelope,
      recipients: { playerIds: ['p2'], staffPermission: null },
    });
    // A Staff type addressed to players, or an unknown type, is dropped.
    handlers.get('REALTIME')!({
      envelope: { ...envelope, type: 'STAFF_OPERATIONS_UPDATED' },
      recipients: { playerIds: ['p3'], staffPermission: null },
    });
    handlers.get('REALTIME')!({
      envelope: { ...envelope, type: 'ARBITRARY' },
      recipients: { playerIds: ['p4'], staffPermission: null },
    });
    handlers.get('PLAYER_ACCOUNT_REVOKED')!({
      playerId: 'p9',
      sessionIds: ['s9'],
    });
    handlers.get('PLAYER_SESSION_REVOKED')!({ sessionId: 42 });
    expect(delivered).toEqual([
      'PLAYER_SETTINGS_UPDATED:p1',
      'PLAYER_SETTINGS_UPDATED:p2',
    ]);
    expect(closed).toEqual(['s1', 'account:p9']);
    expect(published).toHaveLength(2);
  });
});

describe('Coordination boundaries (12.5)', () => {
  const sources = globSync(
    fileURLToPath(new URL('../**/*.ts', import.meta.url)),
  )
    .filter((file) => !file.endsWith('.spec.ts'))
    .map((file) => [file, readFileSync(file, 'utf8')] as const);
  it('uses PostgreSQL only (no Redis or broker client)', () => {
    for (const [, source] of sources)
      expect(source).not.toMatch(/from '(ioredis|redis|kafkajs|amqplib)'/);
  });
  it('never labels a metric with the instance id', () => {
    const metrics = sources.find(([file]) =>
      file.endsWith('observability/metrics.ts'),
    )![1];
    expect(metrics).not.toMatch(/'instance(_id)?'/);
  });
});
