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
// Stable, internal: one command per delivery, whatever the retries.
export const deliveryIdempotencyKey = (deliveryId: string) =>
  `vip-delivery:${deliveryId}`;
