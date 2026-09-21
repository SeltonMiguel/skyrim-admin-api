import { BadRequestException } from '@nestjs/common';
import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import type { DatePageQueryDto, PageQueryDto } from './dto/query.dto.js';

export function pageResult<T>(items: T[], total: number, query: PageQueryDto) {
  return {
    items,
    total,
    page: query.page,
    limit: query.limit,
    totalPages: Math.ceil(total / query.limit),
  };
}

export function dateRange(query: Pick<DatePageQueryDto, 'from' | 'to'>) {
  const from = query.from === undefined ? undefined : new Date(query.from);
  const to = query.to === undefined ? undefined : new Date(query.to);
  if (
    (from && !Number.isFinite(from.getTime())) ||
    (to && !Number.isFinite(to.getTime()))
  )
    throw new BadRequestException('Invalid date range');
  if (from && to && from > to)
    throw new BadRequestException('from must not be after to');
  return { from, to };
}

// Column is supplied only by services, never by client input.
export function filterDates<T extends ObjectLiteral>(
  builder: SelectQueryBuilder<T>,
  column: 'command.createdAt' | 'connection.connectedAt',
  range: ReturnType<typeof dateRange>,
): void {
  if (range.from) builder.andWhere(`${column} >= :from`, { from: range.from });
  if (range.to) builder.andWhere(`${column} <= :to`, { to: range.to });
}
