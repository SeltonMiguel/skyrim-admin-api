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
// Metrics hook (12.3): slow-client drops and failed writes.
export interface SendObserver {
  dropped(): void;
  failed(): void;
}
export function sendFrame(
  socket: Socket,
  frame: string,
  observer?: SendObserver,
): boolean {
  if (socket.readyState !== socket.OPEN) return false;
  if (socket.bufferedAmount > MAX_REALTIME_BUFFERED_BYTES) {
    observer?.dropped();
    socket.terminate();
    return false;
  }
  try {
    socket.send(frame);
    return true;
  } catch {
    observer?.failed();
    return false;
  }
}

// Authenticated sockets indexed by identity; one identity may hold many.
// Player sockets are also indexed by the session that authenticated them
// (its id only, never a token), so a revoked session closes exactly its
// own sockets (12.1).
@Injectable()
export class RealtimeConnectionRegistry {
  private readonly sockets = new Map<string, Set<WebSocket>>();
  observer?: SendObserver;
  private readonly sessions = new Map<string, Set<WebSocket>>();
  private readonly owners = new Map<
    WebSocket,
    { key: string; session?: string }
  >();
  add(key: string, socket: WebSocket, session?: string): void {
    const set = this.sockets.get(key) ?? new Set<WebSocket>();
    set.add(socket);
    this.sockets.set(key, set);
    this.owners.set(socket, { key, session });
    if (session) {
      const bySession = this.sessions.get(session) ?? new Set<WebSocket>();
      bySession.add(socket);
      this.sessions.set(session, bySession);
    }
  }
  // Idempotent: unknown or already removed sockets are ignored.
  remove(key: string, socket: WebSocket): void {
    const owner = this.owners.get(socket);
    if (owner && owner.key !== key) return;
    this.owners.delete(socket);
    const set = this.sockets.get(key);
    if (set) {
      set.delete(socket);
      if (!set.size) this.sockets.delete(key);
    }
    if (owner?.session) {
      const bySession = this.sessions.get(owner.session);
      bySession?.delete(socket);
      if (bySession && !bySession.size) this.sessions.delete(owner.session);
    }
  }
  // Unregisters, then closes, every socket of one Player session: nothing
  // published afterwards reaches them, even before their close completes.
  // Idempotent, tolerant of sockets already closing, and never touches
  // another session of the same account. Returns how many were closed.
  closePlayerSession(session: string, code: number, reason: string): number {
    const sockets = [...(this.sessions.get(session) ?? [])];
    for (const socket of sockets) {
      const owner = this.owners.get(socket);
      if (owner) this.remove(owner.key, socket);
      try {
        if (socket.readyState === socket.OPEN) socket.close(code, reason);
      } catch {
        socket.terminate();
      }
    }
    return sockets.length;
  }
  // Unregisters, then closes, every socket of one identity key (12.4:
  // account suspended or banned). Returns how many were closed.
  closeKey(key: string, code: number, reason: string): number {
    const sockets = [...(this.sockets.get(key) ?? [])];
    for (const socket of sockets) {
      this.remove(key, socket);
      try {
        if (socket.readyState === socket.OPEN) socket.close(code, reason);
      } catch {
        socket.terminate();
      }
    }
    return sockets.length;
  }
  sessionCount(session: string): number {
    return this.sessions.get(session)?.size ?? 0;
  }
  count(key?: string): number {
    if (key !== undefined) return this.sockets.get(key)?.size ?? 0;
    let total = 0;
    for (const set of this.sockets.values()) total += set.size;
    return total;
  }
  send(key: string, frame: string): void {
    for (const socket of this.sockets.get(key) ?? [])
      sendFrame(socket, frame, this.observer);
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
