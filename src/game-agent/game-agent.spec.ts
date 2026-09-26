import { jest } from '@jest/globals';
import { MemoryRateLimiter } from '../common/rate-limit/rate-limiter.js';
import { ConcurrencyLimiter } from '../common/rate-limit/concurrency-limiter.js';
import { SecurityLog } from '../common/security/security-log.js';
import { randomUUID } from 'node:crypto';
import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { HttpAdapterHost } from '@nestjs/core';
import { MAX_COMMAND_RESULT_BYTES } from '../game-bridge/command-limits.js';
import type { BridgeClock } from '../game-bridge/bridge-clock.js';
import type { GameConnectionService } from '../game-bridge/game-connection.service.js';
import {
  resolveUpgrade,
  WebSocketUpgradeRouter,
} from '../websocket/websocket-upgrade.router.js';
import { REALTIME_PATH } from '../realtime/realtime.gateway.js';
import {
  agentSecretHash,
  agentSecretMatches,
  AGENT_SECRET_BYTES,
  generateAgentSecret,
  MAX_ACTIVE_AGENT_CREDENTIALS,
} from './agent-credential.contracts.js';
import {
  AGENT_PATH,
  AgentClose,
  AgentProtocolError,
  GameProcessState as G,
  heartbeatPayload,
  helloPayload,
  isRuntimeReady,
  MAX_AGENT_CAPABILITIES,
  MAX_AGENT_FRAME_BYTES,
  parseEnvelope,
  serverControlResultPayload,
  domainEventPayload,
  workSyncPayload,
} from './agent-protocol.contracts.js';
import { AgentWorkService } from './agent-work.service.js';
import {
  AGENT_EVENT_KINDS,
  AGENT_WORK_KINDS,
  MAX_WORK_PAGE_BYTES,
} from './agent-domain-event.contracts.js';
import type { AgentEnvelope } from './agent-protocol.contracts.js';
import { AgentSessionRegistry } from './agent-session.registry.js';
import type {
  AgentSessionSnapshot,
  AgentSocket,
} from './agent-session.registry.js';
import { AgentMessageRouter } from './agent-message.router.js';
import { AgentGateway } from './agent.gateway.js';
import { AgentGameGateway } from './agent-game.gateway.js';
import { AgentServerControlGateway } from './agent-server-control.gateway.js';
import type { ServerControlRequest } from '../server-control/server-control-gateway.js';
import {
  COMMAND_DEDUP_CAPABILITY,
  GAME_COMMAND_CAPABILITY,
  SERVER_CONTROL_CAPABILITY,
  supportsServerControl,
  supportedCommandTypes,
  supportsCommand,
} from './agent-capabilities.js';
import { COMMAND_KINDS } from '../game-bridge/command-kinds.js';
import { COMMAND_TYPES } from '../game-bridge/command-contract.js';
import type { CommandEnvelope } from '../game-bridge/command-contract.js';
import type { AgentAuthService } from './agent-auth.service.js';
import { EventEmitter } from 'node:events';

const serverId = randomUUID();
const frame = (overrides: Record<string, unknown> = {}) => ({
  protocolVersion: '1',
  type: 'HEARTBEAT',
  messageId: randomUUID(),
  gameServerId: serverId,
  occurredAt: '2026-10-01T12:00:00.000Z',
  payload: { gameProcessState: 'RUNNING', skseReady: true },
  ...overrides,
});
const hello = (overrides: Record<string, unknown> = {}) => ({
  credentialId: randomUUID(),
  credentialSecret: generateAgentSecret(),
  agentVersion: '1.4.2',
  capabilities: ['BRIDGE_PING', 'SERVER_START'],
  gameProcessState: 'STOPPED',
  skseReady: false,
  ...overrides,
});
const reason = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof AgentProtocolError ? error.reason : 'OTHER';
  }
  return 'ACCEPTED';
};
const socket = () => {
  const value = {
    readyState: 1,
    OPEN: 1,
    send: jest.fn(),
    close: jest.fn(),
  };
  return value as typeof value & AgentSocket;
};
const snapshot = (
  overrides: Partial<AgentSessionSnapshot> = {},
): AgentSessionSnapshot => ({
  connectionId: randomUUID(),
  gameServerId: serverId,
  credentialId: randomUUID(),
  agentVersion: '1.0.0',
  capabilities: ['BRIDGE_PING'],
  runtime: { gameProcessState: G.STOPPED, skseReady: false },
  connectedAt: new Date(0),
  lastHeartbeatAt: new Date(0),
  ...overrides,
});

describe('Host Agent credential secrets', () => {
  it('generates 256-bit base64url secrets and stores only a SHA-256 digest', () => {
    const secrets = new Set(
      Array.from({ length: 64 }, () => generateAgentSecret()),
    );
    expect(secrets.size).toBe(64);
    for (const secret of secrets) {
      expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(secret, 'base64url')).toHaveLength(AGENT_SECRET_BYTES);
    }
    const secret = generateAgentSecret();
    const hash = agentSecretHash(secret);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(secret);
    expect(agentSecretMatches(secret, hash)).toBe(true);
    expect(agentSecretMatches(generateAgentSecret(), hash)).toBe(false);
    // Malformed stored values never match (and never throw).
    expect(agentSecretMatches(secret, 'not-hex')).toBe(false);
    expect(agentSecretMatches(secret, '')).toBe(false);
    expect(MAX_ACTIVE_AGENT_CREDENTIALS).toBe(2);
  });
});

