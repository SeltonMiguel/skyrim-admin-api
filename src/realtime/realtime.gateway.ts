import {
  Injectable,
  BeforeApplicationShutdown,
  OnApplicationBootstrap,
  OnModuleInit,
  UnauthorizedException,
  Optional,
} from '@nestjs/common';
import { Metrics } from '../observability/metrics.js';
import { ConfigService } from '@nestjs/config';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { decodeJwt } from 'jose';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import type { ApplicationConfig } from '../config/environment.js';
import { WebSocketUpgradeRouter } from '../websocket/websocket-upgrade.router.js';
import { AuthService } from '../auth/auth.service.js';
import { PlayerAuthService } from '../player-auth/player-auth.service.js';
import { RealtimeEventBus } from '../realtime-events/realtime-event-bus.js';
import { RealtimeSessionControl } from '../realtime-events/realtime-session-control.js';
import type {
  RealtimeEnvelope,
  RealtimeRecipients,
} from '../realtime-events/realtime-event-bus.js';
import type { Permission } from '../rbac/permissions.js';
import { ClientAddress } from '../common/net/client-address.service.js';
import { RateLimiter } from '../common/rate-limit/rate-limiter.js';
import { SecurityLog } from '../common/security/security-log.js';
import { RealtimeLeaseService } from '../cluster/realtime-leases.js';
import { rejectUpgrade } from '../websocket/reject-upgrade.js';
import {
  connectionKey,
  RealtimeConnectionRegistry,
  sendFrame,
} from './realtime-connection.registry.js';
import type { RealtimeSurface } from './realtime-connection.registry.js';

export const REALTIME_PATH = '/api/v1/realtime';
export const MAX_REALTIME_FRAME_BYTES = 16 * 1024;
// Longer than any Player access token (PLAYER_JWT_ACCESS_TTL ≤ 1 h).
const REVOKED_TRACK_MS = 60 * 60 * 1000;
const MAX_REVOKED_TRACKED = 10_000;
// Pending Player deliveries awaiting their session check (bounded).
const MAX_PLAYER_BACKLOG = 10_000;
// Application close codes (4000–4999).
export const RealtimeClose = {
  AUTH_TIMEOUT: 4000,
  UNAUTHORIZED: 4001,
  // 12.1: the Player session behind the socket was revoked by the backend
  // (logout, refresh reuse). Same code as UNAUTHORIZED, distinct reason.
  SESSION_REVOKED: 4001,
  // 12.4: a moderator suspended or banned the account (reason
  // ACCOUNT_DISABLED); all of its sockets close.
  ACCOUNT_DISABLED: 4001,
  TOKEN_EXPIRED: 4002,
  PROTOCOL_ERROR: 4003,
  // 12.1: the identity already holds REALTIME_MAX_CONNECTIONS_PER_IDENTITY
  // sockets; the new one is refused (existing ones are kept).
  CONNECTION_LIMIT: 4004,
  // 12.5: the cluster lease store is unavailable; retry later.
  TRY_AGAIN_LATER: 1013,
  SHUTDOWN: 1001,
} as const;

