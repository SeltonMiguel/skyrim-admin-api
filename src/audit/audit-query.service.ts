import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditLog } from './entities/audit-log.entity.js';
import { AuditQueryDto } from './dto/audit-query.dto.js';
import type { AuditLogDto, AuditPageDto } from './dto/audit-response.dto.js';
import { ActorType } from '../actors/actor.contracts.js';

// Represents STAFF, PLAYER and SYSTEM without rewriting historical rows.
export function auditEntry(entry: AuditLog): AuditLogDto {
  return {
    ...entry,
    actorType: entry.actorType ?? (entry.actorStaffId ? ActorType.STAFF : null),
  };
}

@Injectable()
export class AuditQueryService {
  constructor(private readonly database: DataSource) {}

  async list(query: AuditQueryDto): Promise<AuditPageDto> {
    if (query.from && query.to && Date.parse(query.from) > Date.parse(query.to))
      throw new BadRequestException('from must not be after to');
    const builder = this.database
      .getRepository<AuditLog>('AuditLog')
      .createQueryBuilder('audit');
    for (const field of [
      'actorStaffId',
      'action',
      'outcome',
      'resourceType',
      'resourceId',
      'requestId',
    ] as const) {
      if (query[field] !== undefined)
        builder.andWhere(`audit.${field} = :${field}`, {
          [field]: query[field],
        });
    }
    if (query.from)
      builder.andWhere('audit.createdAt >= :from', {
        from: new Date(query.from),
      });
    if (query.to)
      builder.andWhere('audit.createdAt <= :to', { to: new Date(query.to) });
    const [items, total] = await builder
      .orderBy('audit.createdAt', 'DESC')
      .addOrderBy('audit.id', 'DESC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();
    return {
      items: items.map(auditEntry),
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async get(id: string): Promise<AuditLogDto> {
    const entry = await this.database
      .getRepository<AuditLog>('AuditLog')
      .findOneBy({ id });
    if (!entry) throw new NotFoundException('Audit entry not found');
    return auditEntry(entry);
  }
}
