import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  RealtimeEventBus,
  REALTIME_EVENT_TYPES,
} from '../realtime-events/realtime-event-bus.js';
import type {
  RealtimeEnvelope,
  RealtimeRecipients,
} from '../realtime-events/realtime-event-bus.js';
import { RealtimeSessionControl } from '../realtime-events/realtime-session-control.js';
import { ClusterBus } from './cluster-bus.js';

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];

// MULTI (12.5): realtime wake-ups and Player revocation signals cross
// replicas through the ClusterBus. The originating replica delivers to its
// own sockets first; the bus never echoes to it. Received envelopes are
// re-validated (closed type catalog, surfaces never cross) before local
// fan-out. SINGLE: nothing is installed.
@Injectable()
export class ClusterRelay implements OnModuleInit {
  constructor(
    private readonly bus: ClusterBus,
    private readonly events: RealtimeEventBus,
    private readonly sessions: RealtimeSessionControl,
  ) {}
  onModuleInit(): void {
    if (!this.bus.enabled) return;
    this.events.setRelay((envelope, recipients) => {
      void this.bus.publish('REALTIME', { envelope, recipients });
    });
    this.sessions.setRelay({
      sessionRevoked: (sessionId) =>
        void this.bus.publish('PLAYER_SESSION_REVOKED', { sessionId }),
      accountRevoked: (playerId, sessionIds) =>
        void this.bus.publish('PLAYER_ACCOUNT_REVOKED', {
          playerId,
          sessionIds: [...sessionIds],
        }),
    });
    this.bus.subscribe('REALTIME', (payload) => {
      const envelope = payload.envelope as RealtimeEnvelope | undefined;
      const recipients = payload.recipients as RealtimeRecipients | undefined;
      if (
        !envelope ||
        !recipients ||
        typeof envelope.eventId !== 'string' ||
        !REALTIME_EVENT_TYPES.includes(envelope.type)
      )
        return;
      this.events.deliverRemote(envelope, {
        playerIds: strings(recipients.playerIds),
        staffPermission: recipients.staffPermission ?? null,
      });
    });
    this.bus.subscribe('PLAYER_SESSION_REVOKED', (payload) => {
      if (typeof payload.sessionId === 'string')
        this.sessions.sessionRevokedLocally(payload.sessionId);
    });
    this.bus.subscribe('PLAYER_ACCOUNT_REVOKED', (payload) => {
      if (typeof payload.playerId === 'string')
        this.sessions.accountRevokedLocally(
          payload.playerId,
          strings(payload.sessionIds),
        );
    });
  }
}
