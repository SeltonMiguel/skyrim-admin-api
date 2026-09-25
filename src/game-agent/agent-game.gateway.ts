import { Injectable, Logger } from '@nestjs/common';
import { BridgeClock } from '../game-bridge/bridge-clock.js';
import type { CommandEnvelope } from '../game-bridge/command-contract.js';
import { GameGateway } from '../game-bridge/game-gateway.js';
import type {
  GatewayConnection,
  TransportAcceptance,
} from '../game-bridge/game-gateway.js';
import { outbound } from './agent-protocol.contracts.js';
import { AgentSessionRegistry } from './agent-session.registry.js';

const UNAVAILABLE: TransportAcceptance = {
  accepted: false,
  reason: 'UNAVAILABLE',
};

// Production GameGateway (11.2): delivers a reserved attempt as a COMMAND
// frame to exactly the Host Agent session the attempt was reserved for.
// The dispatcher calls it after committing the reservation and with no
// transaction open. UNAVAILABLE is only returned when nothing was written
// to the socket (proven non-delivery): session gone or replaced, runtime
// not ready, or command not supported. It never picks another session.
@Injectable()
export class AgentGameGateway extends GameGateway {
  private readonly logger = new Logger(AgentGameGateway.name);
  constructor(
    private readonly sessions: AgentSessionRegistry,
    private readonly clock: BridgeClock,
  ) {
    super();
  }
  async send(
    connection: GatewayConnection,
    envelope: CommandEnvelope,
    signal: AbortSignal,
  ): Promise<TransportAcceptance> {
    const { gameServerId, id: connectionId } = connection;
    const ids = `commandId=${envelope.commandId} gameServerId=${gameServerId} connectionId=${connectionId} attempt=${envelope.attempt} commandType=${envelope.type}`;
    if (signal.aborted) return UNAVAILABLE;
    const session = this.sessions.getSession(gameServerId);
    if (session?.connectionId !== connectionId) {
      this.logger.warn(`Game command not sent: session changed [${ids}]`);
      return UNAVAILABLE;
    }
    if (!this.sessions.isRuntimeReady(gameServerId)) {
      this.logger.warn(`Game command not sent: runtime not ready [${ids}]`);
      return UNAVAILABLE;
    }
    if (!this.sessions.supportsCommand(gameServerId, envelope.type)) {
      this.logger.warn(`Game command not sent: capability missing [${ids}]`);
      return UNAVAILABLE;
    }
    // The server and session come from the socket; the HTTP idempotency key
    // stays in the backend (commandId is the execution identity).
    const sent = this.sessions.send(
      gameServerId,
      connectionId,
      outbound(
        'COMMAND',
        gameServerId,
        {
          commandId: envelope.commandId,
          correlationId: envelope.correlationId,
          attempt: envelope.attempt,
          type: envelope.type,
          payload: envelope.payload,
          issuedAt: envelope.issuedAt,
          ackDeadlineAt: envelope.ackDeadlineAt,
          executionDeadlineAt: envelope.executionDeadlineAt,
        },
        this.clock.now(),
      ),
    );
    if (!sent) return UNAVAILABLE;
    this.logger.log(
      `Game command ${envelope.attempt > 1 ? 'retried' : 'dispatched'} [${ids}]`,
    );
    return { accepted: true };
  }
}
