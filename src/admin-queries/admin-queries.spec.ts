import { jest } from '@jest/globals';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { ApplicationConfig } from '../config/environment.js';
import { BridgeClock } from '../game-bridge/bridge-clock.js';
import { GameCommand } from '../game-bridge/entities/game-command.entity.js';
import { GameCommandResult } from '../game-bridge/entities/game-command-result.entity.js';
import { GameConnection } from '../game-bridge/entities/game-connection.entity.js';
import { CommandStatus as S } from '../game-bridge/command-state.js';
import { ServerHealth as H, serverHealth } from './server-health.js';
import {
  CommandQueryDto,
  ConnectionQueryDto,
  ServerQueryDto,
} from './dto/query.dto.js';
import { dateRange, pageResult } from './query-pagination.js';
import {
  commandDetail,
  commandSummary,
  connectionHistory,
  publicServer,
} from './query.presenters.js';
import { GameServer } from '../game-bridge/entities/game-server.entity.js';
import { GameServerQueryService } from './game-server-query.service.js';
import { GameCommandQueryService } from './game-command-query.service.js';
import { DashboardQueryService } from './dashboard-query.service.js';

const now = new Date('2026-09-20T12:00:00Z');
const cutoff = new Date(now.getTime() - 30000);
const config = new ConfigService({
  application: { gameBridge: { heartbeatTimeoutMs: 30000 } },
}) as ConfigService<{ application: ApplicationConfig }, true>;
const clock: BridgeClock = { now: () => now };
function fixture() {
  const builder = {
    select: jest.fn(),
    addSelect: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    leftJoin: jest.fn(),
    leftJoinAndMapOne: jest.fn(),
    setParameter: jest.fn(),
    groupBy: jest.fn(),
    orderBy: jest.fn(),
    addOrderBy: jest.fn(),
    skip: jest.fn(),
    take: jest.fn(),
    getManyAndCount: jest
      .fn<() => Promise<[object[], number]>>()
      .mockResolvedValue([[], 0]),
    getOne: jest.fn<() => Promise<object | null>>().mockResolvedValue(null),
    getRawMany: jest.fn<() => Promise<object[]>>().mockResolvedValue([]),
  };
  for (const key of [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'leftJoin',
    'leftJoinAndMapOne',
    'setParameter',
    'groupBy',
    'orderBy',
    'addOrderBy',
    'skip',
    'take',
  ] as const)
    builder[key].mockReturnValue(builder);
  const existsBy = jest.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const db = {
    getRepository: () => ({ createQueryBuilder: () => builder, existsBy }),
  } as unknown as DataSource;
  const servers = new GameServerQueryService(db, clock, config);
  return {
    builder,
    existsBy,
    servers,
    commands: new GameCommandQueryService(db, servers),
    dashboard: new DashboardQueryService(db, clock, config),
  };
}

