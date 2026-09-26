import type { CommandType } from '../game-bridge/command-contract.js';
import type { VipReward } from '../vip-store/vip-offer.contracts.js';

// Gameplay delivery of CHARACTER entitlements (Etapa 11.4).
// PENDING: waiting for an eligible Host Agent; no command yet.
// COMMAND_CREATED: exactly one GameCommand exists (SYSTEM:VIP_DELIVERY).
// SUCCEEDED / FAILED / UNCERTAIN: follow that command's terminal result
//   (TIMEOUT, including EXECUTION_UNCERTAIN, is UNCERTAIN: never retried).
// FAILED without a command: the reward has no typed command.
// CANCELLED: the entitlement stopped being effective before any command.
export enum DeliveryStatus {
  PENDING = 'PENDING',
  COMMAND_CREATED = 'COMMAND_CREATED',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  UNCERTAIN = 'UNCERTAIN',
  CANCELLED = 'CANCELLED',
}
export type DeliveryErrorCode =
  | 'UNSUPPORTED_REWARD'
  | 'ENTITLEMENT_REVOKED'
  | 'ENTITLEMENT_EXPIRED'
  // The GameCommand's own error code (e.g. EXECUTION_FAILED, DISPATCH_EXPIRED,
  // EXECUTION_UNCERTAIN, ACK_TIMEOUT), copied verbatim.
  | (string & {});

// Closed reward -> typed GameCommand mapping. A reward without an entry here
// is never delivered (FAILED/UNSUPPORTED_REWARD): no console, Papyrus or
// script fallback exists.
export function rewardCommand(
  reward: VipReward,
  characterId: string,
): { type: CommandType; payload: Record<string, unknown> } | null {
  switch (reward.type) {
    case 'ITEM':
      return {
        type: 'CHARACTER_ITEM_GIVE',
        payload: {
          characterId,
          itemId: reward.itemId,
          quantity: reward.quantity,
        },
      };
    case 'HORSE':
      return {
        type: 'CHARACTER_HORSE_GIVE',
        payload: { characterId, horseId: reward.horseId },
      };
    case 'TITLE':
      return {
        type: 'CHARACTER_TITLE_GIVE',
        payload: { characterId, titleId: reward.titleId },
      };
    case 'SPELL':
      return {
        type: 'CHARACTER_SPELL_GIVE',
        payload: { characterId, spellId: reward.spellId },
      };
    default:
      return null;
  }
}
// Stable, internal: one command per delivery attempt, whatever the worker
// retries. Attempt 1 keeps the 11.4 key; a new attempt (12.4, operator
// recovery only) gets its own key, hence a new command.
export const deliveryIdempotencyKey = (deliveryId: string, attempt = 1) =>
  attempt === 1
    ? `vip-delivery:${deliveryId}`
    : `vip-delivery:${deliveryId}:${attempt}`;
export const MAX_DELIVERY_ATTEMPTS = 10;

// GameCommand error codes that prove the command was never delivered to
// an Agent (set only while the command was PENDING, never after a
// dispatch): the reward was certainly not given, so a new attempt cannot
// duplicate it. EXECUTION_FAILED / BRIDGE_ERROR (reported after delivery)
// and every TIMEOUT stay out: they need an operator resolution first.
export const PRE_EFFECT_COMMAND_ERRORS = [
  'DISPATCH_EXPIRED',
  'DISPATCH_REJECTED',
  'DISPATCH_EXHAUSTED',
  'GATEWAY_UNAVAILABLE',
  'SERVER_DISABLED',
] as const;
// Operator resolution of a FAILED/UNCERTAIN delivery (12.4), after checking
// the character in game. CONFIRMED_NOT_DELIVERED allows a new attempt.
export enum DeliveryResolution {
  CONFIRMED_DELIVERED = 'CONFIRMED_DELIVERED',
  CONFIRMED_NOT_DELIVERED = 'CONFIRMED_NOT_DELIVERED',
}
