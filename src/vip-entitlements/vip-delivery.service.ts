import { Injectable } from '@nestjs/common';

export type VipDeliveryResult = {
  outcome: 'UNAVAILABLE';
  reason: 'AGENT_NOT_INTEGRATED';
};
// Delivery boundary for Stage 11. The entitlement is the source of the
// right; gameplay delivery of the offer's typed rewards (ITEM, HORSE, TITLE,
// SPELL) needs the trusted Agent, so nothing is delivered or marked
// "delivered" yet and no delivery state is persisted. Stage 11 implements it
// through typed, validated operations only: never arbitrary console,
// Papyrus, shell or free-form game commands.
@Injectable()
export class VipDeliveryService {
  requestDelivery(entitlementId: string): Promise<VipDeliveryResult> {
    void entitlementId;
    return Promise.resolve({
      outcome: 'UNAVAILABLE',
      reason: 'AGENT_NOT_INTEGRATED',
    });
  }
}
