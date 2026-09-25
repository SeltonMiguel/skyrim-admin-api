import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import type { AuthenticatedStaff } from '../auth/auth.types.js';
import { Permission as P } from '../rbac/permissions.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction as A, AuditResource } from '../audit/audit.types.js';
import type { AuditMetadata } from '../audit/audit.types.js';
import type { PageQueryDto } from '../admin-queries/dto/query.dto.js';
import type { VipOffer } from './entities/vip-offer.entity.js';
import { newOffer, offerPatch, offerActive } from './vip-offer.contracts.js';
import { adminOffer } from './vip-offer.presenter.js';
// Raised when an offer that already has entitlements would change scope:
// the offer stays untouched and no Audit is written.
class EntitlementScopeFrozen extends ConflictException {
  constructor() {
    super('Entitlement scope is frozen once the offer has entitlements');
  }
}
function authorize(auth: AuthenticatedStaff, permission: P) {
  if (!auth.permissions.includes(permission))
    throw new ForbiddenException('Missing required permissions');
}
@Injectable()
export class VipAdminService {
  constructor(
    private readonly database: DataSource,
    private readonly audit: AuditService,
  ) {}
  async list(query: PageQueryDto, auth: AuthenticatedStaff) {
    authorize(auth, P.VIP_STORE_READ);
    const [offers, total] = await this.database
      .getRepository<VipOffer>('VipOffer')
      .findAndCount({
        order: { sortOrder: 'ASC', code: 'ASC' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      });
    return {
      items: offers.map(adminOffer),
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
    };
  }
  async get(id: string, auth: AuthenticatedStaff) {
    authorize(auth, P.VIP_STORE_READ);
    return adminOffer(await this.find(this.database.manager, id));
  }
  async create(value: unknown, auth: AuthenticatedStaff) {
    authorize(auth, P.VIP_STORE_WRITE);
    const input = newOffer(value);
    return this.audit.execute(
      {
        actor: auth.user,
        action: A.VIP_OFFER_CREATED,
        resourceType: AuditResource.VIP_OFFER,
        statusCode: 201,
      },
      async (manager) => {
        try {
          const repository = manager.getRepository<VipOffer>('VipOffer');
          const offer = await repository.save(repository.create(input));
          return {
            value: adminOffer(offer),
            resourceId: offer.id,
            metadata: {
              code: offer.code,
              priceMinor: offer.priceMinor,
              currency: offer.currency,
              active: offer.active,
              rewardCount: offer.rewards.length,
              entitlementScope: offer.entitlementScope,
            },
          };
        } catch (error) {
          if (
            error instanceof QueryFailedError &&
            (error.driverError as { code?: string; constraint?: string })
              .code === '23505' &&
            (error.driverError as { constraint?: string }).constraint ===
              'vip_offers_code_key'
          )
            throw new ConflictException('VIP offer code already exists');
          throw error;
        }
      },
    );
  }
  async update(id: string, value: unknown, auth: AuthenticatedStaff) {
    authorize(auth, P.VIP_STORE_WRITE);
    const patch = offerPatch(value);
    return this.audit.execute(
      {
        actor: auth.user,
        action: A.VIP_OFFER_UPDATED,
        resourceType: AuditResource.VIP_OFFER,
        resourceId: id,
        statusCode: 200,
      },
      async (manager) => {
        // FOR UPDATE on the offer conflicts with the FOR SHARE every grant
        // takes, so a grant and a scope change never interleave: either the
        // grant committed first (and the change is refused) or the change
        // did (and the grant sees the new scope).
        const offer = await this.find(manager, id, true);
        if (
          patch.entitlementScope !== undefined &&
          patch.entitlementScope !== offer.entitlementScope &&
          (await this.hasEntitlements(manager, offer.id))
        )
          throw new EntitlementScopeFrozen();
        const changedFields = Object.keys(patch)
          .filter(
            (key) =>
              JSON.stringify(offer[key as keyof VipOffer]) !==
              JSON.stringify(patch[key as keyof typeof patch]),
          )
          .sort();
        const metadata: AuditMetadata = { code: offer.code, changedFields };
        if (
          changedFields.includes('priceMinor') ||
          changedFields.includes('currency')
        )
          Object.assign(metadata, {
            previousPriceMinor: offer.priceMinor,
            newPriceMinor: patch.priceMinor ?? offer.priceMinor,
            previousCurrency: offer.currency,
            newCurrency: patch.currency ?? offer.currency,
          });
        if (changedFields.includes('rewards'))
          Object.assign(metadata, {
            previousRewardCount: offer.rewards.length,
            newRewardCount: patch.rewards!.length,
          });
        Object.assign(offer, patch);
        return {
          value: adminOffer(
            await manager.getRepository<VipOffer>('VipOffer').save(offer),
          ),
          metadata,
        };
      },
      (error) => !(error instanceof EntitlementScopeFrozen),
    );
  }
  // Any entitlement, whatever its status (ACTIVE, REVOKED or EXPIRED),
  // freezes the scope: the offer never mixes scopes in its history.
  private async hasEntitlements(manager: EntityManager, offerId: string) {
    const [row] = await manager.query(
      'SELECT EXISTS (SELECT 1 FROM player_vip_entitlements WHERE vip_offer_id = $1) AS frozen',
      [offerId],
    );
    return row.frozen === true;
  }
  async setActive(id: string, value: unknown, auth: AuthenticatedStaff) {
    authorize(auth, P.VIP_STORE_WRITE);
    const active = offerActive(value);
    return this.audit.execute(
      {
        actor: auth.user,
        action: active ? A.VIP_OFFER_ACTIVATED : A.VIP_OFFER_DEACTIVATED,
        resourceType: AuditResource.VIP_OFFER,
        resourceId: id,
        statusCode: 200,
      },
      async (manager) => {
        const offer = await this.find(manager, id, true);
        const previousActive = offer.active;
        offer.active = active;
        return {
          value: adminOffer(
            await manager.getRepository<VipOffer>('VipOffer').save(offer),
          ),
          metadata: { code: offer.code, previousActive, newActive: active },
        };
      },
    );
  }
  private async find(manager: EntityManager, id: string, lock = false) {
    const offer = await manager
      .getRepository<VipOffer>('VipOffer')
      .findOne({
        where: { id },
        ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
      });
    if (!offer) throw new NotFoundException('VIP offer not found');
    return offer;
  }
}
