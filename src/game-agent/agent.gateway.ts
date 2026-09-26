import {
  Injectable,
  Logger,
  BeforeApplicationShutdown,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import type { ApplicationConfig } from '../config/environment.js';
import { BridgeClock } from '../game-bridge/bridge-clock.js';
import { GameConnectionService } from '../game-bridge/game-connection.service.js';
import { GameServerStatusNotifier } from '../game-bridge/game-server-status.notifier.js';
import type {
  DisconnectReason,
  GameConnection,
} from '../game-bridge/entities/game-connection.entity.js';
import { WebSocketUpgradeRouter } from '../websocket/websocket-upgrade.router.js';
import { rejectUpgrade } from '../websocket/reject-upgrade.js';
import { ClientAddress } from '../common/net/client-address.service.js';
import { ConcurrencyLimiter } from '../common/rate-limit/concurrency-limiter.js';
import { RateLimiter } from '../common/rate-limit/rate-limiter.js';
import { SecurityLog } from '../common/security/security-log.js';
import { TickDrain } from '../lifecycle/tick-drain.js';
import { Metrics } from '../observability/metrics.js';
import { AgentAuthError, AgentAuthService } from './agent-auth.service.js';
import { AgentMessageRouter } from './agent-message.router.js';
import {
  AGENT_PATH,
  AGENT_PROTOCOL_VERSION,
  AgentClose,
  AgentProtocolError,
  helloPayload,
  MAX_AGENT_FRAME_BYTES,
  outbound,
  parseEnvelope,
} from './agent-protocol.contracts.js';
import type {
  AgentCloseReason,
  AgentEnvelope,
} from './agent-protocol.contracts.js';
import { AgentSessionRegistry } from './agent-session.registry.js';
import type { AgentSessionSnapshot } from './agent-session.registry.js';
import { ClusterBus } from '../cluster/cluster-bus.js';
import { InstanceIdentity } from '../cluster/instance-identity.js';

type SocketState = 'AWAITING_HELLO' | 'AUTHENTICATING' | 'AUTHENTICATED';
const DB_SWEEP_INTERVAL_MS = 5000;

// Host Agent WebSocket transport (11.1): its own path, credential and
// protocol, never the Player/Staff realtime socket. A socket must send HELLO
// first; frames are processed one at a time per socket. A session ends by
// peer close, protocol violation, supersede, credential revocation, heartbeat
// timeout or shutdown, and its game_connections row is closed with the
// matching reason (history is kept).
@Injectable()
export class AgentGateway
  implements
    OnModuleInit,
    OnApplicationBootstrap,
    OnModuleDestroy,
    BeforeApplicationShutdown
{
  private readonly logger = new Logger(AgentGateway.name);
  private readonly config: ApplicationConfig['agent'];
  private readonly limits: ApplicationConfig['security']['agent'];
  // Sockets that have not completed HELLO yet (bounded).
  private pending = 0;
  private wss?: WebSocketServer;
  private sweep?: ReturnType<typeof setInterval>;
  private readonly sweeping: TickDrain;
  private stopping = false;
  // Per-server promotion chains of this process. Across replicas the HELLO
  // transaction (server row lock) orders promotions (12.5).
  private readonly promotions = new Map<string, Promise<void>>();
  private readonly topology: ApplicationConfig['deployment']['topology'];
  private lastDbSweep = 0;
  constructor(
    private readonly upgrades: WebSocketUpgradeRouter,
    private readonly auth: AgentAuthService,
    private readonly router: AgentMessageRouter,
    private readonly sessions: AgentSessionRegistry,
    private readonly connections: GameConnectionService,
    private readonly clock: BridgeClock,
    config: ConfigService<{ application: ApplicationConfig }, true>,
    private readonly status: GameServerStatusNotifier,
    private readonly addresses: ClientAddress,
    private readonly limiter: RateLimiter,
    private readonly concurrency: ConcurrencyLimiter,
    private readonly security: SecurityLog,
    @Optional() private readonly metrics?: Metrics,
    @Optional() private readonly cluster?: ClusterBus,
    @Optional() private readonly instance?: InstanceIdentity,
  ) {
    const application = config.get('application', { infer: true });
    this.topology = application.deployment?.topology ?? 'SINGLE';
    this.config = application.agent;
    this.limits = application.security.agent;
    this.sweeping = new TickDrain(metrics?.worker('heartbeat_sweep'));
    metrics?.onCollect(() =>
      metrics.agentSessions.set(this.sessions.activeSessions().length),
    );
  }
  onModuleInit(): void {
    // ws closes frames above the limit with 1009 before any JSON parse.
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_AGENT_FRAME_BYTES,
    });
    this.upgrades.register(AGENT_PATH, this.upgrade);
  }
  async onApplicationBootstrap(): Promise<void> {
    // SINGLE: sockets never survive a restart and the global lock proves no
    // other instance runs, so no persisted session is live. MULTI (12.5):
    // other replicas own live sessions; only rows whose lease (heartbeat)
    // expired, or without an owner, are closed. A database outage must not
    // prevent startup; the Game Bridge health check still treats those rows
    // as stale once their heartbeat ages.
    try {
      const stale =
        this.topology === 'MULTI'
          ? await this.connections.endExpired()
          : await this.connections.endAllActive('BACKEND_RESTART');
      if (stale)
        this.logger.warn(
          `Agent sessions closed on startup [count=${stale} reason=${this.topology === 'MULTI' ? 'STALE' : 'BACKEND_RESTART'}]`,
        );
    } catch {
      this.logger.error('Agent session reconciliation on startup failed');
    }
    // Close signals from other replicas (12.5). Never the authority: a lost
    // signal leaves a socket that the database fences on every frame.
    this.cluster?.subscribe('AGENT_SESSION_CLOSED', (payload) => {
      const { gameServerId, connectionId } = payload;
      if (typeof gameServerId !== 'string' || typeof connectionId !== 'string')
        return;
      if (this.sessions.terminate(gameServerId, connectionId, 'SUPERSEDED')) {
        this.metrics?.agentOwnershipLost.inc({ reason: 'superseded_remote' });
        this.logger.log(
          `Agent session closed by another instance [gameServerId=${gameServerId} connectionId=${connectionId}]`,
        );
      }
    });
    this.cluster?.subscribe('AGENT_CREDENTIAL_REVOKED', (payload) => {
      if (typeof payload.credentialId !== 'string') return;
      for (const session of this.sessions.byCredential(payload.credentialId))
        if (
          this.sessions.terminate(
            session.gameServerId,
            session.connectionId,
            'CREDENTIAL_REVOKED',
          )
        ) {
          this.metrics?.agentOwnershipLost.inc({ reason: 'revoked_remote' });
          this.logger.log(
            `Agent session closed: credential revoked on another instance [gameServerId=${session.gameServerId} connectionId=${session.connectionId}]`,
          );
        }
    });
    // One periodic sweep instead of a timer per connection.
    this.sweep = setInterval(
      () => void this.sweepOnce(),
      Math.max(100, Math.min(this.config.heartbeatIntervalMs, 1000)),
    );
    this.sweep.unref();
  }
  // Graceful shutdown, phase 1 (with the workers): stop the heartbeat sweep
  // and await a sweep in progress.
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.sweep) clearInterval(this.sweep);
    await this.sweeping.wait();
  }
  private async sweepOnce(): Promise<void> {
    if (this.sweeping.active || this.stopping) return;
    this.sweeping.begin();
    try {
      await this.expire();
      // MULTI (12.5): sessions of a replica that died keep CONNECTED rows
      // until someone persists STALE. Any replica may run this DB-only
      // sweep: each close is a conditional transition under the server
      // lock (heartbeat really expired), so exactly one persists and
      // publishes it, and a live owner renewing its lease is never touched.
      if (
        this.topology === 'MULTI' &&
        Date.now() - this.lastDbSweep >= DB_SWEEP_INTERVAL_MS
      ) {
        this.lastDbSweep = Date.now();
        const stale = await this.connections.markStaleConnections();
        if (stale)
          this.logger.warn(
            `Agent sessions without a live owner closed [count=${stale} reason=STALE]`,
          );
      }
    } catch {
      this.sweeping.fail();
      this.logger.error('Agent heartbeat sweep failed');
    } finally {
      this.sweeping.end();
    }
  }
  // Phase 2, after every worker stopped: planned SHUTDOWN (never STALE) is
  // persisted for each session, then the sockets close with 1001 SHUTDOWN.
  // The Agent reconnects to the next instance (recreate deployment).
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    for (const session of this.sessions.all()) {
      await this.end(session, 'SHUTDOWN');
      this.sessions.terminate(
        session.gameServerId,
        session.connectionId,
        'SHUTDOWN',
      );
    }
    for (const socket of this.wss?.clients ?? [])
      socket.close(AgentClose.SHUTDOWN, 'SHUTDOWN');
    this.wss?.close();
  }
  // Heartbeat timeout: close the socket and the session as STALE.
  async expire(): Promise<number> {
    const expired = this.sessions.expired(
      this.clock.now(),
      this.config.heartbeatTimeoutMs,
    );
    for (const session of expired) {
      this.logger.warn(
        `Agent heartbeat timeout [gameServerId=${session.gameServerId} connectionId=${session.connectionId}]`,
      );
      await this.end(session, 'STALE');
      this.sessions.terminate(
        session.gameServerId,
        session.connectionId,
        'HEARTBEAT_TIMEOUT',
      );
      this.metrics?.agentCloses.inc({ reason: 'HEARTBEAT_TIMEOUT' });
    }
    return expired.length;
  }
  // Admission before any WebSocket state (12.1, per process). The Host
  // Agent is headless: Origin is not a security signal and is ignored; the
  // credential stays the authority. Limits: connection attempts per client
  // IP, a cool-down after repeated HELLO failures from that IP, and a cap on
  // sockets that have not completed HELLO.
  private readonly upgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => {
    void this.admit(request, socket, head).catch(() => socket.destroy());
  };
  // Shared buckets in MULTI (12.5): the database round trip happens before
  // any WebSocket state; a peer that left meanwhile is simply dropped.
  private async admit(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const ip = this.addresses.of(request);
    const failures = await this.limiter.check('agent-auth-failure', ip, {
      limit: this.limits.authFailuresPerIpPerMinute,
      windowMs: 60_000,
    });
    if (!failures.allowed) {
      this.security.warn('agent_hello_blocked', { ip, reason: 'failures' });
      this.metrics?.agentAdmissionRejects.inc({ reason: 'auth_failures' });
      return rejectUpgrade(socket, 429, failures.retryAfterSeconds);
    }
    const attempt = await this.limiter.consume('agent-connect', ip, {
      limit: this.limits.connectsPerIpPerMinute,
      windowMs: 60_000,
    });
    if (!attempt.allowed) {
      this.security.warn('agent_hello_blocked', { ip, reason: 'rate' });
      this.metrics?.agentAdmissionRejects.inc({ reason: 'rate' });
      return rejectUpgrade(socket, 429, attempt.retryAfterSeconds);
    }
    if (this.pending >= this.limits.maxPendingConnections) {
      this.security.warn('agent_capacity_refused', {
        ip,
        pending: this.pending,
      });
      this.metrics?.agentAdmissionRejects.inc({ reason: 'capacity' });
      return rejectUpgrade(socket, 503, 1);
    }
    if (socket.destroyed) return;
    this.wss!.handleUpgrade(request, socket, head, (ws) =>
      this.connect(ws, ip),
    );
  }
  private connect(ws: WebSocket, ip: string): void {
    let state: SocketState = 'AWAITING_HELLO';
    let counted = true;
    this.pending++;
    const settle = () => {
      if (!counted) return;
      counted = false;
      this.pending--;
    };
    let session: AgentSessionSnapshot | undefined;
    let queue = Promise.resolve();
    // Authenticated frames per window (in memory, per session).
    let windowStart = 0;
    let windowCount = 0;
    const close = (reason: AgentCloseReason) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      this.metrics?.agentCloses.inc({ reason });
      ws.close(AgentClose[reason], reason);
    };
    const timeout = setTimeout(() => {
      this.logger.warn('Agent HELLO timeout');
      close('AUTH_TIMEOUT');
    }, this.config.authTimeoutMs);
    const hello = async (raw: string) => {
      // The window is for sending HELLO; verifying it is not time-boxed here.
      clearTimeout(timeout);
      let envelope: AgentEnvelope;
      try {
        envelope = parseEnvelope(raw);
        if (envelope.type !== 'HELLO')
          throw new AgentProtocolError('PROTOCOL_ERROR');
      } catch (error) {
        return this.rejectFrame(error, close);
      }
      let payload;
      try {
        payload = helloPayload(envelope.payload);
      } catch (error) {
        return this.rejectFrame(error, close);
      }
      const gameServerId = envelope.gameServerId;
      // Bounded verification work (hash + locking transaction) at once.
      const slot = this.concurrency.tryAcquire(
        'agent-hello',
        this.limits.maxConcurrentAuth,
      );
      if (!slot) {
        this.security.warn('agent_hello_busy', {
          ip,
          max: this.limits.maxConcurrentAuth,
        });
        this.metrics?.agentAdmissionRejects.inc({ reason: 'busy' });
        return close('AUTH_BUSY');
      }
      // A) + B) + C): verified and persisted in one transaction. Nothing is
      // published in memory, so a rollback leaves no registry entry and the
      // previous session (if any) is untouched.
      let connection: GameConnection & { supersededConnectionId?: string };
      try {
        connection = await this.auth.authenticate(gameServerId, payload);
      } catch (error) {
        this.logger.warn(
          error instanceof AgentAuthError
            ? `Agent authentication rejected [gameServerId=${gameServerId} credentialId=${payload.credentialId} reason=${error.reason}]`
            : `Agent authentication failed [gameServerId=${gameServerId}]`,
        );
        this.metrics?.agentAuth.inc(
          error instanceof AgentAuthError
            ? { outcome: 'rejected', reason: error.reason }
            : { outcome: 'failed', reason: 'error' },
        );
        if (error instanceof AgentAuthError)
          await this.limiter.consume('agent-auth-failure', ip, {
            limit: this.limits.authFailuresPerIpPerMinute,
            windowMs: 60_000,
          });
        return close('UNAUTHORIZED');
      } finally {
        slot();
      }
      const candidate: AgentSessionSnapshot = {
        connectionId: connection.id,
        gameServerId,
        credentialId: payload.credentialId,
        agentVersion: payload.agentVersion,
        capabilities: payload.capabilities,
        runtime: {
          gameProcessState: payload.gameProcessState,
          skseReady: payload.skseReady,
        },
        connectedAt: connection.connectedAt,
        lastHeartbeatAt: connection.lastHeartbeatAt,
      };
      // The peer left during the transaction: close the committed row.
      if (ws.readyState !== WebSocket.OPEN) {
        await this.end(candidate, 'CLOSED');
        return;
      }
      // The previous session may live on another replica: tell its owner to
      // close it (its frames are already fenced by the committed HELLO).
      if (connection.supersededConnectionId)
        void this.cluster?.publish('AGENT_SESSION_CLOSED', {
          gameServerId,
          connectionId: connection.supersededConnectionId,
        });
      // D): AUTHENTICATING, reachable by revocation and cleanup only.
      session = candidate;
      this.sessions.begin(candidate, ws);
      // E) + F) + G): revalidate and promote.
      const outcome = await this.promote(candidate);
      if (outcome !== 'ACTIVE') {
        this.metrics?.agentAuth.inc({ outcome: 'rejected', reason: outcome });
        this.logger.warn(
          `Agent session not activated [gameServerId=${gameServerId} connectionId=${connection.id} reason=${outcome}]`,
        );
        return;
      }
      state = 'AUTHENTICATED';
      settle();
      this.metrics?.agentAuth.inc({ outcome: 'success', reason: 'none' });
      // Staff wake-up: connected, or a supersede of the previous session.
      void this.status.changed(gameServerId);
      const now = this.clock.now();
      ws.send(
        JSON.stringify(
          outbound(
            'AUTHENTICATED',
            gameServerId,
            {
              inReplyTo: envelope.messageId,
              connectionId: connection.id,
              heartbeatIntervalMs: this.config.heartbeatIntervalMs,
              heartbeatTimeoutMs: this.config.heartbeatTimeoutMs,
              maxFrameBytes: MAX_AGENT_FRAME_BYTES,
              serverTime: now.toISOString(),
            },
            now,
          ),
        ),
      );
      this.logger.log(
        `Agent authenticated [gameServerId=${gameServerId} connectionId=${connection.id} credentialId=${payload.credentialId} agentVersion=${payload.agentVersion} gameProcessState=${payload.gameProcessState} skseReady=${payload.skseReady} instanceId=${this.instance?.id ?? 'standalone'}]`,
      );
    };
    const authenticated = async (raw: string) => {
      const current = session;
      // Frames buffered behind a close are dropped.
      if (ws.readyState !== WebSocket.OPEN) return;
      if (!current) return close('PROTOCOL_ERROR');
      let envelope: AgentEnvelope;
      try {
        envelope = parseEnvelope(raw);
      } catch (error) {
        return this.rejectFrame(error, close, current);
      }
      const outcome = await this.router.route(current, envelope);
      if (outcome.reply && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify(outcome.reply));
      if (outcome.close) {
        this.sessions.remove(current.gameServerId, current.connectionId);
        close(outcome.close);
      }
    };
    ws.on('message', (raw: RawData, isBinary: boolean) => {
      // HELLO first and alone: nothing may arrive while it is verified.
      if (isBinary || state === 'AUTHENTICATING') {
        this.logger.warn('Agent protocol violation [reason=FRAME_ORDER]');
        return close('PROTOCOL_ERROR');
      }
      if (state === 'AUTHENTICATED') {
        const now = Date.now();
        if (now - windowStart >= this.config.messageRateLimitWindowMs) {
          windowStart = now;
          windowCount = 0;
        }
        if (++windowCount > this.config.messageRateLimitCount) {
          const current = session;
          this.logger.warn(
            `Agent message rate limit exceeded [gameServerId=${current?.gameServerId} connectionId=${current?.connectionId} limit=${this.config.messageRateLimitCount}]`,
          );
          if (current)
            this.sessions.remove(current.gameServerId, current.connectionId);
          return close('RATE_LIMITED');
        }
      }
      const text = raw.toString();
      // Switched synchronously: a frame in the same chunk as HELLO is refused.
      let handle = authenticated;
      if (state === 'AWAITING_HELLO') {
        state = 'AUTHENTICATING';
        handle = hello;
      }
      queue = queue
        .then(() => handle(text))
        .catch(() => {
          this.logger.error('Agent frame processing failed');
          close('PROTOCOL_ERROR');
        });
    });
    ws.on('close', (code: number) => {
      settle();
      clearTimeout(timeout);
      const current = session;
      session = undefined;
      if (!current) return;
      const owned = this.sessions.remove(
        current.gameServerId,
        current.connectionId,
      );
      if (owned)
        this.logger.log(
          `Agent disconnected [gameServerId=${current.gameServerId} connectionId=${current.connectionId} code=${code}]`,
        );
      // No-op when the row was already closed (superseded, revoked, stale).
      if (!this.stopping)
        void this.end(current, code === 1000 ? 'REQUESTED' : 'CLOSED');
    });
    ws.on('error', () => ws.terminate());
  }
  // Post-commit promotion, serialized per server so that promotions happen
  // in commit order: the revalidation reads the committed state, and no
  // await separates a positive revalidation from the activation. A
  // revocation that commits later finds the session (AUTHENTICATING or
  // ACTIVE) and closes it; one that committed earlier fails revalidation.
  private promote(
    candidate: AgentSessionSnapshot,
  ): Promise<'ACTIVE' | AgentCloseReason> {
    const { gameServerId, connectionId } = candidate;
    return this.serialized(gameServerId, async () => {
      let verdict: 'ELIGIBLE' | AgentCloseReason;
      try {
        verdict = await this.auth.eligible(connectionId);
      } catch {
        this.logger.error(
          `Agent session revalidation failed [gameServerId=${gameServerId} connectionId=${connectionId}]`,
        );
        verdict = 'UNAUTHORIZED';
      }
      if (verdict === 'ELIGIBLE') {
        const { activated, superseded } = this.sessions.activate(
          gameServerId,
          connectionId,
        );
        // Gone meanwhile: closed by the peer or by a revocation.
        if (!activated) return 'SESSION_CLOSED';
        if (superseded) this.metrics?.agentCloses.inc({ reason: 'SUPERSEDED' });
        if (superseded)
          this.logger.log(
            `Agent session superseded [gameServerId=${gameServerId} connectionId=${superseded.connectionId} by=${connectionId}]`,
          );
        return 'ACTIVE';
      }
      this.sessions.terminate(gameServerId, connectionId, verdict);
      await this.settle(gameServerId);
      return verdict;
    });
  }
  // A committed HELLO already superseded the previous session's row even if
  // the new session is then refused (e.g. revoked before promotion): close
  // that in-memory session so the registry never outlives the database.
  // A previous session whose row is still CONNECTED is left alone.
  private async settle(gameServerId: string): Promise<void> {
    const current = this.sessions.getSession(gameServerId);
    if (!current) return;
    try {
      if (await this.auth.stillConnected(current.connectionId)) return;
    } catch {
      return;
    }
    this.sessions.terminate(gameServerId, current.connectionId, 'SUPERSEDED');
  }
  private serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
    const next = (this.promotions.get(key) ?? Promise.resolve()).then(
      task,
      task,
    );
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.promotions.set(key, tail);
    void tail.then(() => {
      if (this.promotions.get(key) === tail) this.promotions.delete(key);
    });
    return next;
  }
  private rejectFrame(
    error: unknown,
    close: (reason: AgentCloseReason) => void,
    session?: AgentSessionSnapshot,
  ): void {
    const reason =
      error instanceof AgentProtocolError ? error.reason : 'PROTOCOL_ERROR';
    const where = session
      ? `gameServerId=${session.gameServerId} connectionId=${session.connectionId} `
      : '';
    if (reason === 'PROTOCOL_UNSUPPORTED')
      this.logger.warn(
        `Agent protocol version rejected [${where}supported=${AGENT_PROTOCOL_VERSION}]`,
      );
    else this.logger.warn(`Agent malformed frame [${where}reason=SCHEMA]`);
    if (session)
      this.sessions.remove(session.gameServerId, session.connectionId);
    close(reason);
  }
  private async end(
    session: AgentSessionSnapshot,
    reason: DisconnectReason,
  ): Promise<void> {
    try {
      // Counted only when this call persisted the end of the session.
      if (
        await this.connections.end(
          session.gameServerId,
          session.connectionId,
          reason,
        )
      )
        this.metrics?.agentDisconnects.inc({ reason });
    } catch {
      this.logger.error(
        `Agent session close not persisted [gameServerId=${session.gameServerId} connectionId=${session.connectionId}]`,
      );
    }
    // Also after a close the database already recorded (revocation,
    // supersede): the notifier publishes only a real change.
    await this.status.changed(session.gameServerId);
  }
}
