import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
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
import type {
  RealtimeEnvelope,
  RealtimeRecipients,
} from '../realtime-events/realtime-event-bus.js';
import type { Permission } from '../rbac/permissions.js';
import {
  connectionKey,
  RealtimeConnectionRegistry,
  sendFrame,
} from './realtime-connection.registry.js';
import type { RealtimeSurface } from './realtime-connection.registry.js';

export const REALTIME_PATH = '/api/v1/realtime';
export const MAX_REALTIME_FRAME_BYTES = 16 * 1024;
// Application close codes (4000–4999).
export const RealtimeClose = {
  AUTH_TIMEOUT: 4000,
  UNAUTHORIZED: 4001,
  TOKEN_EXPIRED: 4002,
  PROTOCOL_ERROR: 4003,
  SHUTDOWN: 1001,
} as const;

// WebSocket transport. A socket starts AUTHENTICATING and must send
// {type:'AUTH', surface:'PLAYER'|'STAFF', token} with an ACCESS token before
// the timeout; tokens are never read from the URL. Each surface is verified
// by its own auth service, so a token never crosses surfaces. The socket is
// closed when its access token expires; clients reconnect with a new one.
@Injectable()
export class RealtimeGateway
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly authTimeoutMs: number;
  private wss?: WebSocketServer;
  private unsubscribe?: () => void;
  // Access token of each authenticated Staff socket, kept only in memory to
  // re-check its session and grants when a Staff event is delivered.
  private readonly staffTokens = new Map<WebSocket, string>();
  // One in-flight re-check per socket, shared by concurrent deliveries.
  private readonly checks = new Map<WebSocket, Promise<Permission[] | null>>();
  constructor(
    private readonly upgrades: WebSocketUpgradeRouter,
    private readonly bus: RealtimeEventBus,
    private readonly registry: RealtimeConnectionRegistry,
    private readonly players: PlayerAuthService,
    private readonly staff: AuthService,
    config: ConfigService<{ application: ApplicationConfig }, true>,
  ) {
    this.authTimeoutMs = config.get('application', {
      infer: true,
    }).realtime.authTimeoutMs;
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
  }
  onModuleDestroy(): void {
    this.unsubscribe?.();
    for (const socket of this.wss?.clients ?? [])
      socket.close(RealtimeClose.SHUTDOWN, 'SHUTDOWN');
    this.wss?.close();
  }
  // Server-chosen fan-out: Player events by identity, Staff events by
  // permission. Never awaited by the publisher (after its commit).
  private deliver(envelope: RealtimeEnvelope, recipients: RealtimeRecipients) {
    const frame = JSON.stringify(envelope);
    for (const playerId of recipients.playerIds)
      this.registry.send(connectionKey('PLAYER', playerId), frame);
    const permission = recipients.staffPermission;
    if (!permission) return;
    for (const socket of this.registry.surface('STAFF'))
      void this.authorize(socket).then((grants) => {
        if (grants?.includes(permission)) sendFrame(socket, frame);
      });
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
  private readonly upgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => {
    this.wss!.handleUpgrade(request, socket, head, (ws) => this.connect(ws));
  };
  private connect(ws: WebSocket): void {
    let state: 'AUTHENTICATING' | 'VERIFYING' | 'AUTHENTICATED' =
      'AUTHENTICATING';
    let key: string | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(
      () => ws.close(RealtimeClose.AUTH_TIMEOUT, 'AUTH_TIMEOUT'),
      this.authTimeoutMs,
    );
    ws.on('message', (raw: RawData, isBinary: boolean) => {
      // Clients only send the AUTH frame; anything else is a protocol error.
      if (state !== 'AUTHENTICATING' || isBinary) {
        ws.close(RealtimeClose.PROTOCOL_ERROR, 'PROTOCOL_ERROR');
        return;
      }
      state = 'VERIFYING';
      const frame = parseAuthFrame(raw);
      if (!frame) {
        ws.close(RealtimeClose.PROTOCOL_ERROR, 'PROTOCOL_ERROR');
        return;
      }
      void this.identify(frame.surface, frame.token).then((identity) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (!identity) {
          ws.close(RealtimeClose.UNAUTHORIZED, 'UNAUTHORIZED');
          return;
        }
        clearTimeout(timeout);
        state = 'AUTHENTICATED';
        key = connectionKey(frame.surface, identity.id);
        if (frame.surface === 'STAFF') this.staffTokens.set(ws, frame.token);
        this.registry.add(key, ws);
        expiry = setTimeout(
          () => ws.close(RealtimeClose.TOKEN_EXPIRED, 'TOKEN_EXPIRED'),
          Math.max(0, identity.expiresAt.getTime() - Date.now()),
        );
        ws.send(
          JSON.stringify({
            type: 'AUTHENTICATED',
            surface: frame.surface,
            expiresAt: identity.expiresAt.toISOString(),
          }),
        );
      });
    });
    ws.on('close', () => {
      clearTimeout(timeout);
      if (expiry) clearTimeout(expiry);
      if (key) this.registry.remove(key, ws);
      this.staffTokens.delete(ws);
    });
    ws.on('error', () => ws.terminate());
  }
  // Access tokens only: both services verify the access audience, the
  // session and the account status. Failures reveal nothing to the client.
  private async identify(
    surface: RealtimeSurface,
    token: string,
  ): Promise<{ id: string; expiresAt: Date } | null> {
    try {
      const id =
        surface === 'PLAYER'
          ? (await this.players.authenticate(token)).player.id
          : (await this.staff.authenticate(token)).user.id;
      const exp = decodeJwt(token).exp;
      if (typeof exp !== 'number') return null;
      return { id, expiresAt: new Date(exp * 1000) };
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
