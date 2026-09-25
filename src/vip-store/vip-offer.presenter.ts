import type { VipOffer } from './entities/vip-offer.entity.js';
import type {
  VipOfferPublicDto,
  VipOfferAdminDto,
} from './dto/vip-offer.dto.js';
import { vipRewards } from './vip-offer.contracts.js';
export function publicOffer(offer: VipOffer): VipOfferPublicDto {
  return {
    id: offer.id,
    code: offer.code,
    name: offer.name,
    description: offer.description,
    priceMinor: offer.priceMinor,
    currency: offer.currency,
    rewards: vipRewards(offer.rewards),
    entitlementScope: offer.entitlementScope,
  };
}
export function adminOffer(offer: VipOffer): VipOfferAdminDto {
  return {
    ...publicOffer(offer),
    active: offer.active,
    sortOrder: offer.sortOrder,
    createdAt: offer.createdAt,
    updatedAt: offer.updatedAt,
  };
}