describe('Admin read models', () => {
  it.each([
    [false, null, H.DISABLED],
    [false, { status: 'CONNECTED', lastHeartbeatAt: now }, H.DISABLED],
    [true, { status: 'CONNECTED', lastHeartbeatAt: now }, H.ONLINE],
    [
      true,
      { status: 'CONNECTED', lastHeartbeatAt: new Date(cutoff.getTime() - 1) },
      H.STALE,
    ],
    [true, { status: 'CONNECTED', lastHeartbeatAt: cutoff }, H.STALE],
    [
      true,
      { status: 'CONNECTED', lastHeartbeatAt: new Date(cutoff.getTime() + 1) },
      H.ONLINE,
    ],
    [true, null, H.OFFLINE],
    [true, { status: 'DISCONNECTED', lastHeartbeatAt: now }, H.OFFLINE],
  ] as const)(
    'derives health for enabled=%s connection=%j',
    (enabled, connection, expected) => {
      expect(serverHealth(enabled, connection, cutoff)).toBe(expected);
    },
  );
  it('builds dashboard counts, status totals and attention from bounded aggregates', async () => {
    const f = fixture();
    f.builder.getRawMany
      .mockResolvedValueOnce([
        { health: H.ONLINE, count: '2' },
        { health: H.STALE, count: '1' },
        { health: H.OFFLINE, count: '3' },
        { health: H.DISABLED, count: '4' },
      ])
      .mockResolvedValueOnce(
        Object.values(S).map((status, i) => ({ status, count: String(i + 1) })),
      );
    expect(await f.dashboard.get()).toEqual({
      generatedAt: now,
      servers: {
        total: 10,
        enabled: 6,
        disabled: 4,
        online: 2,
        stale: 1,
        offline: 3,
      },
      commands: {
        windowHours: 24,
        total: 21,
        byStatus: {
          PENDING: 1,
          DISPATCHED: 2,
          ACKNOWLEDGED: 3,
          SUCCEEDED: 4,
          FAILED: 5,
          TIMEOUT: 6,
        },
        attentionRequired: 11,
      },
    });
    expect(f.builder.where).toHaveBeenCalledWith(
      'command.createdAt >= :from AND command.createdAt <= :to',
      {
        from: new Date('2026-09-19T12:00:00Z'),
        to: now,
      },
    );
    expect(f.builder.getManyAndCount).not.toHaveBeenCalled();
  });
  it('returns zero counters for an empty dashboard', async () => {
    const result = await fixture().dashboard.get();
    expect(result.servers.total).toBe(0);
    expect(result.commands).toEqual({
      windowHours: 24,
      total: 0,
      attentionRequired: 0,
      byStatus: {
        PENDING: 0,
        DISPATCHED: 0,
        ACKNOWLEDGED: 0,
        SUCCEEDED: 0,
        FAILED: 0,
        TIMEOUT: 0,
      },
    });
  });
  it('paginates like Audit, with totalPages zero for empty data', () => {
    expect(pageResult([], 0, new ServerQueryDto())).toEqual({
      items: [],
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 0,
    });
    expect(
      pageResult(['a'], 41, Object.assign(new ServerQueryDto(), { page: 2 })),
    ).toMatchObject({ totalPages: 3, page: 2 });
  });
  it('binds all command filters, converts dates and excludes payload from SQL selection', async () => {
    const f = fixture();
    const filters = {
      status: S.FAILED,
      type: 'BRIDGE_PING',
      requestedByStaffId: 'staff',
      requestId: 'request',
      correlationId: 'correlation',
    };
    await f.commands.list(
      'server',
      Object.assign(new CommandQueryDto(), filters, {
        page: 2,
        limit: 10,
        from: '2026-09-19T12:00:00Z',
        to: now.toISOString(),
      }),
    );
    for (const [key, value] of Object.entries(filters))
      expect(f.builder.andWhere).toHaveBeenCalledWith(
        `command.${key} = :${key}`,
        { [key]: value },
      );
    expect(f.builder.andWhere).toHaveBeenCalledWith(
      'command.createdAt >= :from',
      { from: new Date('2026-09-19T12:00:00Z') },
    );
    expect(f.builder.andWhere).toHaveBeenCalledWith(
      'command.createdAt <= :to',
      { to: now },
    );
    expect(f.builder.skip).toHaveBeenCalledWith(10);
    expect(f.builder.take).toHaveBeenCalledWith(10);
    expect(f.builder.orderBy).toHaveBeenCalledWith('command.createdAt', 'DESC');
    expect(f.builder.addOrderBy).toHaveBeenCalledWith('command.id', 'DESC');
    expect(JSON.stringify(f.builder.select.mock.calls)).not.toMatch(
      /payload|result|idempotency|Lease/,
    );
  });
  it('filters connection dates by connectedAt and binds status with stable order', async () => {
    const f = fixture();
    await f.servers.connections(
      'server',
      Object.assign(new ConnectionQueryDto(), {
        status: 'DISCONNECTED',
        from: now.toISOString(),
        to: now.toISOString(),
      }),
    );
    expect(f.builder.andWhere).toHaveBeenCalledWith(
      'connection.status = :status',
      { status: 'DISCONNECTED' },
    );
    expect(f.builder.andWhere).toHaveBeenCalledWith(
      'connection.connectedAt >= :from',
      { from: now },
    );
    expect(f.builder.andWhere).toHaveBeenCalledWith(
      'connection.connectedAt <= :to',
      { to: now },
    );
    expect(f.builder.orderBy).toHaveBeenCalledWith(
      'connection.connectedAt',
      'DESC',
    );
    expect(f.builder.addOrderBy).toHaveBeenCalledWith('connection.id', 'DESC');
  });
  it('filters disabled servers explicitly and joins current connections without per-row queries', async () => {
    const f = fixture();
    await f.servers.list(
      Object.assign(new ServerQueryDto(), {
        enabled: false,
        code: 'main',
        health: H.DISABLED,
      }),
    );
    expect(f.builder.andWhere).toHaveBeenCalledWith(
      'server.enabled = :enabled',
      { enabled: false },
    );
    expect(f.builder.andWhere).toHaveBeenCalledWith('server.code = :code', {
      code: 'main',
    });
    expect(f.builder.leftJoinAndMapOne).toHaveBeenCalledTimes(1);
    expect(f.builder.orderBy).toHaveBeenCalledWith('server.name', 'ASC');
  });
  it('rejects reversed/invalid ranges before SQL and missing resources with 404', async () => {
    const f = fixture();
    const query = Object.assign(new CommandQueryDto(), {
      from: '2026-09-21T00:00:00Z',
      to: now.toISOString(),
    });
    await expect(f.commands.list('server', query)).rejects.toThrow(
      'from must not be after to',
    );
    await expect(
      f.servers.connections(
        'server',
        Object.assign(new ConnectionQueryDto(), {
          from: query.from,
          to: query.to,
        }),
      ),
    ).rejects.toThrow('from must not be after to');
    expect(f.builder.where).not.toHaveBeenCalled();
    expect(() => dateRange({ from: 'invalid' })).toThrow('Invalid date');
    await expect(f.servers.get('missing')).rejects.toMatchObject({
      status: 404,
    });
    await expect(f.commands.get('missing')).rejects.toMatchObject({
      status: 404,
    });
    f.existsBy.mockResolvedValue(false);
    await expect(
      f.servers.connections('missing', new ConnectionQueryDto()),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      f.commands.list('missing', new CommandQueryDto()),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('allows only public fields in server and connection presenters', () => {
    const connection = Object.assign(new GameConnection(), {
      id: 'c',
      status: 'CONNECTED',
      lastHeartbeatAt: now,
      secret: 'hidden',
    });
    const server = Object.assign(new GameServer(), {
      id: 's',
      enabled: true,
      currentConnection: connection,
      passwordHash: 'hidden',
    });
    const result = publicServer(server, cutoff);
    expect(result.health).toBe(H.ONLINE);
    expect(result.currentConnection?.id).toBe('c');
    expect(JSON.stringify([result, connectionHistory(connection)])).not.toMatch(
      /hidden|secret|passwordHash/,
    );
    expect(
      publicServer({ ...server, currentConnection: null }, cutoff)
        .currentConnection,
    ).toBeNull();
  });
  it('hides leases/idempotency/staff secrets and redacts payload/result bodies even on detail', async () => {
    const command = Object.assign(new GameCommand(), {
      id: 'c',
      type: 'BRIDGE_PING',
      status: S.SUCCEEDED,
      payload: { nonce: 'ping' },
      dispatchLeaseId: 'lease-secret',
      dispatchLeaseExpiresAt: now,
      idempotencyKey: 'private-key',
      requestedByStaff: {
        passwordHash: 'private-hash',
        refreshTokenHash: 'private-refresh',
      },
      result: Object.assign(new GameCommandResult(), {
        outcome: S.SUCCEEDED,
        result: { nonce: 'ping' },
        errorCode: null,
        errorMessage: null,
        receivedAt: now,
      }),
    });
    expect(commandSummary(command)).not.toHaveProperty('payload');
    expect(commandSummary(command)).not.toHaveProperty('result');
    expect(commandDetail(command)).not.toHaveProperty('payload');
    expect(commandDetail(command).result).not.toHaveProperty('result');
    expect(commandDetail(command).result).not.toHaveProperty('errorMessage');
    expect(commandDetail({ ...command, result: null }).result).toBeNull();
    expect(
      JSON.stringify([commandSummary(command), commandDetail(command)]),
    ).not.toMatch(
      /Lease|lease-secret|idempotency|private-|passwordHash|refreshTokenHash/,
    );
    const f = fixture();
    f.builder.getOne.mockResolvedValue(command);
    expect(await f.commands.get('c')).toEqual(commandDetail(command));
    expect(JSON.stringify(f.builder.select.mock.calls)).not.toMatch(
      /Lease|idempotency|command.payload|result.result|result.errorMessage/,
    );
  });
});

describe('Admin query validation', () => {
  it.each([
    { limit: '101' },
    { limit: '0' },
    { limit: '1.5' },
    { page: '0' },
    { page: '1000001' },
    { status: 'OTHER' },
    { type: 'EXECUTE' },
    { requestedByStaffId: 'bad' },
    { correlationId: 'bad' },
    { requestId: "x' OR 1=1" },
    { from: '2026-02-30T00:00:00Z' },
    { from: '2026-09-20' },
    { to: 'not-a-date' },
    { from: '2026-09-20T12:00:00' },
    { order: 'payload' },
    { payload: '{}' },
  ])('rejects command query %j', async (query) => {
    expect(
      (
        await validate(plainToInstance(CommandQueryDto, query), {
          whitelist: true,
          forbidNonWhitelisted: true,
        })
      ).length,
    ).toBeGreaterThan(0);
  });
  it.each([
    { enabled: '0' },
    { enabled: 'falsee' },
    { health: 'UNKNOWN' },
    { code: "' OR true" },
  ])('rejects server query %j', async (query) => {
    expect(
      (await validate(plainToInstance(ServerQueryDto, query))).length,
    ).toBeGreaterThan(0);
  });
  it('accepts max page size, timezone dates and explicit boolean false', async () => {
    const query = plainToInstance(CommandQueryDto, {
      page: '2',
      limit: '100',
      from: '2026-09-20T09:00:00-03:00',
      to: now.toISOString(),
    });
    expect(await validate(query)).toEqual([]);
    expect(query).toMatchObject({ page: 2, limit: 100 });
    expect(dateRange(query)).toEqual({ from: now, to: now });
    const server = plainToInstance(ServerQueryDto, { enabled: 'false' });
    expect(await validate(server)).toEqual([]);
    expect(server.enabled).toBe(false);
  });
});
