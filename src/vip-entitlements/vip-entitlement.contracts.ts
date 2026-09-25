import type { Actor } from '../actors/actor.contracts.js';
import { VipEntitlementScope } from '../vip-store/vip-offer.contracts.js';

// VIP entitlements (10.17): "this account / this character identity has the
// right to this VIP offer". Never a payment: there is no checkout here.
export { VipEntitlementScope };
export enum EntitlementStatus {
  ACTIVE = 'ACTIVE',
  REVOKED = 'REVOKED',
  EXPIRED = 'EXPIRED',
}
export enum EntitlementOperation {
  GRANT = 'GRANT',
  REVOKE = 'REVOKE',
}
export type EntitlementTarget =
  | { scope: VipEntitlementScope.PLAYER; playerId: string }
  | {
      scope: VipEntitlementScope.CHARACTER;
      gameServerId: string;
      characterExternalId: string;
    };
export interface GrantEntitlementInput {
  offerId: string;
  target: EntitlementTarget;
  // null/absent = permanent.
  expiresAt?: Date | null;
  actor: Actor;
  idempotencyKey: string;
  externalReference?: string | null;
}
export interface RevokeEntitlementInput {
  entitlementId: string;
  actor: Actor;
  idempotencyKey: string;
}
type Rejected<R extends string> = { outcome: 'REJECTED'; reason: R };
// ALREADY_GRANTED: replay of the same key; ALREADY_ACTIVE: another key, but
// an effective entitlement already exists (returned unchanged).
export type GrantEntitlementResult =
  | {
      outcome: 'GRANTED' | 'ALREADY_GRANTED' | 'ALREADY_ACTIVE';
      entitlementId: string;
    }
  | Rejected<
      | 'INVALID_INPUT'
      | 'ACTOR_NOT_ALLOWED'
      | 'OFFER_NOT_FOUND'
      | 'OFFER_NOT_ACTIVE'
      | 'SCOPE_MISMATCH'
      | 'TARGET_NOT_FOUND'
      | 'IDEMPOTENCY_CONFLICT'
    >;
export type RevokeEntitlementResult =
  | { outcome: 'REVOKED' | 'ALREADY_REVOKED'; entitlementId: string }
  | Rejected<
      | 'INVALID_INPUT'
      | 'ACTOR_NOT_ALLOWED'
      | 'ENTITLEMENT_NOT_FOUND'
      | 'NOT_ACTIVE'
      | 'IDEMPOTENCY_CONFLICT'
    >;
