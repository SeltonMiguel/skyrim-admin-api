import { jest } from '@jest/globals';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource } from 'typeorm';
import { AuditQueryService } from './audit-query.service.js';
import { AuditQueryDto } from './dto/audit-query.dto.js';
import { AuditAction, AuditOutcome, AuditResource } from './audit.types.js';

function fixture() {
  const builder = {
    andWhere: jest.fn<(condition: string, params: unknown) => unknown>(),
    orderBy: jest.fn<(column: string, direction: string) => unknown>(),
    addOrderBy: jest.fn<(column: string, direction: string) => unknown>(),
    skip: jest.fn<(value: number) => unknown>(),
    take: jest.fn<(value: number) => unknown>(),
    getManyAndCount: jest
      .fn<() => Promise<[unknown[], number]>>()
      .mockResolvedValue([[{ id: 'entry' }], 41]),
  };
  for (const method of [
    'andWhere',
    'orderBy',
    'addOrderBy',
    'skip',
    'take',
  ] as const)
    builder[method].mockReturnValue(builder);
  const findOneBy = jest
    .fn<() => Promise<unknown>>()
    .mockResolvedValue({ id: 'entry' });
  const database = {
    getRepository: () => ({ createQueryBuilder: () => builder, findOneBy }),
  } as unknown as DataSource;
  return { service: new AuditQueryService(database), builder, findOneBy };
}

describe('Audit queries', () => {
  it('paginates with stable descending order and default limits', async () => {
    const f = fixture();
    expect(await f.service.list(new AuditQueryDto())).toEqual({
      // Entries without a stored actor and without actorStaffId have no actor.
      items: [{ id: 'entry', actorType: null }],
      total: 41,
      page: 1,
      limit: 20,
      totalPages: 3,
    });
    expect(f.builder.orderBy).toHaveBeenCalledWith('audit.createdAt', 'DESC');
    expect(f.builder.addOrderBy).toHaveBeenCalledWith('audit.id', 'DESC');
    expect(f.builder.skip).toHaveBeenCalledWith(0);
    expect(f.builder.take).toHaveBeenCalledWith(20);
    await f.service.list(
      Object.assign(new AuditQueryDto(), { page: 3, limit: 10 }),
    );
    expect(f.builder.skip).toHaveBeenLastCalledWith(20);
  });
  it('uses only fixed filter columns and bound parameters', async () => {
    const f = fixture();
    const filters = {
      actorStaffId: 'actor',
      action: AuditAction.STAFF_CREATE,
      outcome: AuditOutcome.SUCCESS,
      resourceType: AuditResource.STAFF_USER,
      resourceId: 'target',
      requestId: 'request',
    };
    await f.service.list(
      Object.assign(new AuditQueryDto(), filters, {
        from: '2026-09-19T10:00:00Z',
        to: '2026-09-20T10:00:00Z',
      }),
    );
    for (const [key, value] of Object.entries(filters))
      expect(f.builder.andWhere).toHaveBeenCalledWith(
        `audit.${key} = :${key}`,
        { [key]: value },
      );
    expect(f.builder.andWhere).toHaveBeenCalledWith(
      'audit.createdAt >= :from',
      { from: new Date('2026-09-19T10:00:00Z') },
    );
    expect(f.builder.andWhere).toHaveBeenCalledWith('audit.createdAt <= :to', {
      to: new Date('2026-09-20T10:00:00Z'),
    });
  });
  it('rejects inverted date ranges and returns 404 for missing entries', async () => {
    const f = fixture();
    await expect(
      f.service.list(
        Object.assign(new AuditQueryDto(), {
          from: '2026-09-20T00:00:00Z',
          to: '2026-09-19T00:00:00Z',
        }),
      ),
    ).rejects.toThrow('from must not be after to');
    expect(await f.service.get('entry')).toEqual({
      id: 'entry',
      actorType: null,
    });
    f.findOneBy.mockResolvedValue(null);
    await expect(f.service.get('missing')).rejects.toThrow(
      'Audit entry not found',
    );
  });
  it.each([
    { limit: '101' },
    { limit: '0' },
    { limit: '1.5' },
    { page: '0' },
    { page: '1000001' },
    { page: 'abc' },
    { actorStaffId: 'invalid' },
    { action: 'BAN' },
    { outcome: 'UNKNOWN' },
    { resourceType: 'PLAYER' },
    { requestId: 'bad space' },
    { resourceId: "' OR true" },
    { from: '2026-02-30T00:00:00Z' },
    { from: '2026-09-19' },
    { to: 'invalid' },
    { order: 'actorStaffId' },
  ])('rejects invalid query %j', async (query) => {
    const dto = plainToInstance(AuditQueryDto, query);
    expect(
      (await validate(dto, { whitelist: true, forbidNonWhitelisted: true }))
        .length,
    ).toBeGreaterThan(0);
  });
  it('accepts the maximum page size and transforms explicit numbers', async () => {
    const dto = plainToInstance(AuditQueryDto, { limit: '100', page: '2' });
    expect(await validate(dto)).toEqual([]);
    expect(dto).toMatchObject({ limit: 100, page: 2 });
  });
});