describe('Host Agent protocol v1', () => {
  it('parses a closed envelope and copies it', () => {
    const raw = frame();
    const parsed = parseEnvelope(JSON.stringify(raw));
    expect(parsed).toEqual(raw);
    expect(parsed.payload).not.toBe(raw.payload);
    expect(
      parseEnvelope(
        JSON.stringify(frame({ gameServerId: serverId.toUpperCase() })),
      ).gameServerId,
    ).toBe(serverId);
  });
  it('rejects malformed frames and reports a wrong version separately', () => {
    expect(reason(() => parseEnvelope('not json'))).toBe('PROTOCOL_ERROR');
    for (const bad of [
      [],
      null,
      'text',
      frame({ extra: true }),
      frame({ payload: [] }),
      frame({ payload: null }),
      frame({ messageId: 'x' }),
      frame({ gameServerId: 'x' }),
      frame({ occurredAt: '2026-10-01' }),
      frame({ occurredAt: 'yesterday' }),
      frame({ type: 7 }),
      frame({ protocolVersion: 1 }),
      frame({ payload: undefined }),
    ])
      expect(reason(() => parseEnvelope(JSON.stringify(bad)))).toBe(
        'PROTOCOL_ERROR',
      );
    for (const version of ['2', '0', '1.0', ''])
      expect(
        reason(() =>
          parseEnvelope(JSON.stringify(frame({ protocolVersion: version }))),
        ),
      ).toBe('PROTOCOL_UNSUPPORTED');
  });
  it('validates HELLO strictly: credential, version, capabilities and runtime', () => {
    const valid = hello();
    expect(helloPayload({ ...valid })).toEqual(valid);
    for (const bad of [
      hello({ extra: 1 }),
      hello({ credentialId: 'x' }),
      hello({ credentialSecret: 'short' }),
      hello({ credentialSecret: `${generateAgentSecret()}=` }),
      // A Staff/Player JWT is never an Agent credential.
      hello({ credentialSecret: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig' }),
      hello({ agentVersion: '' }),
      hello({ agentVersion: 'v 1' }),
      hello({ agentVersion: 'x'.repeat(65) }),
      hello({ capabilities: 'BRIDGE_PING' }),
      hello({ capabilities: ['bridge_ping'] }),
      hello({ capabilities: ['BRIDGE_PING', 'BRIDGE_PING'] }),
      hello({
        capabilities: Array.from(
          { length: MAX_AGENT_CAPABILITIES + 1 },
          (_, i) => `CAP_${i}`,
        ),
      }),
      hello({ gameProcessState: 'CRASHED' }),
      hello({ skseReady: 'true' }),
    ])
      expect(reason(() => helloPayload(bad))).toBe('PROTOCOL_ERROR');
    const { credentialSecret, ...missing } = valid;
    void credentialSecret;
    expect(reason(() => helloPayload(missing))).toBe('PROTOCOL_ERROR');
  });
  it('validates HEARTBEAT runtime and optional capabilities', () => {
    expect(
      heartbeatPayload({ gameProcessState: 'PAUSED', skseReady: false }),
    ).toEqual({ gameProcessState: G.PAUSED, skseReady: false });
    expect(
      heartbeatPayload({
        gameProcessState: 'RUNNING',
        skseReady: true,
        capabilities: ['CHARACTER_PROFILE_QUERY'],
      }),
    ).toEqual({
      gameProcessState: G.RUNNING,
      skseReady: true,
      capabilities: ['CHARACTER_PROFILE_QUERY'],
    });
    for (const bad of [
      {},
      { gameProcessState: 'RUNNING' },
      { gameProcessState: 'RUNNING', skseReady: true, connectionId: 'x' },
      { gameProcessState: 'RUNNING', skseReady: true, capabilities: ['a'] },
    ])
      expect(reason(() => heartbeatPayload(bad))).toBe('PROTOCOL_ERROR');
  });
  it('separates Agent connectivity from game readiness', () => {
    expect(Object.values(G)).toEqual([
      'UNKNOWN',
      'STOPPED',
      'STARTING',
      'RUNNING',
      'PAUSED',
      'STOPPING',
      'RESTARTING',
    ]);
    for (const state of Object.values(G)) {
      expect(
        isRuntimeReady({ gameProcessState: state, skseReady: false }),
      ).toBe(false);
      expect(isRuntimeReady({ gameProcessState: state, skseReady: true })).toBe(
        state === G.RUNNING,
      );
    }
  });
  it('sizes the frame limit for a maximal command result', () => {
    expect(MAX_AGENT_FRAME_BYTES).toBe(128 * 1024);
    expect(MAX_AGENT_FRAME_BYTES).toBeGreaterThan(
      MAX_COMMAND_RESULT_BYTES * 1.5,
    );
    expect(new Set(Object.values(AgentClose)).size).toBe(
      Object.keys(AgentClose).length,
    );
  });
});

const activate = (
  registry: AgentSessionRegistry,
  session: AgentSessionSnapshot,
  ws: AgentSocket,
) => {
  registry.begin(session, ws);
  return registry.activate(session.gameServerId, session.connectionId);
};
const outFrame = () =>
  ({
    protocolVersion: '1',
    type: 'HEARTBEAT_ACK',
    messageId: randomUUID(),
    gameServerId: serverId,
    occurredAt: new Date().toISOString(),
    payload: {},
  }) as AgentEnvelope<'HEARTBEAT_ACK'>;

describe('Host Agent session registry', () => {
  it('keeps AUTHENTICATING sessions out of every public read and send', () => {
    const registry = new AgentSessionRegistry();
    const ws = socket();
    const pending = snapshot({
      runtime: { gameProcessState: G.RUNNING, skseReady: true },
    });
    registry.begin(pending, ws);
    expect(registry.getSession(serverId)).toBeUndefined();
    expect(registry.isConnected(serverId)).toBe(false);
    expect(registry.isRuntimeReady(serverId)).toBe(false);
    expect(registry.supports(serverId, 'BRIDGE_PING')).toBe(false);
    expect(registry.send(serverId, pending.connectionId, outFrame())).toBe(
      false,
    );
    expect(
      registry.heartbeat(
        serverId,
        pending.connectionId,
        pending.runtime,
        new Date(),
      ),
    ).toBe(false);
    expect(registry.expired(new Date(10 ** 12), 1)).toEqual([]);
    expect(ws.send).not.toHaveBeenCalled();
    // Revocation and cleanup still reach it.
    expect(registry.byCredential(pending.credentialId)).toHaveLength(1);
    expect(registry.all()).toHaveLength(1);
    expect(registry.count()).toBe(1);
    expect(registry.activate(serverId, pending.connectionId)).toEqual({
      activated: true,
    });
    expect(registry.isRuntimeReady(serverId)).toBe(true);
    expect(registry.send(serverId, pending.connectionId, outFrame())).toBe(
      true,
    );
  });
  it('supersedes the ACTIVE session only when the new one is promoted', () => {
    const registry = new AgentSessionRegistry();
    const [a, b] = [socket(), socket()];
    const first = snapshot();
    expect(activate(registry, first, a)).toEqual({ activated: true });
    expect(registry.getSession(serverId)).toEqual(first);
    const second = snapshot();
    registry.begin(second, b);
    // A newer attempt that is still authenticating displaces nothing.
    expect(a.close).not.toHaveBeenCalled();
    expect(registry.getSession(serverId)?.connectionId).toBe(
      first.connectionId,
    );
    // An abandoned attempt leaves the ACTIVE session untouched.
    expect(registry.remove(serverId, second.connectionId)).toBe(true);
    expect(registry.activate(serverId, second.connectionId)).toEqual({
      activated: false,
    });
    expect(a.close).not.toHaveBeenCalled();
    expect(registry.getSession(serverId)?.connectionId).toBe(
      first.connectionId,
    );
    const third = snapshot();
    registry.begin(third, b);
    const promoted = registry.activate(serverId, third.connectionId);
    expect(promoted.activated).toBe(true);
    expect(promoted.superseded?.connectionId).toBe(first.connectionId);
    expect(a.close).toHaveBeenCalledWith(AgentClose.SUPERSEDED, 'SUPERSEDED');
    // Stale removals never evict the newer session.
    expect(registry.remove(serverId, first.connectionId)).toBe(false);
    expect(registry.getSession(serverId)?.connectionId).toBe(
      third.connectionId,
    );
    expect(registry.count()).toBe(1);
    // Activation checks the server of the pending session.
    const foreign = snapshot();
    registry.begin(foreign, socket());
    expect(registry.activate(randomUUID(), foreign.connectionId)).toEqual({
      activated: false,
    });
  });
  it('sends only to the exact open ACTIVE session and exposes readiness and capabilities', () => {
    const registry = new AgentSessionRegistry();
    const ws = socket();
    const session = snapshot();
    activate(registry, session, ws);
    const out = outFrame();
    expect(registry.send(serverId, randomUUID(), out)).toBe(false);
    expect(registry.send(serverId, session.connectionId, out)).toBe(true);
    expect(JSON.parse(ws.send.mock.calls[0][0] as string)).toEqual(out);
    expect(registry.isRuntimeReady(serverId)).toBe(false);
    expect(registry.supports(serverId, 'BRIDGE_PING')).toBe(true);
    const at = new Date(5000);
    registry.heartbeat(
      serverId,
      session.connectionId,
      {
        gameProcessState: G.RUNNING,
        skseReady: true,
        capabilities: ['SERVER_START'],
      },
      at,
    );
    expect(registry.isRuntimeReady(serverId)).toBe(true);
    expect(registry.supports(serverId, 'BRIDGE_PING')).toBe(false);
    expect(registry.getSession(serverId)?.lastHeartbeatAt).toEqual(at);
    // Snapshots are frozen: callers cannot mutate the registry.
    expect(() => {
      (registry.getSession(serverId)!.capabilities as string[]).length = 0;
    }).toThrow(TypeError);
    expect(registry.supports(serverId, 'SERVER_START')).toBe(true);
    const closed = { ...socket(), readyState: 3 } as AgentSocket;
    activate(registry, snapshot({ connectionId: 'c2' }), closed);
    expect(registry.send(serverId, 'c2', out)).toBe(false);
  });
  it('finds expired and per-credential sessions and terminates ACTIVE or AUTHENTICATING ones', () => {
    const registry = new AgentSessionRegistry();
    const [a, b, c] = [socket(), socket(), socket()];
    const credentialId = randomUUID();
    const old = snapshot({ credentialId, lastHeartbeatAt: new Date(1000) });
    const other = snapshot({
      gameServerId: randomUUID(),
      lastHeartbeatAt: new Date(9000),
    });
    activate(registry, old, a);
    activate(registry, other, b);
    const pending = snapshot({
      credentialId,
      gameServerId: other.gameServerId,
    });
    registry.begin(pending, c);
    expect(
      registry.expired(new Date(10000), 5000).map((s) => s.connectionId),
    ).toEqual([old.connectionId]);
    expect(registry.expired(new Date(6000), 5000)).toHaveLength(1);
    expect(registry.expired(new Date(5999), 5000)).toHaveLength(0);
    expect(registry.byCredential(credentialId)).toHaveLength(2);
    for (const target of [old, pending]) {
      expect(
        registry.terminate(
          target.gameServerId,
          target.connectionId,
          'CREDENTIAL_REVOKED',
        ),
      ).toBe(true);
      expect(
        registry.terminate(
          target.gameServerId,
          target.connectionId,
          'CREDENTIAL_REVOKED',
        ),
      ).toBe(false);
    }
    for (const closedSocket of [a, c])
      expect(closedSocket.close).toHaveBeenCalledWith(
        AgentClose.CREDENTIAL_REVOKED,
        'CREDENTIAL_REVOKED',
      );
    expect(
      registry.activate(pending.gameServerId, pending.connectionId),
    ).toEqual({ activated: false });
    expect(registry.all().map((s) => s.connectionId)).toEqual([
      other.connectionId,
    ]);
  });
});

// Internal seam: a socket double driven like ws, and an auth service whose
// commit and revalidation phases the test resolves by hand.
class FakeAgentSocket extends EventEmitter {
  readyState = 1;
  readonly OPEN = 1;
  readonly sent: Record<string, unknown>[] = [];
  readonly closes: { code: number; reason: string }[] = [];
  onClose?: () => void;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code: number, reason: string) {
    if (this.readyState !== 1) return;
    this.onClose?.();
    this.readyState = 3;
    this.closes.push({ code, reason });
    queueMicrotask(() => this.emit('close', code));
  }
  // The peer goes away.
  drop() {
    this.readyState = 3;
    this.emit('close', 1006);
  }
  frame(value: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(value)), false);
  }
}
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 10; i++)
    await new Promise((resolve) => setImmediate(resolve));
};
type Verdict = Awaited<ReturnType<AgentAuthService['eligible']>>;

