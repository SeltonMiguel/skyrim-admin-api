import { Injectable, Logger, Optional } from '@nestjs/common';
import { Metrics } from '../observability/metrics.js';
import { BridgeClock } from '../game-bridge/bridge-clock.js';
import {
  AgentProtocolError,
  domainEventPayload,
  outbound,
  workSyncPayload,
} from './agent-protocol.contracts.js';
import type {
  AgentEnvelope,
  AgentErrorCode,
} from './agent-protocol.contracts.js';
import type { RouteOutcome } from './agent-command.adapter.js';
import { AgentDomainEventService } from './agent-domain-events.service.js';
import type { AgentSessionSnapshot } from './agent-session.registry.js';
import { AgentWorkService } from './agent-work.service.js';

// Protocol adapters for DOMAIN_EVENT and WORK_SYNC (Etapa 11.4). They parse
// frames, pass the authenticated session's gameServerId (never a payload
// server) and map outcomes to frames. Replies are sent by the gateway after
// the call returns, i.e. after the domain transaction committed. Logs carry
// ids, kinds and outcomes only: never a challenge or item payload.
@Injectable()
export class AgentDomainEventAdapter {
  private readonly logger = new Logger(AgentDomainEventAdapter.name);
  constructor(
    private readonly events: AgentDomainEventService,
    private readonly work: AgentWorkService,
    private readonly clock: BridgeClock,
    @Optional() private readonly metrics?: Metrics,
  ) {}
  async event(
    session: AgentSessionSnapshot,
    envelope: AgentEnvelope,
  ): Promise<RouteOutcome> {
    let event;
    try {
      event = domainEventPayload(envelope.payload);
    } catch (error) {
      this.metrics?.domainEvents.inc({ kind: 'unknown', outcome: 'invalid' });
      return this.invalid(session, envelope, error, 'domain event');
    }
    const count = (outcome: string) =>
      this.metrics?.domainEvents.inc({ kind: event.kind, outcome });
    const workId = 'workId' in event.data ? ` workId=${event.data.workId}` : '';
    const ids = `eventId=${event.eventId} kind=${event.kind} gameServerId=${session.gameServerId} connectionId=${session.connectionId}${workId}`;
    try {
      const outcome = await this.events.handle(session.gameServerId, event);
      switch (outcome.type) {
        case 'ACK':
          count(outcome.duplicate ? 'duplicate' : 'applied');
          this.logger.log(
            `Agent domain event ${outcome.duplicate ? 'duplicate' : 'applied'} [${ids}]`,
          );
          return {
            reply: outbound(
              'DOMAIN_EVENT_ACK',
              session.gameServerId,
              {
                inReplyTo: envelope.messageId,
                eventId: event.eventId,
                kind: event.kind,
                duplicate: outcome.duplicate,
              },
              this.clock.now(),
            ),
          };
        case 'REJECTED':
          count(outcome.retryable ? 'rejected_retryable' : 'rejected');
          this.logger.warn(
            `Agent domain event rejected by the domain [${ids} reason=${outcome.reason} duplicate=${outcome.duplicate}]`,
          );
          return this.error(session, envelope, 'DOMAIN_REJECTED', {
            retryable: outcome.retryable,
            eventId: event.eventId,
            reason: outcome.reason,
          });
        case 'CONFLICT':
          count('conflict');
          this.logger.warn(`Agent domain event conflict [${ids}]`);
          return this.error(session, envelope, 'EVENT_CONFLICT', {
            eventId: event.eventId,
          });
        case 'SERVER_MISMATCH':
          count('server_mismatch');
          this.logger.warn(
            `Agent domain event for another server's work rejected [${ids}]`,
          );
          return { close: 'SERVER_MISMATCH' };
      }
    } catch {
      count('unavailable');
      this.logger.error(`Agent domain event not processed [${ids}]`);
      return this.error(session, envelope, 'TEMPORARILY_UNAVAILABLE', {
        retryable: true,
        eventId: event.eventId,
      });
    }
  }
  async sync(
    session: AgentSessionSnapshot,
    envelope: AgentEnvelope,
  ): Promise<RouteOutcome> {
    let request;
    try {
      request = workSyncPayload(envelope.payload);
    } catch (error) {
      this.metrics?.workSyncs.inc({ outcome: 'invalid' });
      return this.invalid(session, envelope, error, 'work sync');
    }
    let page;
    try {
      page = await this.work.page(session.gameServerId, request);
    } catch (error) {
      this.metrics?.workSyncs.inc({
        outcome:
          error instanceof AgentProtocolError ? 'invalid' : 'unavailable',
      });
      if (error instanceof AgentProtocolError)
        return this.invalid(session, envelope, error, 'work sync cursor');
      this.logger.error(
        `Agent work sync not processed [gameServerId=${session.gameServerId}]`,
      );
      return this.error(session, envelope, 'TEMPORARILY_UNAVAILABLE', {
        retryable: true,
      });
    }
    this.metrics?.workSyncs.inc({ outcome: 'ok' });
    this.logger.log(
      `Agent work sync [gameServerId=${session.gameServerId} connectionId=${session.connectionId} kind=${request.kind ?? 'ALL'} count=${page.items.length} more=${page.nextCursor !== null}]`,
    );
    return {
      reply: outbound(
        'WORK_ITEMS',
        session.gameServerId,
        { inReplyTo: envelope.messageId, ...page },
        this.clock.now(),
      ),
    };
  }
  private invalid(
    session: AgentSessionSnapshot,
    envelope: AgentEnvelope,
    error: unknown,
    what: string,
  ): RouteOutcome {
    if (!(error instanceof AgentProtocolError)) throw error;
    this.logger.warn(
      `Invalid ${what} [gameServerId=${session.gameServerId} connectionId=${session.connectionId}]`,
    );
    return this.error(session, envelope, 'INVALID_MESSAGE');
  }
  private error(
    session: AgentSessionSnapshot,
    envelope: AgentEnvelope,
    code: AgentErrorCode,
    extra: { retryable?: boolean; eventId?: string; reason?: string } = {},
  ): RouteOutcome {
    const { retryable = false, ...rest } = extra;
    return {
      reply: outbound(
        'ERROR',
        session.gameServerId,
        { inReplyTo: envelope.messageId, code, retryable, ...rest },
        this.clock.now(),
      ),
    };
  }
}
