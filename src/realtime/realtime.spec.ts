import { jest } from '@jest/globals';
import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';
import {
  REALTIME_EVENT_TYPES,
  RealtimeEventBus,
} from '../realtime-events/realtime-event-bus.js';
import type {
  RealtimeEnvelope,
  RealtimeRecipients,
} from '../realtime-events/realtime-event-bus.js';
import { Permission } from '../rbac/permissions.js';
import { MAX_GROUP_MEMBERS } from '../player-groups/player-group.contracts.js';
import {
  connectionKey,
  MAX_REALTIME_BUFFERED_BYTES,
  RealtimeConnectionRegistry,
  sendFrame,
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
  it('never lets a publication cross surfaces', () => {
    const bus = new RealtimeEventBus();
    const seen: RealtimeRecipients[] = [];
    bus.subscribe((_, recipients) => seen.push(recipients));
    bus.publish(
      'STAFF_GAME_SERVER_UPDATED',
      { gameServerId: 's' },
      { staffPermission: Permission.GAME_BRIDGE_READ },
    );
    expect(seen).toEqual([
      { playerIds: [], staffPermission: Permission.GAME_BRIDGE_READ },
    ]);
    // A Staff type to players, or a Player type to Staff, is dropped.
    bus.publish('STAFF_GAME_OPERATION_UPDATED', {}, { playerIds: ['p'] });
    bus.publish(
      'PLAYER_GAME_OPERATION_UPDATED',
      {},
      { staffPermission: Permission.GAME_BRIDGE_READ },
    );
    bus.publish('CHAT_MESSAGE_CREATED', {}, { playerIds: ['p'] });
    expect(seen).toEqual([
      { playerIds: [], staffPermission: Permission.GAME_BRIDGE_READ },
      { playerIds: ['p'], staffPermission: null },
    ]);
  });
  it('declares exactly three Staff wake-ups', () => {
    expect(REALTIME_EVENT_TYPES.filter((t) => t.startsWith('STAFF_'))).toEqual([
      'STAFF_GAME_SERVER_UPDATED',
      'STAFF_GAME_OPERATION_UPDATED',
      'STAFF_SERVER_CONTROL_UPDATED',
    ]);
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
    expect(registry.surface('STAFF')).toHaveLength(1);
    expect(registry.surface('PLAYER')).toHaveLength(0);
  });
  it('closes exactly one Player session, idempotently and without later delivery', () => {
    const registry = new RealtimeConnectionRegistry();
    const socket = () => {
      const ws = {
        readyState: 1,
        OPEN: 1,
        send: jest.fn(),
        terminate: jest.fn(),
        close: jest.fn(() => {
          ws.readyState = 2;
        }),
      };
      return ws;
    };
    const key = connectionKey('PLAYER', 'p1');
    const [a1, a2, b] = [socket(), socket(), socket()];
    registry.add(key, a1 as never, 'session-a');
    registry.add(key, a2 as never, 'session-a');
    registry.add(key, b as never, 'session-b');
    expect(
      registry.closePlayerSession('session-a', 4001, 'SESSION_REVOKED'),
    ).toBe(2);
    expect(a1.close).toHaveBeenCalledWith(4001, 'SESSION_REVOKED');
    expect(a2.close).toHaveBeenCalledWith(4001, 'SESSION_REVOKED');
    expect(b.close).not.toHaveBeenCalled();
    expect(registry.count(key)).toBe(1);
    expect(registry.sessionCount('session-a')).toBe(0);
    // Nothing published afterwards reaches the revoked sockets.
    registry.send(key, 'later');
    expect(a1.send).not.toHaveBeenCalled();
    expect(b.send).toHaveBeenCalledWith('later');
    // Idempotent, and the socket's own close event is a no-op.
    expect(
      registry.closePlayerSession('session-a', 4001, 'SESSION_REVOKED'),
    ).toBe(0);
    registry.remove(key, a1 as never);
    expect(registry.count(key)).toBe(1);
    // A socket already closing is unregistered without being closed again.
    const closing = { ...socket(), readyState: 2 };
    registry.add(key, closing as never, 'session-c');
    expect(
      registry.closePlayerSession('session-c', 4001, 'SESSION_REVOKED'),
    ).toBe(1);
    expect(closing.close).not.toHaveBeenCalled();
    registry.remove(key, b as never);
    expect(registry.count()).toBe(0);
    expect(registry.sessionCount('session-b')).toBe(0);
  });
  it('drops a slow consumer instead of buffering without bound', () => {
    const socket = (bufferedAmount: number, readyState: 1 | 3 = 1) => ({
      readyState,
      OPEN: 1 as const,
      bufferedAmount,
      send: jest.fn(),
      terminate: jest.fn(),
    });
    const fast = socket(MAX_REALTIME_BUFFERED_BYTES);
    expect(sendFrame(fast, 'f')).toBe(true);
    expect(fast.send).toHaveBeenCalledWith('f');
    const slow = socket(MAX_REALTIME_BUFFERED_BYTES + 1);
    expect(sendFrame(slow, 'f')).toBe(false);
    expect(slow.send).not.toHaveBeenCalled();
    expect(slow.terminate).toHaveBeenCalledTimes(1);
    const closed = socket(0, 3);
    expect(sendFrame(closed, 'f')).toBe(false);
    expect(closed.send).not.toHaveBeenCalled();
    const broken = {
      ...socket(0),
      send: jest.fn(() => {
        throw new Error('broken');
      }),
    };
    expect(sendFrame(broken, 'f')).toBe(false);
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
      'player-chat',
      'realtime-events',
    ])
      for (const source of sources(dir))
        for (const module of imports(source))
          expect(module).not.toMatch(/^ws$|\/realtime\/|socket\.io|electron/i);
    for (const source of sources('realtime'))
      for (const module of imports(source))
        expect(module).not.toMatch(
          /player-groups|player-guilds|player-trades|player-marketplace|player-chat|player-characters|socket\.io|electron/i,
        );
  });
  it('keeps the provisional group size centralized', () => {
    expect(MAX_GROUP_MEMBERS).toBe(5);
  });
});
