import { jest } from '@jest/globals';
import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';
import { RealtimeEventBus } from '../realtime-events/realtime-event-bus.js';
import type { RealtimeEnvelope } from '../realtime-events/realtime-event-bus.js';
import { MAX_GROUP_MEMBERS } from '../player-groups/player-group.contracts.js';
import {
  connectionKey,
  RealtimeConnectionRegistry,
} from './realtime-connection.registry.js';
import { parseAuthFrame } from './realtime.gateway.js';

const frame = (value: unknown) =>
  parseAuthFrame(Buffer.from(JSON.stringify(value)));

describe('Realtime event bus', () => {
  it('builds a flat envelope, dedups recipients and isolates listener failures', () => {
    const bus = new RealtimeEventBus();
    const seen: [RealtimeEnvelope, readonly string[]][] = [];
    bus.subscribe(() => {
      throw new Error('broken listener');
    });
    const off = bus.subscribe((envelope, recipients) =>
      seen.push([envelope, recipients.playerIds]),
    );
    const envelope = bus.publish(
      'GROUP_CREATED',
      {
        groupId: 'g',
        count: 1,
        ok: true,
        none: null,
        entity: { id: 'x' } as never,
      },
      { playerIds: ['a', 'a', 'b'] },
    );
    expect(Object.keys(envelope).sort()).toEqual([
      'data',
      'eventId',
      'occurredAt',
      'type',
    ]);
    expect(envelope.data).toEqual({
      groupId: 'g',
      count: 1,
      ok: true,
      none: null,
    });
    expect(seen).toEqual([[envelope, ['a', 'b']]]);
    off();
    bus.publish('GROUP_DISBANDED', {}, { playerIds: ['a'] });
    expect(seen).toHaveLength(1);
  });
});

describe('Realtime connection registry', () => {
  it('tracks many sockets per identity and removes them on close', () => {
    const registry = new RealtimeConnectionRegistry();
    const socket = () =>
      ({ readyState: 1, OPEN: 1, send: jest.fn() }) as unknown as WebSocket;
    const [one, two] = [socket(), socket()];
    const key = connectionKey('PLAYER', 'p1');
    expect(key).toBe('PLAYER:p1');
    registry.add(key, one);
    registry.add(key, two);
    registry.add(connectionKey('STAFF', 'p1'), socket());
    expect(registry.count(key)).toBe(2);
    registry.send(key, 'frame');
    expect(one.send).toHaveBeenCalledWith('frame');
    expect(two.send).toHaveBeenCalledWith('frame');
    registry.remove(key, one);
    registry.remove(key, two);
    expect(registry.count(key)).toBe(0);
    expect(registry.count()).toBe(1);
  });
});

describe('Realtime AUTH frame', () => {
  it('accepts only {type:"AUTH", surface, token}', () => {
    expect(frame({ type: 'AUTH', surface: 'PLAYER', token: 't' })).toEqual({
      surface: 'PLAYER',
      token: 't',
    });
    expect(frame({ type: 'AUTH', surface: 'STAFF', token: 't' })).toMatchObject(
      {
        surface: 'STAFF',
      },
    );
    for (const invalid of [
      { type: 'AUTH', token: 't' },
      { type: 'AUTH', surface: 'ADMIN', token: 't' },
      { type: 'AUTH', surface: 'PLAYER', token: '' },
      { type: 'AUTH', surface: 'PLAYER', token: 1 },
      { type: 'AUTH', surface: 'PLAYER', token: 'x'.repeat(4097) },
      { type: 'SUBSCRIBE', surface: 'PLAYER', token: 't' },
      { type: 'AUTH', surface: 'PLAYER', token: 't', room: 'group:1' },
      { type: 'AUTH', surface: 'PLAYER', token: 't', playerId: 'p' },
      [],
      null,
    ])
      expect(frame(invalid)).toBeNull();
    expect(parseAuthFrame(Buffer.from('not json'))).toBeNull();
  });
});

describe('Realtime and group boundaries', () => {
  const sources = (dir: string) =>
    globSync(fileURLToPath(new URL(`../${dir}/**/*.ts`, import.meta.url)))
      .filter((file) => !file.endsWith('.spec.ts'))
      .map((file) => readFileSync(file, 'utf8'));
  const imports = (source: string) =>
    [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  it('keeps domains and the event bus independent of the WebSocket transport', () => {
    for (const dir of [
      'player-groups',
      'player-guilds',
      'player-trades',
      'player-marketplace',
      'realtime-events',
    ])
      for (const source of sources(dir))
        for (const module of imports(source))
          expect(module).not.toMatch(/^ws$|\/realtime\/|socket\.io|electron/i);
    for (const source of sources('realtime'))
      for (const module of imports(source))
        expect(module).not.toMatch(
          /player-groups|player-guilds|player-trades|player-marketplace|player-characters|socket\.io|electron/i,
        );
  });
  it('keeps the provisional group size centralized', () => {
    expect(MAX_GROUP_MEMBERS).toBe(5);
  });
});
