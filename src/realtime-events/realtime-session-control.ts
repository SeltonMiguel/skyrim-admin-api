import { Injectable, Logger } from '@nestjs/common';

export type SessionRevocationListener = (sessionId: string) => void;
export type AccountRevocationListener = (
  playerId: string,
  sessionIds: readonly string[],
) => void;

export interface SessionControlRelay {
  sessionRevoked(sessionId: string): void;
  accountRevoked(playerId: string, sessionIds: readonly string[]): void;
}

// Domain-facing signal (12.1): the backend revoked a Player session
// (logout, refresh reuse) or, 12.4, a whole account. Published AFTER the
// revocation commits; the realtime transport closes the matching sockets.
// MULTI (12.5): relayed to the other replicas through the cluster bus.
// Never the authority: Player delivery re-checks sessions in the database.
@Injectable()
export class RealtimeSessionControl {
  private readonly logger = new Logger(RealtimeSessionControl.name);
  private readonly listeners = new Set<SessionRevocationListener>();
  private readonly accounts = new Set<AccountRevocationListener>();
  private relay?: SessionControlRelay;
  setRelay(relay: SessionControlRelay): void {
    this.relay = relay;
  }
  subscribe(listener: SessionRevocationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  subscribeAccounts(listener: AccountRevocationListener): () => void {
    this.accounts.add(listener);
    return () => this.accounts.delete(listener);
  }
  // 12.4: a Staff moderator suspended or banned the account and every one of
  // its sessions was revoked in that commit. Every socket of the account
  // closes, whatever session authenticated it.
  playerAccountRevoked(playerId: string, sessionIds: readonly string[]): void {
    this.accountRevokedLocally(playerId, sessionIds);
    try {
      this.relay?.accountRevoked(playerId, sessionIds);
    } catch {
      this.logger.error('Realtime account revocation relay failed');
    }
  }
  accountRevokedLocally(playerId: string, sessionIds: readonly string[]): void {
    for (const listener of this.accounts)
      try {
        listener(playerId, sessionIds);
      } catch {
        this.logger.error('Realtime account revocation listener failed');
      }
  }
  playerSessionRevoked(sessionId: string): void {
    this.sessionRevokedLocally(sessionId);
    try {
      this.relay?.sessionRevoked(sessionId);
    } catch {
      this.logger.error('Realtime session revocation relay failed');
    }
  }
  sessionRevokedLocally(sessionId: string): void {
    for (const listener of this.listeners)
      try {
        listener(sessionId);
      } catch {
        this.logger.error('Realtime session revocation listener failed');
      }
  }
}