describe('Host Agent gateway: HELLO commit vs registry visibility', () => {
  const key = { credentialId: randomUUID(), secret: generateAgentSecret() };
  const setup = () => {
    const registry = new AgentSessionRegistry();
    const clock = { now: () => new Date() } as BridgeClock;
    const auth = {
      authenticate: jest.fn<AgentAuthService['authenticate']>(),
      eligible: jest.fn<AgentAuthService['eligible']>(async () => 'ELIGIBLE'),
      stillConnected: jest.fn<AgentAuthService['stillConnected']>(
        async () => true,
      ),
    };
    const connections = {
      end: jest.fn(async () => true),
      endAllActive: jest.fn(async () => 0),
      heartbeat: jest.fn(async () => true),
    };
    const gateway = new AgentGateway(
      { register: jest.fn() } as never,
      auth as unknown as AgentAuthService,
      new AgentMessageRouter(
        connections as never,
        registry,
        { acknowledge: jest.fn(), result: jest.fn() } as never,
        { result: jest.fn() } as never,
        { event: jest.fn(), sync: jest.fn() } as never,
        clock,
      ),
      registry,
      connections as never,
      clock,
      {
        get: () => ({
          security: {
            agent: {
              maxPendingConnections: 32,
              maxConcurrentAuth: 8,
              connectsPerIpPerMinute: 30,
              authFailuresPerIpPerMinute: 10,
            },
          },
          agent: {
            authTimeoutMs: 5000,
            heartbeatIntervalMs: 1000,
            heartbeatTimeoutMs: 3000,
            messageRateLimitCount: 200,
            messageRateLimitWindowMs: 10000,
          },
        }),
      } as never,
      { changed: jest.fn(async () => undefined) } as never,
      { of: () => '127.0.0.1' } as never,
      new MemoryRateLimiter(),
      new ConcurrencyLimiter(),
      new SecurityLog(),
    );
    const connect = () => {
      const ws = new FakeAgentSocket();
      (
        gateway as unknown as { connect(ws: unknown, ip: string): void }
      ).connect(ws, '127.0.0.1');
      ws.frame(
        frame({
          type: 'HELLO',
          payload: hello({
            credentialId: key.credentialId,
            credentialSecret: key.secret,
          }),
        }),
      );
      return ws;
    };
    const row = () => {
      const now = new Date();
      return { id: randomUUID(), connectedAt: now, lastHeartbeatAt: now };
    };
    // An ACTIVE session A, through the real HELLO path.
    const established = async () => {
      const committed = row();
      auth.authenticate.mockResolvedValueOnce(committed as never);
      const ws = connect();
      await flush();
      expect(registry.getSession(serverId)?.connectionId).toBe(committed.id);
      return { ws, connectionId: committed.id };
    };
    return { registry, auth, connections, connect, row, established, gateway };
  };
  const authenticatedFrames = (ws: FakeAgentSocket) =>
    ws.sent.filter((m) => m.type === 'AUTHENTICATED');

  it('drains the heartbeat sweep on shutdown and closes sessions as SHUTDOWN afterwards (12.2)', async () => {
    const { gateway, connections, established } = setup();
    const { ws } = await established();
    const sweep = deferred<number>();
    const expire = jest
      .spyOn(gateway, 'expire')
      .mockReturnValueOnce(sweep.promise);
    void (gateway as unknown as { sweepOnce(): Promise<void> }).sweepOnce();
    let drained = false;
    const destroying = gateway.onModuleDestroy().then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(false);
    sweep.resolve(0);
    await destroying;
    expect(drained).toBe(true);
    // No new sweep once stopping.
    await (gateway as unknown as { sweepOnce(): Promise<void> }).sweepOnce();
    expect(expire).toHaveBeenCalledTimes(1);
    // Phase 2 persists SHUTDOWN (not STALE) and closes with 1001.
    await gateway.beforeApplicationShutdown();
    expect(connections.end).toHaveBeenCalledWith(
      serverId,
      expect.any(String),
      'SHUTDOWN',
    );
    expect(ws.closes).toContainEqual({ code: 1001, reason: 'SHUTDOWN' });
  });
  it('refuses HELLO verification beyond the concurrent cap with AUTH_BUSY (12.1)', async () => {
    const { auth, connect, row } = setup();
    const running = Array.from({ length: 8 }, () => deferred<never>());
    for (const verification of running)
      auth.authenticate.mockReturnValueOnce(verification.promise);
    for (let i = 0; i < running.length; i++) connect();
    await flush();
    const extra = connect();
    await flush();
    expect(extra.closes).toEqual([{ code: 4013, reason: 'AUTH_BUSY' }]);
    expect(auth.authenticate).toHaveBeenCalledTimes(8);
    // A slot frees as soon as a verification ends.
    running[0].resolve(row() as never);
    await flush();
    auth.authenticate.mockResolvedValueOnce(row() as never);
    const next = connect();
    await flush();
    expect(next.closes).toEqual([]);
    expect(authenticatedFrames(next)).toHaveLength(1);
  });
  it('publishes nothing while the HELLO transaction has not committed', async () => {
    const { registry, auth, connect, row } = setup();
    const commit = deferred<never>();
    auth.authenticate.mockReturnValueOnce(commit.promise);
    const ws = connect();
    await flush();
    expect(registry.isConnected(serverId)).toBe(false);
    expect(registry.getSession(serverId)).toBeUndefined();
    expect(registry.count()).toBe(0);
    expect(ws.sent).toEqual([]);
    const committed = row();
    commit.resolve(committed as never);
    await flush();
    expect(registry.getSession(serverId)?.connectionId).toBe(committed.id);
    expect(authenticatedFrames(ws)).toHaveLength(1);
  });
  it('is not public between commit and promotion either', async () => {
    const { registry, auth, connect, row } = setup();
    const committed = row();
    auth.authenticate.mockResolvedValueOnce(committed as never);
    const verdict = deferred<Verdict>();
    auth.eligible.mockReturnValueOnce(verdict.promise);
    const ws = connect();
    await flush();
    // AUTHENTICATING: reachable by revocation only.
    expect(registry.isConnected(serverId)).toBe(false);
    expect(registry.byCredential(key.credentialId)).toHaveLength(1);
    expect(
      registry.send(serverId, committed.id, {
        ...frame(),
        type: 'HEARTBEAT_ACK',
      } as AgentEnvelope<'HEARTBEAT_ACK'>),
    ).toBe(false);
    expect(ws.sent).toEqual([]);
    verdict.resolve('ELIGIBLE');
    await flush();
    expect(registry.isConnected(serverId)).toBe(true);
    expect(authenticatedFrames(ws)).toHaveLength(1);
  });
  it('rolls back without trace and never disturbs the ACTIVE session', async () => {
    const { registry, auth, connect, established } = setup();
    const a = await established();
    for (const failure of [new Error('rollback'), new Error('deadlock')]) {
      auth.authenticate.mockRejectedValueOnce(failure);
      const b = connect();
      await flush();
      expect(b.closes).toEqual([{ code: 4001, reason: 'UNAUTHORIZED' }]);
      expect(b.sent).toEqual([]);
    }
    expect(auth.eligible).toHaveBeenCalledTimes(1); // only A's
    expect(a.ws.closes).toEqual([]);
    expect(registry.getSession(serverId)?.connectionId).toBe(a.connectionId);
    expect(registry.count()).toBe(1);
  });
  it('closes the previous session as SUPERSEDED only after the new one is ACTIVE', async () => {
    const { registry, auth, connect, row, established } = setup();
    const a = await established();
    let activeWhenClosed: string | undefined;
    a.ws.onClose = () =>
      (activeWhenClosed = registry.getSession(serverId)?.connectionId);
    const committed = row();
    auth.authenticate.mockResolvedValueOnce(committed as never);
    const verdict = deferred<Verdict>();
    auth.eligible.mockReturnValueOnce(verdict.promise);
    const b = connect();
    await flush();
    // B committed but is not promoted: A still serves and is not closed.
    expect(a.ws.closes).toEqual([]);
    expect(registry.getSession(serverId)?.connectionId).toBe(a.connectionId);
    verdict.resolve('ELIGIBLE');
    await flush();
    expect(a.ws.closes).toEqual([{ code: 4006, reason: 'SUPERSEDED' }]);
    expect(activeWhenClosed).toBe(committed.id);
    expect(registry.getSession(serverId)?.connectionId).toBe(committed.id);
    expect(authenticatedFrames(b)).toHaveLength(1);
    expect(registry.count()).toBe(1);
  });
  it('never activates a session whose credential is revoked between commit and promotion', async () => {
    const { registry, auth, connect, row, established } = setup();
    const a = await established();
    // Revoked before the revalidation read: refused, and A (whose row the
    // committed HELLO had already superseded) is closed with it.
    auth.authenticate.mockResolvedValueOnce(row() as never);
    auth.eligible.mockResolvedValueOnce('CREDENTIAL_REVOKED');
    auth.stillConnected.mockResolvedValueOnce(false);
    const b = connect();
    await flush();
    expect(b.closes).toEqual([{ code: 4009, reason: 'CREDENTIAL_REVOKED' }]);
    expect(authenticatedFrames(b)).toEqual([]);
    expect(a.ws.closes).toEqual([{ code: 4006, reason: 'SUPERSEDED' }]);
    expect(registry.count()).toBe(0);
    // Revoked while the revalidation is in flight: the revocation closes the
    // AUTHENTICATING session and the promotion finds nothing to activate.
    const committed = row();
    auth.authenticate.mockResolvedValueOnce(committed as never);
    const verdict = deferred<Verdict>();
    auth.eligible.mockReturnValueOnce(verdict.promise);
    const c = connect();
    await flush();
    for (const session of registry.byCredential(key.credentialId))
      registry.terminate(
        session.gameServerId,
        session.connectionId,
        'CREDENTIAL_REVOKED',
      );
    verdict.resolve('ELIGIBLE');
    await flush();
    expect(c.closes).toEqual([{ code: 4009, reason: 'CREDENTIAL_REVOKED' }]);
    expect(authenticatedFrames(c)).toEqual([]);
    expect(registry.isConnected(serverId)).toBe(false);
    expect(registry.count()).toBe(0);
  });
  it('keeps a still-valid previous session when the new one is refused after commit', async () => {
    const { registry, auth, connect, row, established } = setup();
    const a = await established();
    auth.authenticate.mockResolvedValueOnce(row() as never);
    auth.eligible.mockResolvedValueOnce('SUPERSEDED');
    const b = connect();
    await flush();
    expect(b.closes).toEqual([{ code: 4006, reason: 'SUPERSEDED' }]);
    expect(a.ws.closes).toEqual([]);
    expect(registry.getSession(serverId)?.connectionId).toBe(a.connectionId);
  });
  it('leaves no ACTIVE or orphan session when the socket closes during authentication', async () => {
    const { registry, auth, connections, connect, row } = setup();
    // Before commit.
    const commit = deferred<never>();
    auth.authenticate.mockReturnValueOnce(commit.promise);
    const early = connect();
    await flush();
    early.drop();
    const first = row();
    commit.resolve(first as never);
    await flush();
    expect(connections.end).toHaveBeenCalledWith(serverId, first.id, 'CLOSED');
    expect(auth.eligible).not.toHaveBeenCalled();
    expect(registry.count()).toBe(0);
    // Between commit and promotion.
    const second = row();
    auth.authenticate.mockResolvedValueOnce(second as never);
    const verdict = deferred<Verdict>();
    auth.eligible.mockReturnValueOnce(verdict.promise);
    const late = connect();
    await flush();
    late.drop();
    verdict.resolve('ELIGIBLE');
    await flush();
    expect(connections.end).toHaveBeenCalledWith(serverId, second.id, 'CLOSED');
    expect(registry.count()).toBe(0);
    expect(authenticatedFrames(early)).toEqual([]);
    expect(authenticatedFrames(late)).toEqual([]);
  });
  it('promotes concurrent HELLOs in commit order: the newest committed wins', async () => {
    const { registry, auth, connect, row } = setup();
    const [first, second] = [row(), row()];
    const firstVerdict = deferred<Verdict>();
    auth.authenticate
      .mockResolvedValueOnce(first as never)
      .mockResolvedValueOnce(second as never);
    // The older one's revalidation is slow; the newer one must wait for it.
    auth.eligible
      .mockReturnValueOnce(firstVerdict.promise)
      .mockResolvedValueOnce('ELIGIBLE');
    const a = connect();
    const b = connect();
    await flush();
    expect(registry.isConnected(serverId)).toBe(false);
    firstVerdict.resolve('SUPERSEDED');
    await flush();
    expect(a.closes).toEqual([{ code: 4006, reason: 'SUPERSEDED' }]);
    expect(registry.getSession(serverId)?.connectionId).toBe(second.id);
    expect(authenticatedFrames(b)).toHaveLength(1);
    expect(registry.count()).toBe(1);
  });
});

