import { Injectable } from '@nestjs/common';
import type { WebSocket } from 'ws';

export type RealtimeSurface = 'PLAYER' | 'STAFF';
// Keys are derived from the authenticated identity, never from client input.
export const connectionKey = (surface: RealtimeSurface, id: string) =>
  `${surface}:${id}`;

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
    for (const socket of this.sockets.get(key) ?? [])
      if (socket.readyState === socket.OPEN) socket.send(frame);
  }
  all(): WebSocket[] {
    return [...this.sockets.values()].flatMap((set) => [...set]);
  }
}
