import { Injectable } from '@nestjs/common';
import type { WebSocket } from 'ws';

export type RealtimeSurface = 'PLAYER' | 'STAFF';
// Keys are derived from the authenticated identity, never from client input.
export const connectionKey = (surface: RealtimeSurface, id: string) =>
  `${surface}:${id}`;
// Frames queued on one socket that the peer has not read yet. Above it the
// client is evidently not keeping up: its socket is dropped (it reconnects
// and refetches over HTTP) instead of growing an unbounded buffer.
export const MAX_REALTIME_BUFFERED_BYTES = 256 * 1024;
type Socket = Pick<
  WebSocket,
  'readyState' | 'OPEN' | 'bufferedAmount' | 'send' | 'terminate'
>;
// Best effort, never throws: a closed socket is skipped, a slow one dropped.
export function sendFrame(socket: Socket, frame: string): boolean {
  if (socket.readyState !== socket.OPEN) return false;
  if (socket.bufferedAmount > MAX_REALTIME_BUFFERED_BYTES) {
    socket.terminate();
    return false;
  }
  try {
    socket.send(frame);
    return true;
  } catch {
    return false;
  }
}

// Authenticated sockets indexed by identity; one identity may hold many.
@Injectable()
export class RealtimeConnectionRegistry {
  private readonly sockets = new Map<string, Set<WebSocket>>();
  add(key: string, socket: WebSocket): void {
    const set = this.sockets.get(key) ?? new Set<WebSocket>();
    set.add(socket);
    this.sockets.set(key, set);
  }
  remove(key: string, socket: WebSocket): void {
    const set = this.sockets.get(key);
    if (!set) return;
    set.delete(socket);
    if (!set.size) this.sockets.delete(key);
  }
  count(key?: string): number {
    if (key !== undefined) return this.sockets.get(key)?.size ?? 0;
    let total = 0;
    for (const set of this.sockets.values()) total += set.size;
    return total;
  }
  send(key: string, frame: string): void {
    for (const socket of this.sockets.get(key) ?? []) sendFrame(socket, frame);
  }
  all(): WebSocket[] {
    return [...this.sockets.values()].flatMap((set) => [...set]);
  }
  // Sockets of one surface (Staff fan-out is by permission, not identity).
  surface(surface: RealtimeSurface): WebSocket[] {
    return [...this.sockets.entries()]
      .filter(([key]) => key.startsWith(`${surface}:`))
      .flatMap(([, set]) => [...set]);
  }
}