describe('Host Agent message router', () => {
  const setup = (alive = true) => {
    const heartbeat = jest.fn(async () => alive);
    const connections = { heartbeat } as unknown as GameConnectionService;
    const registry = new AgentSessionRegistry();
    const clock = { now: () => new Date('2026-10-01T12:00:05.000Z') };
    const commands = {
      acknowledge: jest.fn(async () => ({})),
      result: jest.fn(async () => ({ close: 'SESSION_CLOSED' as const })),
    };
    const serverControl = {
      result: jest.fn(async () => ({ close: 'SERVER_MISMATCH' as const })),
    };
    const domain = {
      event: jest.fn(async () => ({ close: 'SERVER_MISMATCH' as const })),
      sync: jest.fn(async () => ({})),
    };
    const router = new AgentMessageRouter(
      connections,
      registry,
      commands as never,
      serverControl as never,
      domain as never,
      clock as BridgeClock,
    );
    const session = snapshot();
    activate(registry, session, socket());
    return {
      router,
      session,
      heartbeat,
      registry,
      commands,
      serverControl,
      domain,
    };
  };
  const envelope = (overrides: Record<string, unknown> = {}) =>
    parseEnvelope(JSON.stringify(frame(overrides)));
  it('handles HEARTBEAT through the Game Bridge session and acknowledges it', async () => {
    const { router, session, heartbeat, registry } = setup();
    const message = envelope({
      payload: {
        gameProcessState: 'RUNNING',
        skseReady: true,
        capabilities: ['BRIDGE_PING'],
      },
    });
    const outcome = await router.route(session, message);
    expect(heartbeat).toHaveBeenCalledWith(serverId, session.connectionId, {
      gameProcessState: G.RUNNING,
      skseReady: true,
      capabilities: ['BRIDGE_PING'],
    });
    expect(outcome.close).toBeUndefined();
    expect(outcome.reply).toMatchObject({
      protocolVersion: '1',
      type: 'HEARTBEAT_ACK',
      gameServerId: serverId,
      payload: {
        inReplyTo: message.messageId,
        serverTime: '2026-10-01T12:00:05.000Z',
      },
    });
    expect(registry.isRuntimeReady(serverId)).toBe(true);
  });
  it('closes when the database no longer considers the session alive', async () => {
    const { router, session } = setup(false);
    expect(await router.route(session, envelope())).toEqual({
      close: 'SESSION_CLOSED',
    });
  });
  it('rejects cross-server frames, protocol violations and malformed heartbeats', async () => {
    const { router, session, heartbeat } = setup();
    expect(
      await router.route(session, envelope({ gameServerId: randomUUID() })),
    ).toEqual({ close: 'SERVER_MISMATCH' });
    for (const type of [
      'HELLO',
      'WORK_ITEMS',
      'DOMAIN_EVENT_ACK',
      'COMMAND',
      'AUTHENTICATED',
      'RAW',
    ])
      expect(await router.route(session, envelope({ type }))).toEqual({
        close: 'PROTOCOL_ERROR',
      });
    expect(
      await router.route(session, envelope({ payload: { skseReady: true } })),
    ).toEqual({ close: 'PROTOCOL_ERROR' });
    expect(heartbeat).not.toHaveBeenCalled();
  });
  it('hands COMMAND_ACK and COMMAND_RESULT to the GameCommand adapter with the session', async () => {
    const { router, session, commands, heartbeat } = setup();
    const ack = envelope({ type: 'COMMAND_ACK', payload: { any: 1 } });
    expect(await router.route(session, ack)).toEqual({});
    expect(commands.acknowledge).toHaveBeenCalledWith(session, ack);
    const result = envelope({ type: 'COMMAND_RESULT', payload: { any: 1 } });
    expect(await router.route(session, result)).toEqual({
      close: 'SESSION_CLOSED',
    });
    expect(commands.result).toHaveBeenCalledWith(session, result);
    // The server check still comes first.
    await router.route(
      session,
      envelope({ type: 'COMMAND_RESULT', gameServerId: randomUUID() }),
    );
    expect(commands.result).toHaveBeenCalledTimes(1);
    expect(heartbeat).not.toHaveBeenCalled();
  });
  it('delegates SERVER_CONTROL_RESULT to the Server Control adapter only', async () => {
    const { router, session, commands, serverControl } = setup();
    const result = envelope({
      type: 'SERVER_CONTROL_RESULT',
      payload: { any: 1 },
    });
    expect(await router.route(session, result)).toEqual({
      close: 'SERVER_MISMATCH',
    });
    expect(serverControl.result).toHaveBeenCalledWith(session, result);
    expect(commands.result).not.toHaveBeenCalled();
    await router.route(
      session,
      envelope({ type: 'SERVER_CONTROL_RESULT', gameServerId: randomUUID() }),
    );
    expect(serverControl.result).toHaveBeenCalledTimes(1);
  });
  it('hands DOMAIN_EVENT and WORK_SYNC to the domain adapter and accepts Agent ERROR frames', async () => {
    const { router, session, heartbeat, domain, commands } = setup();
    const event = envelope({ type: 'DOMAIN_EVENT', payload: { any: 1 } });
    expect(await router.route(session, event)).toEqual({
      close: 'SERVER_MISMATCH',
    });
    expect(domain.event).toHaveBeenCalledWith(session, event);
    const sync = envelope({ type: 'WORK_SYNC', payload: {} });
    expect(await router.route(session, sync)).toEqual({});
    expect(domain.sync).toHaveBeenCalledWith(session, sync);
    // The server check still comes first.
    await router.route(
      session,
      envelope({ type: 'DOMAIN_EVENT', gameServerId: randomUUID() }),
    );
    expect(domain.event).toHaveBeenCalledTimes(1);
    expect(commands.result).not.toHaveBeenCalled();
    expect(await router.route(session, envelope({ type: 'ERROR' }))).toEqual(
      {},
    );
    expect(heartbeat).not.toHaveBeenCalled();
  });
});

