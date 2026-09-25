import { Injectable, Logger } from '@nestjs/common';

export type SessionRevocationListener = (sessionId: string) => void;

// Domain-facing signal (12.1): the backend revoked a Player session
// (logout, refresh reuse). Published AFTER the revocation commits; the
// realtime transport closes every socket authenticated by that session.
// In-process only (single replica); distributed close is Etapa 12.5.
@Injectable()
export class RealtimeSessionControl {
  private readonly logger = new Logger(RealtimeSessionControl.name);
  private readonly listeners = new Set<SessionRevocationListener>();
  subscribe(listener: SessionRevocationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  playerSessionRevoked(sessionId: string): void {
    for (const listener of this.listeners)
      try {
        listener(sessionId);
      } catch {
        this.logger.error('Realtime session revocation listener failed');
      }
  }
}
