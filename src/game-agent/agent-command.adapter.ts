import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { BridgeClock } from '../game-bridge/bridge-clock.js';
import { BridgeRejection } from '../game-bridge/bridge-rejection.js';
import {
  PROTOCOL_VERSION,
  UNCERTAIN_OUTCOME,
} from '../game-bridge/command-contract.js';
import type { ResultMessage } from '../game-bridge/command-contract.js';
import { CommandStatus } from '../game-bridge/command-state.js';
import { GameCommandReceiver } from '../game-bridge/game-command-receiver.js';
import {
  AgentProtocolError,
  commandAckPayload,
  commandResultPayload,
  outbound,
} from './agent-protocol.contracts.js';
import type {
  AgentCloseReason,
  AgentEnvelope,
  AgentErrorCode,
  AgentOutboundType,
} from './agent-protocol.contracts.js';
import type { AgentSessionSnapshot } from './agent-session.registry.js';

export interface RouteOutcome {
  reply?: AgentEnvelope<AgentOutboundType>;
  close?: AgentCloseReason;
}
const EXPECTED = {
  SUCCEEDED: CommandStatus.SUCCEEDED,
  FAILED: CommandStatus.FAILED,
  [UNCERTAIN_OUTCOME]: CommandStatus.TIMEOUT,
} as const;

// Typed adapter between the Agent transport and the Game Bridge receiver.
// It converts frames into the receiver's contracts, always with the
// server and connection of the authenticated session, and maps rejections
// to protocol answers. No lifecycle rule lives here: the receiver decides.
@Injectable()
export class AgentCommandAdapter {
  private readonly logger = new Logger(AgentCommandAdapter.name);
  constructor(
    private readonly receiver: GameCommandReceiver,
    private readonly clock: BridgeClock,
  ) {}
  // ACK confirms one delivery attempt; it gets no reply.
  async acknowledge(
    session: AgentSessionSnapshot,
    envelope: AgentEnvelope,
  ): Promise<RouteOutcome> {
    let ack;
    try {
      ack = commandAckPayload(envelope.payload);
    } catch (error) {
      return this.invalid(session, envelope, error);
    }
    const ids = this.ids(session, ack.commandId, `attempt=${ack.attempt}`);
    try {
      const command = await this.receiver.acknowledge({
        protocolVersion: PROTOCOL_VERSION,
        serverId: session.gameServerId,
        connectionId: session.connectionId,
        commandId: ack.commandId,
        correlationId: ack.correlationId,
        attempt: ack.attempt,
      });
      this.logger.log(
        `Game command acknowledged [${ids} commandType=${command.type} status=${command.status}]`,
      );
      return {};
    } catch (error) {
      if (error instanceof BridgeRejection && error.code === 'STALE_ATTEMPT') {
        this.logger.warn(`Stale game command ACK ignored [${ids}]`);
        return {};
      }
      return this.reject(session, envelope, error, ids);
    }
  }
  // RESULT belongs to the command, whatever session carried the attempt.
  async result(
    session: AgentSessionSnapshot,
    envelope: AgentEnvelope,
  ): Promise<RouteOutcome> {
    let payload;
    try {
      payload = commandResultPayload(envelope.payload);
    } catch (error) {
      return this.invalid(session, envelope, error);
    }
    const ids = this.ids(
      session,
      payload.commandId,
      `outcome=${payload.outcome}`,
    );
    try {
      const { command, duplicate } = await this.receiver.receive({
        protocolVersion: PROTOCOL_VERSION,
        serverId: session.gameServerId,
        connectionId: session.connectionId,
        ...payload,
      } as ResultMessage);
      const accepted =
        duplicate || command.status === EXPECTED[payload.outcome];
      if (payload.outcome === UNCERTAIN_OUTCOME && accepted)
        this.logger.warn(
          `Game command execution uncertain [${ids} commandType=${command.type}]`,
        );
      this.logger.log(
        `Game command result ${duplicate ? 'duplicate' : accepted ? 'accepted' : 'superseded by deadline'} [${ids} commandType=${command.type} status=${command.status}]`,
      );
      return {
        reply: outbound(
          'COMMAND_RESULT_ACK',
          session.gameServerId,
          {
            inReplyTo: envelope.messageId,
            commandId: command.id,
            status: command.status,
            accepted,
            duplicate,
          },
          this.clock.now(),
        ),
      };
    } catch (error) {
      return this.reject(session, envelope, error, ids);
    }
  }
  private reject(
    session: AgentSessionSnapshot,
    envelope: AgentEnvelope,
    error: unknown,
    ids: string,
  ): RouteOutcome {
    if (error instanceof BridgeRejection) {
      switch (error.code) {
        case 'SERVER_MISMATCH':
          this.logger.warn(`Game command of another server rejected [${ids}]`);
          return { close: 'SERVER_MISMATCH' };
        case 'INACTIVE_SESSION':
          return { close: 'SESSION_CLOSED' };
        case 'RESULT_CONFLICT':
          this.logger.warn(`Conflicting game command result rejected [${ids}]`);
          return this.error(session, envelope, 'RESULT_CONFLICT');
        case 'NOT_DISPATCHED':
          this.logger.warn(`Result for an undispatched command [${ids}]`);
          return this.error(session, envelope, 'NOT_DISPATCHED');
        default:
          this.logger.warn(
            `Game command message rejected [${ids} reason=${error.code}]`,
          );
          return this.error(session, envelope, 'INVALID_MESSAGE');
      }
    }
    if (error instanceof NotFoundException) {
      this.logger.warn(`Unknown game command [${ids}]`);
      return this.error(session, envelope, 'UNKNOWN_COMMAND');
    }
    if (
      error instanceof BadRequestException ||
      error instanceof ConflictException
    ) {
      this.logger.warn(`Invalid game command message [${ids}]`);
      return this.error(session, envelope, 'INVALID_MESSAGE');
    }
    this.logger.error(`Game command message not processed [${ids}]`);
    return this.error(session, envelope, 'TEMPORARILY_UNAVAILABLE', true);
  }
  private invalid(
    session: AgentSessionSnapshot,
    envelope: AgentEnvelope,
    error: unknown,
  ): RouteOutcome {
    if (!(error instanceof AgentProtocolError)) throw error;
    this.logger.warn(
      `Invalid game command message [gameServerId=${session.gameServerId} connectionId=${session.connectionId} type=${envelope.type}]`,
    );
    return this.error(session, envelope, 'INVALID_MESSAGE');
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
  private ids(session: AgentSessionSnapshot, commandId: string, extra: string) {
    return `commandId=${commandId} gameServerId=${session.gameServerId} connectionId=${session.connectionId} ${extra}`;
  }
}