describe('WebSocket upgrade routing', () => {
  const routes = new Map([
    [REALTIME_PATH, 'realtime'],
    [AGENT_PATH, 'agent'],
  ]);
  it('routes exact paths to one surface and refuses anything else', () => {
    expect(resolveUpgrade('/api/v1/realtime', routes)).toBe('realtime');
    expect(resolveUpgrade('/api/v1/agent', routes)).toBe('agent');
    for (const url of [
      '/api/v1/agent?secret=x',
      '/api/v1/realtime?token=x',
      '/api/v1/agent/',
      '/api/v1/Agent',
      '/api/v1/other',
      '/',
      undefined,
    ])
      expect(resolveUpgrade(url, routes)).toBeUndefined();
  });
  it('owns the single upgrade listener and rejects unknown paths with 400', () => {
    const listeners = new Map<string, unknown>();
    const server = {
      on: jest.fn((event: string, fn: unknown) => listeners.set(event, fn)),
      off: jest.fn((event: string) => listeners.delete(event)),
    };
    const router = new WebSocketUpgradeRouter({
      httpAdapter: { getHttpServer: () => server },
    } as unknown as HttpAdapterHost);
    const agent = jest.fn();
    router.register(AGENT_PATH, agent);
    expect(() => router.register(AGENT_PATH, jest.fn())).toThrow(
      'already registered',
    );
    router.onApplicationBootstrap();
    expect(server.on).toHaveBeenCalledTimes(1);
    const duplex = { write: jest.fn(), destroy: jest.fn() };
    const head = Buffer.alloc(0);
    router.upgrade(
      { url: AGENT_PATH } as IncomingMessage,
      duplex as unknown as Duplex,
      head,
    );
    expect(agent).toHaveBeenCalledTimes(1);
    expect(duplex.destroy).not.toHaveBeenCalled();
    router.upgrade(
      { url: '/api/v1/unknown' } as IncomingMessage,
      duplex as unknown as Duplex,
      head,
    );
    expect(duplex.write).toHaveBeenCalledWith(
      expect.stringContaining('400 Bad Request'),
    );
    expect(duplex.destroy).toHaveBeenCalledTimes(1);
    router.onModuleDestroy();
    expect(listeners.size).toBe(0);
  });
});

