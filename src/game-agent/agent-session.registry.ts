import { Injectable } from '@nestjs/common';
import { AgentClose, isRuntimeReady } from './agent-protocol.contracts.js';
import type { CommandType } from '../game-bridge/command-contract.js';
import { supportsCommand } from './agent-capabilities.js';
import type {
  AgentCloseReason,
  AgentEnvelope,
  AgentOutboundType,
  AgentRuntime,
} from './agent-protocol.contracts.js';

// The part of a ws socket the registry needs; keeps it testable.
export interface AgentSocket {
  readonly readyState: number;
  readonly OPEN: number;
  send(data: string): void;
  close(code: number, reason: string): void;
}
export interface AgentSessionSnapshot {
  connectionId: string;
  gameServerId: string;
  credentialId: string;
  agentVersion: string;
  capabilities: readonly string[];
  runtime: Readonly<AgentRuntime>;
  connectedAt: Date;
  lastHeartbeatAt: Date;
}
interface AgentSession extends AgentSessionSnapshot {
  socket: AgentSocket;
}

// In-memory Host Agent sessions of this (single) instance. Transport state
// only: no domain rules and no persistence. Multi-instance routing is
// Etapa 12.
//
// Lifecycle: AUTHENTICATING -> ACTIVE. A session is AUTHENTICATING from
// after its HELLO transaction committed until the post-commit revalidation
// promotes it; it is kept apart from the ACTIVE map, so the public reads
// (getSession, isConnected, isRuntimeReady, supports, send) never see it.
// Revocation and cleanup (byCredential, terminate, remove) see both.
@Injectable()
export class AgentSessionRegistry {
  // ACTIVE, one per GameServer.
  private readonly active = new Map<string, AgentSession>();
  // AUTHENTICATING, by connectionId (several may race for one server).
  private readonly authenticating = new Map<string, AgentSession>();
  begin(snapshot: AgentSessionSnapshot, socket: AgentSocket): void {
    this.authenticating.set(snapshot.connectionId, {
      ...snapshot,
      capabilities: Object.freeze([...snapshot.capabilities]),
      runtime: Object.freeze({ ...snapshot.runtime }),
      socket,
    });
  }
  // Promotes an AUTHENTICATING session to ACTIVE. Only then is the session
  // it replaces closed as SUPERSEDED (the database already agrees). Returns
  // false when the session is gone (revoked, closed) meanwhile.
  activate(
    gameServerId: string,
    connectionId: string,
  ): { activated: boolean; superseded?: AgentSessionSnapshot } {
    const session = this.authenticating.get(connectionId);
    if (!session || session.gameServerId !== gameServerId)
      return { activated: false };
    this.authenticating.delete(connectionId);
    const previous = this.active.get(gameServerId);
    this.active.set(gameServerId, session);
    if (!previous) return { activated: true };
    previous.socket.close(AgentClose.SUPERSEDED, 'SUPERSEDED');
    return { activated: true, superseded: this.snapshot(previous) };
  }
  // Removes only the given session (ACTIVE or AUTHENTICATING), never a
  // newer one of the same server.
  remove(gameServerId: string, connectionId: string): boolean {
    if (this.authenticating.get(connectionId)?.gameServerId === gameServerId) {
      this.authenticating.delete(connectionId);
      return true;
    }
    if (this.active.get(gameServerId)?.connectionId !== connectionId)
      return false;
    this.active.delete(gameServerId);
    return true;
  }
  getSession(gameServerId: string): AgentSessionSnapshot | undefined {
    const session = this.active.get(gameServerId);
    return session && this.snapshot(session);
  }
  isConnected(gameServerId: string): boolean {
    return this.active.has(gameServerId);
  }
  // Game ready: ACTIVE, process RUNNING and SKSE ready.
  isRuntimeReady(gameServerId: string): boolean {
    const session = this.active.get(gameServerId);
    return !!session && isRuntimeReady(session.runtime);
  }
  // Operational compatibility only; it grants nothing.
  supports(gameServerId: string, capability: string): boolean {
    return !!this.active.get(gameServerId)?.capabilities.includes(capability);
  }
  // Whether the ACTIVE session can execute this command type (protocol,
  // type and, for mutations, the durable dedup journal).
  supportsCommand(gameServerId: string, type: CommandType): boolean {
    const session = this.active.get(gameServerId);
    return !!session && supportsCommand(session.capabilities, type);
  }
  // Delivers to exactly this ACTIVE session; never to an AUTHENTICATING one
  // and never redirected to a newer one. Not used by GameCommand dispatch
  // until 11.2.
  send(
    gameServerId: string,
    connectionId: string,
    frame: AgentEnvelope<AgentOutboundType>,
  ): boolean {
    const session = this.activeSession(gameServerId, connectionId);
    if (!session || session.socket.readyState !== session.socket.OPEN)
      return false;
    session.socket.send(JSON.stringify(frame));
    return true;
  }
  heartbeat(
    gameServerId: string,
    connectionId: string,
    runtime: AgentRuntime & { capabilities?: readonly string[] },
    at: Date,
  ): boolean {
    const session = this.activeSession(gameServerId, connectionId);
    if (!session) return false;
    session.lastHeartbeatAt = at;
    session.runtime = Object.freeze({
      gameProcessState: runtime.gameProcessState,
      skseReady: runtime.skseReady,
    });
    if (runtime.capabilities)
      session.capabilities = Object.freeze([...runtime.capabilities]);
    return true;
  }
  // ACTIVE sessions silent for at least timeoutMs.
  expired(now: Date, timeoutMs: number): AgentSessionSnapshot[] {
    return [...this.active.values()]
      .filter(
        (session) =>
          now.getTime() - session.lastHeartbeatAt.getTime() >= timeoutMs,
      )
      .map((session) => this.snapshot(session));
  }
  // ACTIVE and AUTHENTICATING: a revocation must reach both.
  byCredential(credentialId: string): AgentSessionSnapshot[] {
    return this.everything()
      .filter((session) => session.credentialId === credentialId)
      .map((session) => this.snapshot(session));
  }
  // ACTIVE sessions only (the ones the worker may dispatch to).
  activeSessions(): AgentSessionSnapshot[] {
    return [...this.active.values()].map((session) => this.snapshot(session));
  }
  // ACTIVE and AUTHENTICATING, for shutdown.
  all(): AgentSessionSnapshot[] {
    return this.everything().map((session) => this.snapshot(session));
  }
  // Every tracked session, ACTIVE or AUTHENTICATING (leak checks).
  count(): number {
    return this.active.size + this.authenticating.size;
  }
  // Removes the session (ACTIVE or AUTHENTICATING, if still current) and
  // closes its socket.
  terminate(
    gameServerId: string,
    connectionId: string,
    reason: AgentCloseReason,
  ): boolean {
    const session =
      this.authenticating.get(connectionId) ??
      this.activeSession(gameServerId, connectionId);
    if (!session || !this.remove(gameServerId, connectionId)) return false;
    session.socket.close(AgentClose[reason], reason);
    return true;
  }
  private everything(): AgentSession[] {
    return [...this.active.values(), ...this.authenticating.values()];
  }
  private activeSession(
    gameServerId: string,
    connectionId: string,
  ): AgentSession | undefined {
    const session = this.active.get(gameServerId);
    return session?.connectionId === connectionId ? session : undefined;
  }
  private snapshot(session: AgentSession): AgentSessionSnapshot {
    const { socket, ...snapshot } = session;
    void socket;
    return { ...snapshot };
  }
}
