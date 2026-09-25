import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

// Domain-facing contract: domains publish typed events after commit and never
// know how (or whether) they are transported. Realtime is not a source of
// truth; clients that miss an event re-read state over HTTP.
export const REALTIME_EVENT_TYPES = [
  'GROUP_CREATED',
  'GROUP_INVITE_CREATED',
  'GROUP_INVITE_ACCEPTED',
  'GROUP_INVITE_DECLINED',
  'GROUP_MEMBER_JOINED',
  'GROUP_MEMBER_LEFT',
  'GROUP_MEMBER_KICKED',
  'GROUP_DISBANDED',
  'GUILD_CREATED',
  'GUILD_INVITE_CREATED',
  'GUILD_INVITE_ACCEPTED',
  'GUILD_INVITE_DECLINED',
  'GUILD_INVITE_CANCELLED',
  'GUILD_MEMBER_JOINED',
  'GUILD_MEMBER_LEFT',
  'GUILD_MEMBER_KICKED',
  'GUILD_MEMBER_ROLE_CHANGED',
  'GUILD_MASTER_TRANSFERRED',
  'GUILD_DISBANDED',
  'TRADE_CREATED',
  'TRADE_OFFER_UPDATED',
  'TRADE_ACCEPTED',
  'TRADE_AWAITING_GAME_CONFIRMATION',
  'TRADE_COMPLETED',
  'TRADE_CANCELLED',
  'TRADE_FAILED',
  'MARKETPLACE_LISTING_ACTIVE',
  'MARKETPLACE_LISTING_CANCELLED',
  'MARKETPLACE_LISTING_RESERVED',
  'MARKETPLACE_LISTING_SOLD',
  'MARKETPLACE_LISTING_FAILED',
  'MARKETPLACE_PURCHASE_FAILED',
  'CHAT_MESSAGE_CREATED',
] as const;
export type RealtimeEventType = (typeof REALTIME_EVENT_TYPES)[number];
export type RealtimeData = Record<string, string | number | boolean | null>;
export interface RealtimeEnvelope {
  eventId: string;
  type: RealtimeEventType;
  occurredAt: string;
  data: RealtimeData;
}
// Recipients are chosen by the server; clients never subscribe to rooms.
export interface RealtimeRecipients {
  playerIds: readonly string[];
}
export type RealtimeListener = (
  envelope: RealtimeEnvelope,
  recipients: RealtimeRecipients,
) => void;

// In-process, best-effort fan-out. Single instance only: no outbox or broker
// (multi-instance delivery is Etapa 12).
@Injectable()
export class RealtimeEventBus {
  private readonly logger = new Logger(RealtimeEventBus.name);
  private readonly listeners = new Set<RealtimeListener>();
  subscribe(listener: RealtimeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  // Data must be flat primitives: entities or nested objects cannot leak.
  publish(
    type: RealtimeEventType,
    data: RealtimeData,
    recipients: RealtimeRecipients,
  ): RealtimeEnvelope {
    const envelope: RealtimeEnvelope = {
      eventId: randomUUID(),
      type,
      occurredAt: new Date().toISOString(),
      data: Object.fromEntries(
        Object.entries(data).filter(
          ([, value]) =>
            ['string', 'number', 'boolean'].includes(typeof value) ||
            value === null,
        ),
      ),
    };
    const targets = { playerIds: [...new Set(recipients.playerIds)] };
    for (const listener of this.listeners)
      try {
        listener(envelope, targets);
      } catch {
        this.logger.error(`Realtime listener failed [type=${type}]`);
      }
    return envelope;
  }
}
