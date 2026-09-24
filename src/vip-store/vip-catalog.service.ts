import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { PageQueryDto } from '../admin-queries/dto/query.dto.js';
import type { VipOffer } from './entities/vip-offer.entity.js';
import { publicOffer } from './vip-offer.presenter.js';
import { offerCode } from './vip-offer.contracts.js';
// Public catalog contract; no dependency on staff authentication or permissions.
@Injectable()
export class VipCatalogService {
  constructor(private readonly database: DataSource) {}
  async list(query: PageQueryDto) {
    const [offers, total] = await this.database
      .getRepository<VipOffer>('VipOffer')
      .findAndCount({
        where: { active: true },
        order: { sortOrder: 'ASC', code: 'ASC' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      });
    return {
      items: offers.map(publicOffer),
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
    };
  }
  async get(code: string) {
    const offer = await this.database
      .getRepository<VipOffer>('VipOffer')
      .findOneBy({ code: offerCode(code), active: true });
    if (!offer) throw new NotFoundException('VIP offer not found');
    return publicOffer(offer);
  }
}
