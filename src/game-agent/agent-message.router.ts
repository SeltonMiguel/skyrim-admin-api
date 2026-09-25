import { Injectable, Logger } from '@nestjs/common';
import { BridgeClock } from '../game-bridge/bridge-clock.js';
import { GameConnectionService } from '../game-bridge/game-connection.service.js';
import {
  AGENT_FUTURE_INBOUND_TYPES,
  AgentProtocolError,
  heartbeatPayload,
  isInboundType,
  outbound,
} from './agent-protocol.contracts.js';
import type {
  AgentEnvelope,
  AgentErrorCode,
  AgentOutboundType,
} from './agent-protocol.contracts.js';
import { AgentCommandAdapter } from './agent-command.adapter.js';
import { AgentServerControlAdapter } from './agent-server-control.adapter.js';
import type { RouteOutcome } from './agent-command.adapter.js';
import { AgentSessionRegistry } from './agent-session.registry.js';
import type { AgentSessionSnapshot } from './agent-session.registry.js';

export type { RouteOutcome } from './agent-command.adapter.js';
// Flows owned by later substeps: typed, answered, never executed here.
const NOT_IMPLEMENTED = new Set([
  'DOMAIN_EVENT', // 11.4
]);

// Authenticated frames only. Validates the envelope against the session and
// dispatches by type to typed handlers. No business rules and no domain
// repositories: later handlers call domain services, injecting the
// gameServerId of the authenticated session, never the one of a payload.
@Injectable()
export class AgentMessageRouter {
  private readonly logger = new Logger(AgentMessageRouter.name);
  constructor(
    private readonly connections: GameConnectionService,
    private readonly sessions: AgentSessionRegistry,
    private readonly commands: AgentCommandAdapter,
    private readonly serverControl: AgentServerControlAdapter,
    private readonly clock: BridgeClock,
  ) {}
  async route(
    session: AgentSessionSnapshot,
    envelope: AgentEnvelope,
  ): Promise<RouteOutcome> {
    const ids = `gameServerId=${session.gameServerId} connectionId=${session.connectionId} messageId=${envelope.messageId}`;
    // Cross-server injection: a session speaks only for its own server.
    if (envelope.gameServerId !== session.gameServerId) {
      this.logger.warn(
        `Agent frame for another server rejected [${ids} frameServerId=${envelope.gameServerId} type=${envelope.type}]`,
      );
      return { close: 'SERVER_MISMATCH' };
    }
    const type = envelope.type;
    if (
      !isInboundType(type) ||
      type === 'HELLO' ||
      (AGENT_FUTURE_INBOUND_TYPES as readonly string[]).includes(type)
    ) {
      this.logger.warn(`Agent protocol violation [${ids} reason=TYPE]`);
      return { close: 'PROTOCOL_ERROR' };
    }
    if (type === 'HEARTBEAT') return this.heartbeat(session, envelope);
    if (type === 'COMMAND_ACK')
      return this.commands.acknowledge(session, envelope);
    if (type === 'COMMAND_RESULT')
      return this.commands.result(session, envelope);
    if (type === 'SERVER_CONTROL_RESULT')
      return this.serverControl.result(session, envelope);
    if (type === 'ERROR') {
      this.logger.warn(`Agent reported an error [${ids}]`);
      return {};
    }
    if (NOT_IMPLEMENTED.has(type))
      return {
        reply: this.error(session, envelope, 'NOT_IMPLEMENTED'),
      };
    return { close: 'PROTOCOL_ERROR' };
  }
  private async heartbeat(
    session: AgentSessionSnapshot,
    envelope: AgentEnvelope,
  ): Promise<RouteOutcome> {
    let runtime;
    try {
      runtime = heartbeatPayload(envelope.payload);
    } catch (error) {
      if (error instanceof AgentProtocolError) {
        this.logger.warn(
          `Agent protocol violation [gameServerId=${session.gameServerId} connectionId=${session.connectionId} reason=HEARTBEAT]`,
        );
        return { close: 'PROTOCOL_ERROR' };
      }
      throw error;
    }
    // The database decides liveness (disabled server, superseded or stale
    // session all return false); the registry only mirrors it.
    const alive = await this.connections.heartbeat(
      session.gameServerId,
      session.connectionId,
      runtime,
    );
    if (!alive) return { close: 'SESSION_CLOSED' };
    const now = this.clock.now();
    this.sessions.heartbeat(
      session.gameServerId,
      session.connectionId,
      runtime,
      now,
    );
    return {
      reply: outbound(
        'HEARTBEAT_ACK',
        session.gameServerId,
        { inReplyTo: envelope.messageId, serverTime: now.toISOString() },
        now,
      ),
    };
  }
  private error(
    session: AgentSessionSnapshot,
    envelope: AgentEnvelope,
    code: AgentErrorCode,
  ): AgentEnvelope<AgentOutboundType> {
    return outbound(
      'ERROR',
      session.gameServerId,
      { inReplyTo: envelope.messageId, code, retryable: false },
      this.clock.now(),
    );
  }
}
