import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { BridgeClock } from '../game-bridge/bridge-clock.js';
import { GameConnectionService } from '../game-bridge/game-connection.service.js';
import { ServerControlReceiver } from '../server-control/server-control-receiver.js';
import { ServerControlRejection } from '../server-control/server-control-rejection.js';
import {
  AgentProtocolError,
  outbound,
  serverControlResultPayload,
} from './agent-protocol.contracts.js';
import type {
  AgentEnvelope,
  AgentErrorCode,
} from './agent-protocol.contracts.js';
import type { RouteOutcome } from './agent-command.adapter.js';
import { AgentSessionRegistry } from './agent-session.registry.js';
import type { AgentSessionSnapshot } from './agent-session.registry.js';

// Typed adapter between SERVER_CONTROL_RESULT frames and the Server Control
// receiver, always with the server and connection of the authenticated
// session. No lifecycle rule lives here: the receiver decides. It also
// refreshes the runtime snapshot the Agent reported with the result; that
// snapshot never decides the outcome.
@Injectable()
export class AgentServerControlAdapter {
  private readonly logger = new Logger(AgentServerControlAdapter.name);
  constructor(
    private readonly receiver: ServerControlReceiver,
    private readonly connections: GameConnectionService,
    private readonly sessions: AgentSessionRegistry,
    private readonly clock: BridgeClock,
  ) {}
  async result(
    session: AgentSessionSnapshot,
    envelope: AgentEnvelope,
  ): Promise<RouteOutcome> {
    let payload;
    try {
      payload = serverControlResultPayload(envelope.payload);
    } catch (error) {
      if (!(error instanceof AgentProtocolError)) throw error;
      this.logger.warn(
        `Invalid server control result [gameServerId=${session.gameServerId} connectionId=${session.connectionId}]`,
      );
      return this.error(session, envelope, 'INVALID_MESSAGE');
    }
    const ids = `operationId=${payload.operationId} gameServerId=${session.gameServerId} connectionId=${session.connectionId} action=${payload.type} outcome=${payload.outcome}`;
    try {
      const { runtime, ...result } = payload;
      const { operation, duplicate, accepted } = await this.receiver.receive({
        ...result,
        gameServerId: session.gameServerId,
        connectionId: session.connectionId,
      });
      if (runtime) {
        await this.connections.updateRuntime(
          session.gameServerId,
          session.connectionId,
          runtime,
        );
        this.sessions.updateRuntime(
          session.gameServerId,
          session.connectionId,
          runtime,
        );
      }
      const verdict = duplicate
        ? 'duplicate'
        : accepted
          ? 'accepted'
          : 'superseded by deadline';
      if (!duplicate && operation.status === 'UNCERTAIN')
        this.logger.warn(
          `Server control outcome UNCERTAIN [${ids} errorCode=${operation.errorCode} metric=server_control_uncertain_total]`,
        );
      this.logger.log(
        `Server control result ${verdict} [${ids} status=${operation.status}]`,
      );
      return {
        reply: outbound(
          'SERVER_CONTROL_RESULT_ACK',
          session.gameServerId,
          {
            inReplyTo: envelope.messageId,
            operationId: operation.id,
            status: operation.status,
            accepted,
            duplicate,
          },
          this.clock.now(),
        ),
      };
    } catch (error) {
      if (error instanceof ServerControlRejection)
        switch (error.code) {
          case 'SERVER_MISMATCH':
            this.logger.warn(
              `Server control result of another server rejected [${ids}]`,
            );
            return { close: 'SERVER_MISMATCH' };
          case 'INACTIVE_SESSION':
            return { close: 'SESSION_CLOSED' };
          case 'RESULT_CONFLICT':
            this.logger.warn(
              `Conflicting server control result rejected [${ids}]`,
            );
            return this.error(session, envelope, 'RESULT_CONFLICT');
          case 'NOT_DISPATCHED':
            this.logger.warn(
              `Result for an undispatched server control operation [${ids}]`,
            );
            return this.error(session, envelope, 'NOT_DISPATCHED');
          case 'OPERATION_MISMATCH':
            this.logger.warn(`Server control result action mismatch [${ids}]`);
            return this.error(session, envelope, 'OPERATION_MISMATCH');
          default:
            this.logger.warn(
              `Server control result rejected [${ids} reason=${error.code}]`,
            );
            return this.error(session, envelope, 'INVALID_MESSAGE');
        }
      if (error instanceof NotFoundException) {
        this.logger.warn(`Unknown server control operation [${ids}]`);
        return this.error(session, envelope, 'UNKNOWN_OPERATION');
      }
      this.logger.error(`Server control result not processed [${ids}]`);
      return this.error(session, envelope, 'TEMPORARILY_UNAVAILABLE', true);
    }
  }
  private error(
    session: AgentSessionSnapshot,
    envelope: AgentEnvelope,
    code: AgentErrorCode,
    retryable = false,
  ): RouteOutcome {
    return {
      reply: outbound(
        'ERROR',
        session.gameServerId,
        { inReplyTo: envelope.messageId, code, retryable },
        this.clock.now(),
      ),
    };
  }
}