describe('Host Agent boundaries', () => {
  const sources = (dir: string) =>
    globSync(fileURLToPath(new URL(`../${dir}/**/*.ts`, import.meta.url)))
      .filter((file) => !file.endsWith('.spec.ts'))
      .map((file) => ({ file, source: readFileSync(file, 'utf8') }));
  const imports = (source: string) =>
    [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  it('never reaches Player/Staff realtime, economy, VIP or process control', () => {
    for (const { source } of sources('game-agent'))
      for (const module of imports(source))
        expect(module).not.toMatch(
          /economy|vip-|character-management|moderation|world-management|realtime|socket\.io|electron|child_process/,
        );
  });
  it('reaches gameplay domains only through their Agent entry points and work projections', () => {
    const allowed: Record<string, RegExp> = {
      'agent-domain-events.service.ts':
        /(character-link\.service|profession-experience\.service|trade-settlement\.service|marketplace-(custody|settlement|release)\.service|player-trade\.contracts|player-marketplace\.contracts)\.js$/,
      'agent-work.service.ts': /(trade-work|marketplace-work)\.source\.js$/,
      'game-agent.module.ts':
        /(player-characters|professions|player-trades|player-marketplace)\.module\.js$/,
    };
    for (const { file, source } of sources('game-agent')) {
      const name = file.split('/').pop()!;
      for (const module of imports(source).filter((m) =>
        /player-|professions/.test(m),
      ))
        expect(module).toMatch(allowed[name] ?? /^$/);
      // No domain repository or entity is used by the Agent transport.
      expect(source).not.toMatch(
        /getRepository<Player(Trade|Marketplace|Character)|CharacterProfession'/,
      );
    }
  });
  it('reaches Server Control only through its gateway, result adapter and contracts', () => {
    const allowed: Record<string, RegExp> = {
      'agent-server-control.gateway.ts':
        /server-control\/(server-control-gateway|server-control\.contracts)\.js$/,
      'agent-server-control.adapter.ts':
        /server-control\/(server-control-receiver|server-control-rejection)\.js$/,
      'agent-capabilities.ts': /server-control\/server-control\.contracts\.js$/,
      'agent-session.registry.ts':
        /server-control\/server-control\.contracts\.js$/,
      'agent-protocol.contracts.ts':
        /server-control\/server-control\.contracts\.js$/,
      'game-agent.module.ts': /server-control\/server-control\.module\.js$/,
    };
    for (const { file, source } of sources('game-agent')) {
      const name = file.split('/').pop()!;
      for (const module of imports(source).filter((m) =>
        m.includes('server-control/'),
      ))
        expect(module).toMatch(allowed[name] ?? /^$/);
      // The Agent never creates an operation nor picks its action.
      expect(source).not.toMatch(
        /ServerControlService|ServerControlDispatcher/,
      );
    }
  });
  it('lets only the adapter and the worker use the command lifecycle, and nothing create commands', () => {
    for (const { file, source } of sources('game-agent')) {
      const pipeline = imports(source).filter((m) => /game-command-/.test(m));
      if (
        !file.endsWith('agent-command.adapter.ts') &&
        !file.endsWith('game-command.worker.ts')
      )
        expect(pipeline).toEqual([]);
      // The Agent can never submit (or choose the actor of) a GameCommand.
      expect(pipeline.filter((m) => /game-command-bus|actor/.test(m))).toEqual(
        [],
      );
      expect(source).not.toMatch(/GameCommandBus|ActorCommandService/);
    }
  });
  it('keeps the message router free of repositories and the database', () => {
    const [router] = sources('game-agent').filter(({ file }) =>
      file.endsWith('agent-message.router.ts'),
    );
    for (const module of imports(router.source))
      expect(module).not.toMatch(/typeorm|entities\//);
  });
  it('keeps the realtime surface independent of the Agent transport', () => {
    for (const { source } of sources('realtime'))
      for (const module of imports(source))
        expect(module).not.toMatch(/game-agent/);
  });
});

describe('GameCommand capabilities and the real Agent gateway', () => {
  const base = [
    'GAME_COMMAND_V1',
    'CHARACTER_INVENTORY_QUERY',
    'CHARACTER_ITEM_GIVE',
  ];
  it('classifies every command type once and gates mutations on the dedup journal', () => {
    expect(Object.keys(COMMAND_KINDS).sort()).toEqual(
      [...COMMAND_TYPES].sort(),
    );
    expect(
      COMMAND_TYPES.filter((type) => COMMAND_KINDS[type] === 'QUERY').sort(),
    ).toEqual(
      [
        'BRIDGE_PING',
        'CHARACTER_FACTIONS_QUERY',
        'CHARACTER_HOLDS_QUERY',
        'CHARACTER_HORSES_QUERY',
        'CHARACTER_INVENTORY_QUERY',
        'CHARACTER_PROFILE_QUERY',
        'CHARACTER_PROPERTIES_QUERY',
        'CHARACTER_SKILLS_QUERY',
        'WORLD_STATE_QUERY',
      ].sort(),
    );
    expect(supportsCommand(base, 'CHARACTER_INVENTORY_QUERY')).toBe(true);
    expect(supportsCommand(base, 'CHARACTER_ITEM_GIVE')).toBe(false);
    expect(
      supportsCommand(
        [...base, COMMAND_DEDUP_CAPABILITY],
        'CHARACTER_ITEM_GIVE',
      ),
    ).toBe(true);
    // No protocol capability, or no type capability: nothing.
    expect(supportsCommand(base.slice(1), 'CHARACTER_INVENTORY_QUERY')).toBe(
      false,
    );
    expect(supportsCommand([GAME_COMMAND_CAPABILITY], 'BRIDGE_PING')).toBe(
      false,
    );
    expect(
      supportedCommandTypes([
        ...base,
        COMMAND_DEDUP_CAPABILITY,
        'UNKNOWN_THING',
      ]),
    ).toEqual(['CHARACTER_INVENTORY_QUERY', 'CHARACTER_ITEM_GIVE']);
    // Every capability fits the HELLO limits.
    expect(COMMAND_TYPES.length + 2).toBeLessThanOrEqual(
      MAX_AGENT_CAPABILITIES,
    );
  });
  const setup = (
    runtime = { gameProcessState: G.RUNNING, skseReady: true },
  ) => {
    const registry = new AgentSessionRegistry();
    const ws = socket();
    const session = snapshot({
      capabilities: [...base, COMMAND_DEDUP_CAPABILITY],
      runtime,
    });
    activate(registry, session, ws);
    const gateway = new AgentGameGateway(registry, {
      now: () => new Date('2026-10-01T12:00:00.000Z'),
    } as BridgeClock);
    const connection = {
      id: session.connectionId,
      gameServerId: serverId,
      externalConnectionId: 'x',
    };
    const envelope = {
      protocolVersion: '1',
      commandId: randomUUID(),
      correlationId: randomUUID(),
      serverId,
      connectionId: session.connectionId,
      attempt: 2,
      idempotencyKey: 'caller-key',
      type: 'CHARACTER_ITEM_GIVE',
      payload: { characterId: 'c', itemId: 'i', quantity: 1 },
      issuedAt: '2026-10-01T11:59:00.000Z',
      ackDeadlineAt: '2026-10-01T12:00:05.000Z',
      executionDeadlineAt: '2026-10-01T12:00:30.000Z',
    } as CommandEnvelope;
    const signal = new AbortController().signal;
    return { registry, ws, session, gateway, connection, envelope, signal };
  };
  it('sends a typed COMMAND to exactly the reserved session, without backend internals', async () => {
    const { ws, gateway, connection, envelope, signal } = setup();
    expect(await gateway.send(connection, envelope, signal)).toEqual({
      accepted: true,
    });
    const frame = JSON.parse(ws.send.mock.calls[0][0] as string);
    expect(frame).toMatchObject({
      protocolVersion: '1',
      type: 'COMMAND',
      gameServerId: serverId,
      payload: {
        commandId: envelope.commandId,
        correlationId: envelope.correlationId,
        attempt: 2,
        type: 'CHARACTER_ITEM_GIVE',
        payload: envelope.payload,
        issuedAt: envelope.issuedAt,
        ackDeadlineAt: envelope.ackDeadlineAt,
        executionDeadlineAt: envelope.executionDeadlineAt,
      },
    });
    expect(Object.keys(frame.payload)).not.toContain('idempotencyKey');
  });
  it('reports proven non-delivery when the session, runtime or capability changed after the reservation', async () => {
    const { registry, ws, session, gateway, connection, envelope, signal } =
      setup();
    // Another session now owns the server: never redirected there.
    const other = snapshot({
      capabilities: [...base, COMMAND_DEDUP_CAPABILITY],
      runtime: session.runtime,
    });
    const otherSocket = socket();
    activate(registry, other, otherSocket);
    expect(await gateway.send(connection, envelope, signal)).toEqual({
      accepted: false,
      reason: 'UNAVAILABLE',
    });
    expect(otherSocket.send).not.toHaveBeenCalled();
    // Runtime dropped between reserve and send.
    const dropped = setup();
    dropped.registry.heartbeat(
      serverId,
      dropped.session.connectionId,
      { gameProcessState: G.RUNNING, skseReady: false },
      new Date(),
    );
    expect(
      await dropped.gateway.send(dropped.connection, dropped.envelope, signal),
    ).toMatchObject({ accepted: false, reason: 'UNAVAILABLE' });
    // Capability withdrawn (no journal any more) for a mutation.
    const withdrawn = setup();
    withdrawn.registry.heartbeat(
      serverId,
      withdrawn.session.connectionId,
      { gameProcessState: G.RUNNING, skseReady: true, capabilities: base },
      new Date(),
    );
    expect(
      await withdrawn.gateway.send(
        withdrawn.connection,
        withdrawn.envelope,
        signal,
      ),
    ).toMatchObject({ accepted: false, reason: 'UNAVAILABLE' });
    // Aborted before sending, or the session is gone altogether.
    const controller = new AbortController();
    controller.abort();
    const aborted = setup();
    expect(
      await aborted.gateway.send(
        aborted.connection,
        aborted.envelope,
        controller.signal,
      ),
    ).toMatchObject({ accepted: false });
    aborted.registry.remove(serverId, aborted.session.connectionId);
    expect(
      await aborted.gateway.send(aborted.connection, aborted.envelope, signal),
    ).toMatchObject({ accepted: false, reason: 'UNAVAILABLE' });
    for (const target of [ws, dropped.ws, withdrawn.ws, aborted.ws])
      expect(target.send).not.toHaveBeenCalled();
  });
});

describe('Server Control capabilities, protocol and the real Agent gateway', () => {
  const caps = [SERVER_CONTROL_CAPABILITY, 'SERVER_START', 'SERVER_RESTART'];
  it('requires the protocol capability and the exact action capability', () => {
    expect(supportsServerControl(caps, 'SERVER_START')).toBe(true);
    expect(supportsServerControl(caps, 'SERVER_PAUSE')).toBe(false);
    expect(supportsServerControl(caps.slice(1), 'SERVER_START')).toBe(false);
    // GameCommand capabilities grant nothing here.
    expect(
      supportsServerControl(
        ['GAME_COMMAND_V1', 'COMMAND_DEDUP_V1', 'SERVER_START'],
        'SERVER_START',
      ),
    ).toBe(false);
  });
  it('parses a closed SERVER_CONTROL_RESULT and refuses anything else', () => {
    const ids = {
      operationId: randomUUID(),
      correlationId: randomUUID(),
      type: 'SERVER_START',
    };
    expect(
      serverControlResultPayload({ ...ids, outcome: 'SUCCEEDED' }),
    ).toEqual({ ...ids, outcome: 'SUCCEEDED' });
    expect(
      serverControlResultPayload({
        ...ids,
        outcome: 'FAILED',
        errorCode: 'DELIVERY_EXPIRED',
        runtime: { gameProcessState: 'STOPPED', skseReady: false },
      }),
    ).toEqual({
      ...ids,
      outcome: 'FAILED',
      errorCode: 'DELIVERY_EXPIRED',
      runtime: { gameProcessState: G.STOPPED, skseReady: false },
    });
    expect(
      serverControlResultPayload({ ...ids, outcome: 'UNCERTAIN' }),
    ).toEqual({ ...ids, outcome: 'UNCERTAIN' });
    for (const payload of [
      { ...ids, outcome: 'TIMEOUT' },
      { ...ids, outcome: 'FAILED' },
      { ...ids, outcome: 'FAILED', errorCode: 'AGENT_UNAVAILABLE' },
      {
        ...ids,
        outcome: 'FAILED',
        errorCode: 'EXECUTION_FAILED',
        message: 'x',
      },
      { ...ids, outcome: 'SUCCEEDED', errorCode: 'EXECUTION_FAILED' },
      { ...ids, outcome: 'SUCCEEDED', stack: 'Error: at ...' },
      { ...ids, outcome: 'SUCCEEDED', command: 'shutdown -r' },
      { ...ids, type: 'SERVER_STOP', outcome: 'SUCCEEDED' },
      { ...ids, type: 'SHELL_COMMAND', outcome: 'SUCCEEDED' },
      { ...ids, operationId: 'x', outcome: 'SUCCEEDED' },
      { ...ids, correlationId: undefined, outcome: 'SUCCEEDED' },
      {
        ...ids,
        outcome: 'SUCCEEDED',
        runtime: { gameProcessState: 'FLYING', skseReady: true },
      },
      {
        ...ids,
        outcome: 'SUCCEEDED',
        runtime: { gameProcessState: 'RUNNING' },
      },
      {
        ...ids,
        outcome: 'SUCCEEDED',
        runtime: { gameProcessState: 'RUNNING', skseReady: true, pid: 1 },
      },
    ])
      expect(reason(() => serverControlResultPayload(payload))).toBe(
        'PROTOCOL_ERROR',
      );
  });
  const setup = () => {
    const registry = new AgentSessionRegistry();
    const ws = socket();
    // Skyrim stopped and SKSE not ready: Server Control still works.
    const session = snapshot({
      capabilities: caps,
      runtime: { gameProcessState: G.STOPPED, skseReady: false },
    });
    activate(registry, session, ws);
    const gateway = new AgentServerControlGateway(registry, {
      now: () => new Date('2026-10-01T12:00:00.000Z'),
    } as BridgeClock);
    const request: ServerControlRequest = {
      operationId: randomUUID(),
      gameServerId: serverId,
      connectionId: session.connectionId,
      type: 'SERVER_START',
      correlationId: randomUUID(),
      requestedAt: '2026-10-01T11:59:59.000Z',
      issuedAt: '2026-10-01T12:00:00.000Z',
      notAfter: '2026-10-01T12:00:10.000Z',
    };
    return { registry, ws, session, gateway, request };
  };
  it('targets an ACTIVE session with the capability whatever the game runtime', () => {
    const { registry, session, gateway } = setup();
    expect(gateway.target(serverId, 'SERVER_START')).toBe(session.connectionId);
    expect(gateway.target(serverId, 'SERVER_PAUSE')).toBeNull();
    expect(gateway.target(randomUUID(), 'SERVER_START')).toBeNull();
    registry.remove(serverId, session.connectionId);
    expect(gateway.target(serverId, 'SERVER_START')).toBeNull();
  });
  it('sends one typed SERVER_CONTROL with notAfter to exactly the claimed session', async () => {
    const { ws, gateway, request } = setup();
    expect(await gateway.send(request, new AbortController().signal)).toEqual({
      accepted: true,
    });
    expect(ws.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(ws.send.mock.calls[0][0] as string);
    expect(sent).toMatchObject({
      protocolVersion: '1',
      type: 'SERVER_CONTROL',
      gameServerId: serverId,
    });
    expect(sent.payload).toEqual({
      operationId: request.operationId,
      correlationId: request.correlationId,
      type: 'SERVER_START',
      issuedAt: request.issuedAt,
      notAfter: request.notAfter,
    });
    expect(JSON.stringify(sent)).not.toMatch(
      /idempotency|staff|actor|token|command|path|script|args/i,
    );
  });
  it('reports proven non-delivery and never redirects when the session or capability changed after the claim', async () => {
    const { registry, ws, session, gateway, request } = setup();
    const signal = new AbortController().signal;
    // A newer session (duplicate connection) owns the server now.
    const other = snapshot({ capabilities: caps });
    const otherSocket = socket();
    activate(registry, other, otherSocket);
    expect(await gateway.send(request, signal)).toEqual({
      accepted: false,
      reason: 'UNAVAILABLE',
    });
    expect(otherSocket.send).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();
    // Capability withdrawn by a heartbeat.
    const withdrawn = setup();
    withdrawn.registry.heartbeat(
      serverId,
      withdrawn.session.connectionId,
      {
        gameProcessState: G.STOPPED,
        skseReady: false,
        capabilities: ['SERVER_START'],
      },
      new Date(),
    );
    expect(await withdrawn.gateway.send(withdrawn.request, signal)).toEqual({
      accepted: false,
      reason: 'UNAVAILABLE',
    });
    // Aborted, or the socket is no longer open.
    const aborted = setup();
    const controller = new AbortController();
    controller.abort();
    expect(
      await aborted.gateway.send(aborted.request, controller.signal),
    ).toMatchObject({ accepted: false });
    const closed = setup();
    (closed.ws as { readyState: number }).readyState = 3;
    expect(await closed.gateway.send(closed.request, signal)).toMatchObject({
      accepted: false,
    });
    expect(aborted.ws.send).not.toHaveBeenCalled();
    expect(closed.ws.send).not.toHaveBeenCalled();
    void session;
  });
  it('updates the runtime snapshot without refreshing liveness', () => {
    const { registry, session } = setup();
    expect(
      registry.updateRuntime(serverId, session.connectionId, {
        gameProcessState: G.STARTING,
        skseReady: false,
      }),
    ).toBe(true);
    expect(registry.getSession(serverId)).toMatchObject({
      runtime: { gameProcessState: G.STARTING, skseReady: false },
      lastHeartbeatAt: new Date(0),
    });
    expect(
      registry.updateRuntime(serverId, randomUUID(), {
        gameProcessState: G.RUNNING,
        skseReady: true,
      }),
    ).toBe(false);
  });
});

describe('Host Agent domain events and work (11.4)', () => {
  const eventId = randomUUID();
  const workId = randomUUID();
  it('keeps closed catalogs of event and work kinds', () => {
    expect(AGENT_EVENT_KINDS).toEqual([
      'CHARACTER_OWNERSHIP_PROOF',
      'PROFESSION_EXPERIENCE',
      'TRADE_SETTLEMENT',
      'MARKETPLACE_CUSTODY',
      'MARKETPLACE_SETTLEMENT',
      'MARKETPLACE_RELEASE',
    ]);
    expect(AGENT_WORK_KINDS).toEqual([
      'TRADE_SETTLEMENT',
      'MARKETPLACE_CUSTODY',
      'MARKETPLACE_SETTLEMENT',
      'MARKETPLACE_RELEASE',
    ]);
  });
  it('parses exactly one data schema per kind and nothing generic', () => {
    expect(
      domainEventPayload({
        eventId,
        kind: 'TRADE_SETTLEMENT',
        data: { workId, outcome: 'SETTLED' },
      }),
    ).toEqual({
      eventId,
      kind: 'TRADE_SETTLEMENT',
      data: { workId, outcome: 'SETTLED' },
    });
    expect(
      domainEventPayload({
        eventId,
        kind: 'PROFESSION_EXPERIENCE',
        data: { characterExternalId: 'char:1', amount: 3 },
      }).data,
    ).toEqual({ characterExternalId: 'char:1', amount: 3 });
    for (const payload of [
      { eventId, kind: 'GENERIC', data: {} },
      { eventId, kind: 'TRADE_SETTLEMENT', data: { workId, outcome: 'DONE' } },
      {
        eventId,
        kind: 'MARKETPLACE_CUSTODY',
        data: { workId, outcome: 'SETTLED' },
      },
      {
        eventId,
        kind: 'TRADE_SETTLEMENT',
        data: { workId, outcome: 'SETTLED', gold: 1 },
      },
      {
        eventId,
        kind: 'MARKETPLACE_SETTLEMENT',
        data: { workId, outcome: 'SETTLED', priceGold: 1 },
      },
      {
        eventId,
        kind: 'PROFESSION_EXPERIENCE',
        data: { characterExternalId: 'c', amount: 1, level: 50 },
      },
      {
        eventId,
        kind: 'CHARACTER_OWNERSHIP_PROOF',
        data: { challenge: 'X', characterExternalId: 'c', playerId: 'p' },
      },
      {
        eventId,
        kind: 'CHARACTER_OWNERSHIP_PROOF',
        data: { challenge: 'x'.repeat(65), characterExternalId: 'c' },
      },
      {
        eventId: 'nope',
        kind: 'TRADE_SETTLEMENT',
        data: { workId, outcome: 'SETTLED' },
      },
      {
        eventId,
        kind: 'TRADE_SETTLEMENT',
        data: { workId: 'x', outcome: 'SETTLED' },
      },
      {
        eventId,
        kind: 'TRADE_SETTLEMENT',
        data: { workId, outcome: 'SETTLED' },
        gameServerId: serverId,
      },
    ])
      expect(reason(() => domainEventPayload(payload))).toBe('PROTOCOL_ERROR');
  });
  it('accepts only a bounded, server-less WORK_SYNC', () => {
    expect(workSyncPayload({})).toEqual({});
    expect(
      workSyncPayload({
        kind: 'MARKETPLACE_RELEASE',
        limit: 10,
        cursor: 'abc',
      }),
    ).toEqual({ kind: 'MARKETPLACE_RELEASE', limit: 10, cursor: 'abc' });
    for (const payload of [
      { limit: 0 },
      { limit: 51 },
      { kind: 'ARBITRARY_WORK' },
      { gameServerId: serverId },
      { cursor: 'has spaces' },
    ])
      expect(reason(() => workSyncPayload(payload))).toBe('PROTOCOL_ERROR');
  });
  // In-memory sources shaped like the domain projections.
  const rows = (count: number, bytes = 10) =>
    Array.from({ length: count }, (_, i) => ({
      id: randomUUID(),
      pos: String(1_000_000 + i),
      createdAt: new Date(1_000 + i),
      data: { blob: 'x'.repeat(bytes) },
    }));
  const service = (tables: Record<string, ReturnType<typeof rows>>) => {
    const read =
      (kind: string) =>
      async (
        _server: string,
        after: { pos: string; id: string } | null,
        limit: number,
      ) =>
        (tables[kind] ?? [])
          .filter(
            (r) =>
              !after ||
              BigInt(r.pos) > BigInt(after.pos) ||
              (r.pos === after.pos && r.id > after.id),
          )
          .slice(0, limit);
    return new AgentWorkService(
      { pending: read('TRADE_SETTLEMENT') } as never,
      {
        custody: read('MARKETPLACE_CUSTODY'),
        settlement: read('MARKETPLACE_SETTLEMENT'),
        release: read('MARKETPLACE_RELEASE'),
      } as never,
    );
  };
  const all = async (
    work: AgentWorkService,
    request: Record<string, unknown> = {},
  ) => {
    const pages = [];
    let cursor: string | null = null;
    do {
      const page = await work.page(serverId, {
        ...request,
        ...(cursor ? { cursor } : {}),
      });
      pages.push(page);
      cursor = page.nextCursor;
    } while (cursor);
    return pages;
  };
  it('pages every kind in order with a keyset cursor, never skipping or repeating', async () => {
    const tables = {
      TRADE_SETTLEMENT: rows(3),
      MARKETPLACE_CUSTODY: rows(4),
      MARKETPLACE_RELEASE: rows(2),
    };
    const pages = await all(service(tables), { limit: 2 });
    expect(pages.every((p) => p.items.length <= 2)).toBe(true);
    expect(pages.flatMap((p) => p.items.map((i) => i.workId))).toEqual(
      [
        ...tables.TRADE_SETTLEMENT,
        ...tables.MARKETPLACE_CUSTODY,
        ...tables.MARKETPLACE_RELEASE,
      ].map((r) => r.id),
    );
    const only = await all(service(tables), {
      kind: 'MARKETPLACE_RELEASE',
      limit: 1,
    });
    expect(only.flatMap((p) => p.items.map((i) => i.kind))).toEqual([
      'MARKETPLACE_RELEASE',
      'MARKETPLACE_RELEASE',
    ]);
    // A cursor of another kind than the filter is refused.
    const first = await service(tables).page(serverId, { limit: 1 });
    await expect(
      service(tables).page(serverId, {
        kind: 'MARKETPLACE_RELEASE',
        cursor: first.nextCursor!,
      }),
    ).rejects.toBeInstanceOf(AgentProtocolError);
    for (const cursor of [
      'x',
      Buffer.from('[0,"1"]').toString('base64url'),
      Buffer.from('[7,null,null]').toString('base64url'),
    ])
      await expect(
        service(tables).page(serverId, { cursor }),
      ).rejects.toBeInstanceOf(AgentProtocolError);
  });
  it('bounds a page by bytes so WORK_ITEMS always fits the frame', async () => {
    const tables = { TRADE_SETTLEMENT: rows(40, 6000) };
    const pages = await all(service(tables));
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages)
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(
        MAX_WORK_PAGE_BYTES + 1024,
      );
    expect(pages.flatMap((p) => p.items).length).toBe(40);
    expect(MAX_WORK_PAGE_BYTES + 4096).toBeLessThan(MAX_AGENT_FRAME_BYTES);
  });
});
