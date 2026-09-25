import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { decodeJwt } from 'jose';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import type { ApplicationConfig } from '../config/environment.js';
import { AuthService } from '../auth/auth.service.js';
import { PlayerAuthService } from '../player-auth/player-auth.service.js';
import { RealtimeEventBus } from '../realtime-events/realtime-event-bus.js';
import type {
  RealtimeEnvelope,
  RealtimeRecipients,
} from '../realtime-events/realtime-event-bus.js';
import {
  connectionKey,
  RealtimeConnectionRegistry,
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
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly authTimeoutMs: number;
  private wss?: WebSocketServer;
  private server?: Server;
  private unsubscribe?: () => void;
  constructor(
    private readonly adapterHost: HttpAdapterHost,
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
  onApplicationBootstrap(): void {
    this.server = this.adapterHost.httpAdapter.getHttpServer() as Server;
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_REALTIME_FRAME_BYTES,
    });
    this.server.on('upgrade', this.upgrade);
    this.unsubscribe = this.bus.subscribe((envelope, recipients) =>
      this.deliver(envelope, recipients),
    );
  }
  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.server?.off('upgrade', this.upgrade);
    for (const socket of this.wss?.clients ?? [])
      socket.close(RealtimeClose.SHUTDOWN, 'SHUTDOWN');
    this.wss?.close();
  }
  // Server-chosen fan-out; Group events currently target players only.
  private deliver(envelope: RealtimeEnvelope, recipients: RealtimeRecipients) {
    const frame = JSON.stringify(envelope);
    for (const playerId of recipients.playerIds)
      this.registry.send(connectionKey('PLAYER', playerId), frame);
  }
  private readonly upgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    // Exact path and no query string: credentials must not travel in URLs.
    if (url.pathname !== REALTIME_PATH || url.search) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
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
