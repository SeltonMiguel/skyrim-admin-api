import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

export type UpgradeHandler = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => void;

// The single owner of the HTTP `upgrade` event. Each WebSocket surface
// registers an exact path; anything else (unknown path, any query string) is
// refused here, so surfaces never compete for, or reject, each other's
// upgrades. Credentials never travel in URLs, so no surface needs a query.
@Injectable()
export class WebSocketUpgradeRouter
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly routes = new Map<string, UpgradeHandler>();
  private server?: Server;
  constructor(private readonly adapterHost: HttpAdapterHost) {}
  register(path: string, handler: UpgradeHandler): void {
    if (this.routes.has(path))
      throw new Error(`WebSocket path already registered: ${path}`);
    this.routes.set(path, handler);
  }
  onApplicationBootstrap(): void {
    this.server = this.adapterHost.httpAdapter.getHttpServer() as Server;
    this.server.on('upgrade', this.upgrade);
  }
  onModuleDestroy(): void {
    this.server?.off('upgrade', this.upgrade);
  }
  // Exposed for unit tests; production traffic arrives via the listener.
  readonly upgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    const handler = resolveUpgrade(request.url, this.routes);
    if (!handler) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    handler(request, socket, head);
  };
}
export function resolveUpgrade<T>(
  rawUrl: string | undefined,
  routes: ReadonlyMap<string, T>,
): T | undefined {
  const url = new URL(rawUrl ?? '/', 'http://localhost');
  if (url.search) return undefined;
  return routes.get(url.pathname);
}