// WebSocket transport. A socket starts AUTHENTICATING and must send
// {type:'AUTH', surface:'PLAYER'|'STAFF', token} with an ACCESS token before
// the timeout; tokens are never read from the URL. Each surface is verified
// by its own auth service, so a token never crosses surfaces. The socket is
// closed when its access token expires; clients reconnect with a new one.
@Injectable()
export class RealtimeGateway
  implements OnModuleInit, OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly authTimeoutMs: number;
  private readonly limits: ApplicationConfig['security']['realtime'];
  private readonly origins: readonly string[];
  private readonly production: boolean;
  // Sockets that have not authenticated yet (bounded).
  private pending = 0;
  private wss?: WebSocketServer;
  private unsubscribe?: () => void;
  // Access token of each authenticated Staff socket, kept only in memory to
  // re-check its session and grants when a Staff event is delivered.
  private readonly staffTokens = new Map<WebSocket, string>();
  // One in-flight re-check per socket, shared by concurrent deliveries.
  private readonly checks = new Map<WebSocket, Promise<Permission[] | null>>();
  // Player sessions revoked recently (bounded): an AUTH verified just before
  // the revocation committed is refused when it completes after it.
  private readonly revoked = new Map<string, number>();
  private unsubscribeSessions?: () => void;
  private unsubscribeAccounts?: () => void;
  // Cluster lease of each authenticated socket (MULTI).
  private readonly leases = new Map<WebSocket, string>();
  // Player deliveries in publish order (each waits for its session check).
  private playerChain: Promise<void> = Promise.resolve();
  private playerBacklog = 0;
  constructor(
    private readonly upgrades: WebSocketUpgradeRouter,
    private readonly bus: RealtimeEventBus,
    private readonly registry: RealtimeConnectionRegistry,
    private readonly players: PlayerAuthService,
    private readonly staff: AuthService,
    config: ConfigService<{ application: ApplicationConfig }, true>,
    private readonly addresses: ClientAddress,
    private readonly limiter: RateLimiter,
    private readonly security: SecurityLog,
    private readonly sessionControl: RealtimeSessionControl,
    @Optional() private readonly metrics?: Metrics,
    @Optional() private readonly clusterLeases?: RealtimeLeaseService,
  ) {
    if (metrics) {
      registry.observer = {
        dropped: () => metrics.realtimeSlowDrops.inc(),
        failed: () => metrics.realtimeDeliveryFailures.inc(),
      };
      metrics.onCollect(() => {
        metrics.realtimeConnections.set(
          { surface: 'player' },
          registry.surface('PLAYER').length,
        );
        metrics.realtimeConnections.set(
          { surface: 'staff' },
          registry.surface('STAFF').length,
        );
      });
    }
    const application = config.get('application', { infer: true });
    this.authTimeoutMs = application.realtime.authTimeoutMs;
    this.limits = application.security.realtime;
    this.origins = application.security.realtimeOrigins;
    this.production = application.nodeEnv === 'production';
  }
  // The upgrade router owns path matching (exact path, no query string).
  onModuleInit(): void {
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_REALTIME_FRAME_BYTES,
    });
    this.upgrades.register(REALTIME_PATH, this.upgrade);
  }
  onApplicationBootstrap(): void {
    this.unsubscribe = this.bus.subscribe((envelope, recipients) =>
      this.deliver(envelope, recipients),
    );
    this.unsubscribeSessions = this.sessionControl.subscribe((sessionId) =>
      this.revokeSession(sessionId),
    );
    this.unsubscribeAccounts = this.sessionControl.subscribeAccounts(
      (playerId, sessionIds) => this.revokeAccount(playerId, sessionIds),
    );
  }
  // After the account's sessions were revoked (12.4): an AUTH in flight for
  // any of them is refused, and every socket of the account closes.
  private revokeAccount(playerId: string, sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) this.trackRevoked(sessionId);
    const closed = this.registry.closeKey(
      connectionKey('PLAYER', playerId),
      RealtimeClose.ACCOUNT_DISABLED,
      'ACCOUNT_DISABLED',
    );
    if (closed) {
      this.metrics?.realtimeRejects.inc({ reason: 'account_disabled' }, closed);
      this.security.warn('realtime_account_disabled', { playerId, closed });
    }
  }
  private trackRevoked(sessionId: string): void {
    const now = Date.now();
    if (this.revoked.size >= MAX_REVOKED_TRACKED)
      for (const [id, at] of this.revoked)
        if (
          now - at > REVOKED_TRACK_MS ||
          this.revoked.size >= MAX_REVOKED_TRACKED
        )
          this.revoked.delete(id);
    this.revoked.set(sessionId, now);
  }
  // After the revocation committed: close exactly this session's sockets.
  private revokeSession(sessionId: string): void {
    this.trackRevoked(sessionId);
    const closed = this.registry.closePlayerSession(
      sessionId,
      RealtimeClose.SESSION_REVOKED,
      'SESSION_REVOKED',
    );
    if (closed) {
      this.metrics?.realtimeRejects.inc({ reason: 'session_revoked' }, closed);
      this.security.warn('realtime_session_revoked', { sessionId, closed });
    }
  }
  private recentlyRevoked(sessionId: string): boolean {
    const at = this.revoked.get(sessionId);
    return at !== undefined && Date.now() - at <= REVOKED_TRACK_MS;
  }
  // Graceful shutdown (12.2): after the workers stopped, before the
  // database closes. Clients reconnect to the next instance and refetch.
  beforeApplicationShutdown(): void {
    this.unsubscribe?.();
    this.unsubscribeSessions?.();
    this.unsubscribeAccounts?.();
    for (const socket of this.wss?.clients ?? [])
      socket.close(RealtimeClose.SHUTDOWN, 'SHUTDOWN');
    this.wss?.close();
  }
  // Server-chosen fan-out: Player events by identity, Staff events by
  // permission. Never awaited by the publisher (after its commit).
  private deliver(envelope: RealtimeEnvelope, recipients: RealtimeRecipients) {
    const frame = JSON.stringify(envelope);
    if (recipients.playerIds.length)
      this.metrics?.realtimeEvents.inc({ surface: 'player' });
    else if (recipients.staffPermission)
      this.metrics?.realtimeEvents.inc({ surface: 'staff' });
    if (recipients.playerIds.length)
      this.queuePlayers(recipients.playerIds, frame);
    const permission = recipients.staffPermission;
    if (!permission) return;
    for (const socket of this.registry.surface('STAFF'))
      void this.authorize(socket).then((grants) => {
        if (grants?.includes(permission))
          sendFrame(socket, frame, this.registry.observer);
      });
  }
  // Player delivery authorization (12.5): the database, not the revocation
  // signal, decides. Before writing a Player frame, the sessions of every
  // target socket are checked in ONE query (revoked, expired, account not
  // ACTIVE); sockets whose session is no longer live are closed and get
  // nothing, even if the close signal from another replica was lost. A
  // database failure skips the delivery (fail closed; HTTP recovers).
  // Deliveries run in publish order and the backlog is bounded.
  private queuePlayers(playerIds: readonly string[], frame: string): void {
    if (this.playerBacklog >= MAX_PLAYER_BACKLOG) {
      this.metrics?.realtimeDeliveryFailures.inc();
      return;
    }
    this.playerBacklog++;
    this.playerChain = this.playerChain
      .then(() => this.deliverPlayers(playerIds, frame))
      .catch(() => this.metrics?.realtimeDeliveryFailures.inc())
      .finally(() => this.playerBacklog--);
  }
  private async deliverPlayers(
    playerIds: readonly string[],
    frame: string,
  ): Promise<void> {
    const targets = playerIds.flatMap((playerId) =>
      this.registry.withSessions(connectionKey('PLAYER', playerId)),
    );
    if (!targets.length) return;
    const live = await this.players.liveSessions(
      targets.flatMap((t) => (t.session ? [t.session] : [])),
    );
    for (const { socket, session } of targets) {
      if (session && live.has(session)) {
        sendFrame(socket, frame, this.registry.observer);
        continue;
      }
      if (session) this.revokeSession(session);
      else socket.close(RealtimeClose.UNAUTHORIZED, 'UNAUTHORIZED');
    }
  }
  // Staff grants are re-read at every delivery through the same service as
  // HTTP (session, account status, current role), so a role change applies
  // to the next event and nothing is cached beyond one in-flight check. A
  // session that is no longer valid closes the socket; a database failure
  // only skips this delivery.
  private authorize(socket: WebSocket): Promise<Permission[] | null> {
    const pending = this.checks.get(socket);
    if (pending) return pending;
    const token = this.staffTokens.get(socket);
    if (!token) return Promise.resolve(null);
    const check = this.staff
      .authenticate(token)
      .then(
        (auth) => auth.permissions,
        (error: unknown) => {
          if (error instanceof UnauthorizedException)
            socket.close(RealtimeClose.UNAUTHORIZED, 'UNAUTHORIZED');
          return null;
        },
      )
      .finally(() => this.checks.delete(socket));
    this.checks.set(socket, check);
    return check;
  }
  // Admission before any WebSocket state (12.1, per process): browser
  // Origin allowlist, connection attempts per client IP (so AUTH floods,
  // one attempt per socket, are bounded too), unauthenticated and total
  // socket caps.
  private readonly upgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => {
    void this.admit(request, socket, head).catch(() => socket.destroy());
  };
  private async admit(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const ip = this.addresses.of(request);
    if (!this.originAllowed(request.headers.origin)) {
      this.security.warn('realtime_origin_refused', { ip });
      this.metrics?.realtimeRejects.inc({ reason: 'origin' });
      return rejectUpgrade(socket, 403);
    }
    const attempt = await this.limiter.consume('realtime-connect', ip, {
      limit: this.limits.connectsPerIpPerMinute,
      windowMs: 60_000,
    });
    if (!attempt.allowed) {
      this.security.warn('realtime_connect_throttled', { ip });
      this.metrics?.realtimeRejects.inc({ reason: 'rate' });
      return rejectUpgrade(socket, 429, attempt.retryAfterSeconds);
    }
    if (
      this.pending >= this.limits.maxPendingConnections ||
      this.pending + this.registry.count() >= this.limits.maxConnections
    ) {
      this.security.warn('realtime_capacity_refused', {
        ip,
        pending: this.pending,
        connected: this.registry.count(),
      });
      this.metrics?.realtimeRejects.inc({ reason: 'capacity' });
      return rejectUpgrade(socket, 503, 1);
    }
    if (socket.destroyed) return;
    this.wss!.handleUpgrade(request, socket, head, (ws) => this.connect(ws));
  }
  // A request without Origin is not a browser (Electron main process, native
  // client) and is judged by its token alone. A browser Origin must be in
  // REALTIME_ALLOWED_ORIGINS; with no allowlist, any browser Origin is
  // accepted only outside production.
  private originAllowed(origin: string | undefined): boolean {
    if (origin === undefined) return true;
    if (this.origins.length) return this.origins.includes(origin);
    return !this.production;
  }
  private connect(ws: WebSocket): void {
    let state: 'AUTHENTICATING' | 'VERIFYING' | 'AUTHENTICATED' =
      'AUTHENTICATING';
    let key: string | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let counted = true;
    this.pending++;
    const settle = () => {
      if (!counted) return;
      counted = false;
      this.pending--;
    };
    const timeout = setTimeout(() => {
      this.metrics?.realtimeRejects.inc({ reason: 'auth_timeout' });
      ws.close(RealtimeClose.AUTH_TIMEOUT, 'AUTH_TIMEOUT');
    }, this.authTimeoutMs);
    const refuse = (surface: RealtimeSurface, id: string) => {
      this.security.warn('realtime_identity_limit', {
        surface,
        id,
        max: this.limits.maxConnectionsPerIdentity,
      });
      this.metrics?.realtimeRejects.inc({ reason: 'identity_limit' });
      ws.close(RealtimeClose.CONNECTION_LIMIT, 'CONNECTION_LIMIT');
    };
    const accept = (
      surface: RealtimeSurface,
      token: string,
      identity: { id: string; sessionId?: string; expiresAt: Date },
    ) => {
      state = 'AUTHENTICATED';
      key = connectionKey(surface, identity.id);
      if (surface === 'STAFF') this.staffTokens.set(ws, token);
      this.registry.add(key, ws, identity.sessionId);
      expiry = setTimeout(
        () => ws.close(RealtimeClose.TOKEN_EXPIRED, 'TOKEN_EXPIRED'),
        Math.max(0, identity.expiresAt.getTime() - Date.now()),
      );
      ws.send(
        JSON.stringify({
          type: 'AUTHENTICATED',
          surface,
          expiresAt: identity.expiresAt.toISOString(),
        }),
      );
    };
    ws.on('message', (raw: RawData, isBinary: boolean) => {
      // Clients only send the AUTH frame; anything else is a protocol error.
      if (state !== 'AUTHENTICATING' || isBinary) {
        this.metrics?.realtimeRejects.inc({ reason: 'protocol' });
        ws.close(RealtimeClose.PROTOCOL_ERROR, 'PROTOCOL_ERROR');
        return;
      }
      state = 'VERIFYING';
      const frame = parseAuthFrame(raw);
      if (!frame) {
        this.metrics?.realtimeRejects.inc({ reason: 'protocol' });
        ws.close(RealtimeClose.PROTOCOL_ERROR, 'PROTOCOL_ERROR');
        return;
      }
      void this.identify(frame.surface, frame.token).then(async (identity) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (!identity) {
          this.metrics?.realtimeRejects.inc({ reason: 'auth_failed' });
          ws.close(RealtimeClose.UNAUTHORIZED, 'UNAUTHORIZED');
          return;
        }
        clearTimeout(timeout);
        settle();
        if (identity.sessionId && this.recentlyRevoked(identity.sessionId)) {
          this.metrics?.realtimeRejects.inc({ reason: 'session_revoked' });
          ws.close(RealtimeClose.SESSION_REVOKED, 'SESSION_REVOKED');
          return;
        }
        // SINGLE: the per-principal cap counts this registry. MULTI (12.5):
        // it counts every replica's sockets through cluster leases.
        if (!this.clusterLeases?.enabled) {
          if (
            this.registry.count(connectionKey(frame.surface, identity.id)) >=
            this.limits.maxConnectionsPerIdentity
          )
            return refuse(frame.surface, identity.id);
          return accept(frame.surface, frame.token, identity);
        }
        let lease: string | null;
        try {
          lease = await this.clusterLeases.acquire(
            frame.surface,
            identity.id,
            identity.sessionId,
            this.limits.maxConnectionsPerIdentity,
          );
        } catch {
          this.metrics?.realtimeRejects.inc({ reason: 'lease_unavailable' });
          ws.close(RealtimeClose.TRY_AGAIN_LATER, 'TRY_AGAIN_LATER');
          return;
        }
        if (!lease) return refuse(frame.surface, identity.id);
        if (ws.readyState !== WebSocket.OPEN) {
          void this.clusterLeases.release(lease);
          return;
        }
        this.leases.set(ws, lease);
        accept(frame.surface, frame.token, identity);
      });
    });
    ws.on('close', () => {
      settle();
      clearTimeout(timeout);
      if (expiry) clearTimeout(expiry);
      if (key) this.registry.remove(key, ws);
      this.staffTokens.delete(ws);
      const lease = this.leases.get(ws);
      if (lease) {
        this.leases.delete(ws);
        void this.clusterLeases?.release(lease);
      }
    });
    ws.on('error', () => ws.terminate());
  }
  // Access tokens only: both services verify the access audience, the
  // session and the account status. Failures reveal nothing to the client.
  private async identify(
    surface: RealtimeSurface,
    token: string,
  ): Promise<{ id: string; sessionId?: string; expiresAt: Date } | null> {
    try {
      let id: string;
      let sessionId: string | undefined;
      if (surface === 'PLAYER') {
        const auth = await this.players.authenticate(token);
        id = auth.player.id;
        sessionId = auth.sessionId;
      } else id = (await this.staff.authenticate(token)).user.id;
      const exp = decodeJwt(token).exp;
      if (typeof exp !== 'number') return null;
      return { id, sessionId, expiresAt: new Date(exp * 1000) };
    } catch {
      return null;
    }
  }
}
export function parseAuthFrame(
  raw: RawData,
): { surface: RealtimeSurface; token: string } | null {
  try {
    const value: unknown = JSON.parse(raw.toString());
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return null;
    const frame = value as Record<string, unknown>;
    const keys = Object.keys(frame).sort().join(',');
    if (
      keys !== 'surface,token,type' ||
      frame.type !== 'AUTH' ||
      (frame.surface !== 'PLAYER' && frame.surface !== 'STAFF') ||
      typeof frame.token !== 'string' ||
      !frame.token ||
      frame.token.length > 4096
    )
      return null;
    return { surface: frame.surface, token: frame.token };
  } catch {
    return null;
  }
}
