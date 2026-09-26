import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Permission } from '../rbac/permissions.js';

// Domain-facing contract: domains publish typed events after commit and never
// know how (or whether) they are transported. Realtime is not a source of
// truth; clients that miss an event re-read state over HTTP.
export const REALTIME_EVENT_TYPES = [
  'PLAYER_CHARACTER_LINK_UPDATED',
  'PLAYER_GAME_OPERATION_UPDATED',
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
  'PLAYER_SETTINGS_UPDATED',
  'VIP_ENTITLEMENT_GRANTED',
  'VIP_ENTITLEMENT_REVOKED',
  // Staff operational wake-ups (11.6): the only STAFF_* types, and the only
  // types delivered to the Staff surface.
  'STAFF_GAME_SERVER_UPDATED',
  'STAFF_GAME_OPERATION_UPDATED',
  'STAFF_SERVER_CONTROL_UPDATED',
  // 12.4: an operator intervention committed (domain, action, resource);
  // a wake-up for the operations queues, never their content.
  'STAFF_OPERATIONS_UPDATED',
] as const;
export type RealtimeEventType = (typeof REALTIME_EVENT_TYPES)[number];
export type RealtimeData = Record<string, string | number | boolean | null>;
export interface RealtimeEnvelope {
  eventId: string;
  type: RealtimeEventType;
  occurredAt: string;
  data: RealtimeData;
}
export const isStaffEvent = (type: RealtimeEventType) =>
  type.startsWith('STAFF_');
// Recipients are chosen by the server; clients never subscribe to rooms.
// Player events name their players; Staff events name the permission a
// Staff session must hold (the one its HTTP read requires), re-checked by
// the transport at delivery time. A publication never reaches both.
export type RealtimeTarget =
  { playerIds: readonly string[] } | { staffPermission: Permission };
export interface RealtimeRecipients {
  playerIds: readonly string[];
  staffPermission: Permission | null;
}
export type RealtimeListener = (
  envelope: RealtimeEnvelope,
  recipients: RealtimeRecipients,
) => void;

export type RealtimeRelay = (
  envelope: RealtimeEnvelope,
  recipients: RealtimeRecipients,
) => void;

// Best-effort fan-out: first to this process's listeners, then (MULTI,
// 12.5) through the relay installed by the cluster bus to the other
// replicas, which fan out to their own sockets only. No outbox, no replay.
@Injectable()
export class RealtimeEventBus {
  private readonly logger = new Logger(RealtimeEventBus.name);
  private readonly listeners = new Set<RealtimeListener>();
  private relay?: RealtimeRelay;
  setRelay(relay: RealtimeRelay): void {
    this.relay = relay;
  }
  subscribe(listener: RealtimeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  // Data must be flat primitives: entities or nested objects cannot leak.
  publish(
    type: RealtimeEventType,
    data: RealtimeData,
    target: RealtimeTarget,
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
    const staff = 'staffPermission' in target;
    // Surfaces never cross: a Staff type only to Staff, any other only to
    // Players. A mismatch is a programming error; it is dropped, not thrown
    // (publishers run after their commit).
    if (staff !== isStaffEvent(type)) {
      this.logger.error(`Realtime event dropped: wrong surface [type=${type}]`);
      return envelope;
    }
    const targets: RealtimeRecipients = staff
      ? { playerIds: [], staffPermission: target.staffPermission }
      : { playerIds: [...new Set(target.playerIds)], staffPermission: null };
    this.fanOut(envelope, targets);
    try {
      this.relay?.(envelope, targets);
    } catch {
      this.logger.error(`Realtime relay failed [type=${type}]`);
    }
    return envelope;
  }
  // An envelope published by another replica: local listeners only (the
  // surfaces were checked at its origin and are checked again here).
  deliverRemote(envelope: RealtimeEnvelope, recipients: RealtimeRecipients) {
    if (
      !REALTIME_EVENT_TYPES.includes(envelope.type) ||
      isStaffEvent(envelope.type) !== (recipients.staffPermission !== null)
    )
      return;
    this.fanOut(envelope, recipients);
  }
  private fanOut(envelope: RealtimeEnvelope, targets: RealtimeRecipients) {
    for (const listener of this.listeners)
      try {
        listener(envelope, targets);
      } catch {
        this.logger.error(`Realtime listener failed [type=${envelope.type}]`);
      }
  }
}
