import { Injectable, Logger } from '@nestjs/common';
import { BridgeClock } from '../game-bridge/bridge-clock.js';
import { ServerControlGateway } from '../server-control/server-control-gateway.js';
import type {
  ServerControlAcceptance,
  ServerControlRequest,
} from '../server-control/server-control-gateway.js';
import type { ServerControlType } from '../server-control/server-control.contracts.js';
import { outbound } from './agent-protocol.contracts.js';
import { AgentSessionRegistry } from './agent-session.registry.js';

const UNAVAILABLE: ServerControlAcceptance = {
  accepted: false,
  reason: 'UNAVAILABLE',
};

// Production ServerControlGateway (11.3). Requires only an ACTIVE Host Agent
// session with the Server Control capability of the action; never the game
// runtime (START must work with Skyrim STOPPED, without SKSE). Sends one
// SERVER_CONTROL frame to exactly the session fixed at the claim and never
// redirects it. UNAVAILABLE only when nothing was written to the socket.
@Injectable()
export class AgentServerControlGateway extends ServerControlGateway {
  private readonly logger = new Logger(AgentServerControlGateway.name);
  constructor(
    private readonly sessions: AgentSessionRegistry,
    private readonly clock: BridgeClock,
  ) {
    super();
  }
  target(gameServerId: string, type: ServerControlType): string | null {
    const session = this.sessions.getSession(gameServerId);
    return session && this.sessions.supportsServerControl(gameServerId, type)
      ? session.connectionId
      : null;
  }
  async send(
    request: ServerControlRequest,
    signal: AbortSignal,
  ): Promise<ServerControlAcceptance> {
    const { gameServerId, connectionId } = request;
    const ids = `operationId=${request.operationId} gameServerId=${gameServerId} connectionId=${connectionId} action=${request.type}`;
    if (signal.aborted) return UNAVAILABLE;
    if (this.sessions.getSession(gameServerId)?.connectionId !== connectionId) {
      this.logger.warn(`Server control not sent: session changed [${ids}]`);
      return UNAVAILABLE;
    }
    if (!this.sessions.supportsServerControl(gameServerId, request.type)) {
      this.logger.warn(`Server control not sent: capability missing [${ids}]`);
      return UNAVAILABLE;
    }
    // Only the typed action and its identity; server and session come from
    // the envelope/socket. No actor, JWT, idempotency key or process text.
    const sent = this.sessions.send(
      gameServerId,
      connectionId,
      outbound(
        'SERVER_CONTROL',
        gameServerId,
        {
          operationId: request.operationId,
          correlationId: request.correlationId,
          type: request.type,
          issuedAt: request.issuedAt,
          notAfter: request.notAfter,
        },
        this.clock.now(),
      ),
    );
    if (!sent) {
      this.logger.warn(`Server control not sent: socket closed [${ids}]`);
      return UNAVAILABLE;
    }
    this.logger.log(
      `Server control dispatched [${ids} notAfter=${request.notAfter}]`,
    );
    return { accepted: true };
  }
}
