import { jest } from '@jest/globals';
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
} from './agent-protocol.contracts.js';
import type { AgentEnvelope } from './agent-protocol.contracts.js';
import { AgentSessionRegistry } from './agent-session.registry.js';
import type {
  AgentSessionSnapshot,
  AgentSocket,
} from './agent-session.registry.js';
import { AgentMessageRouter } from './agent-message.router.js';
import { AgentGateway } from './agent.gateway.js';
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
      new AgentMessageRouter(connections as never, registry, clock),
      registry,
      connections as never,
      clock,
      {
        get: () => ({
          agent: {
            authTimeoutMs: 5000,
            heartbeatIntervalMs: 1000,
            heartbeatTimeoutMs: 3000,
          },
        }),
      } as never,
    );
    const connect = () => {
      const ws = new FakeAgentSocket();
      (gateway as unknown as { connect(ws: unknown): void }).connect(ws);
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
    return { registry, auth, connections, connect, row, established };
  };
  const authenticatedFrames = (ws: FakeAgentSocket) =>
    ws.sent.filter((m) => m.type === 'AUTHENTICATED');

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
    const router = new AgentMessageRouter(
      connections,
      registry,
      clock as BridgeClock,
    );
    const session = snapshot();
    activate(registry, session, socket());
    return { router, session, heartbeat, registry };
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
      'WORK_SYNC',
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
  it('answers later-substep flows with NOT_IMPLEMENTED and accepts Agent ERROR frames', async () => {
    const { router, session, heartbeat } = setup();
    for (const type of [
      'COMMAND_RESULT',
      'DOMAIN_EVENT',
      'SERVER_CONTROL_RESULT',
    ]) {
      const message = envelope({ type, payload: { anything: 1 } });
      expect(await router.route(session, message)).toEqual({
        reply: expect.objectContaining({
          type: 'ERROR',
          payload: {
            inReplyTo: message.messageId,
            code: 'NOT_IMPLEMENTED',
            retryable: false,
          },
        }),
      });
    }
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
  it('never reaches domain modules, Player/Staff realtime or the command pipeline', () => {
    for (const { source } of sources('game-agent'))
      for (const module of imports(source))
        expect(module).not.toMatch(
          /player-|professions|vip-|economy|server-control|character-management|moderation|world-management|realtime|game-command|socket\.io|electron|child_process/,
        );
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
