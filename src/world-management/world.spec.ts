import { randomUUID } from 'node:crypto';
import { worldCases } from '../../test/support/world-cases.js';
import {
  WORLD_COMMAND_TYPES,
  worldPayload,
  worldResult,
  gameHour,
  spawnQuantity,
} from './world-command.contracts.js';
import {
  COMMAND_TYPES,
  commandPayload,
  commandResult,
  sameCommand,
} from '../game-bridge/command-contract.js';
import type { SubmitCommand } from '../game-bridge/command-contract.js';
import { WORLD_POLICY } from './world-policy.js';
import { worldAuditMetadata } from './world-audit.js';
import { worldDetail, worldReference } from './world-operation.presenter.js';
import { WorldService } from './world.service.js';
import type { WorldSubmission } from './world.service.js';
import { AdministrativeCommandService } from '../administrative-operations/administrative-command.service.js';
import { GameCommand } from '../game-bridge/entities/game-command.entity.js';
import { GameCommandResult } from '../game-bridge/entities/game-command-result.entity.js';
import { commandDetail } from '../admin-queries/query.presenters.js';
import { sanitizeMetadata } from '../audit/metadata-sanitizer.js';
import { CommandStatus as S } from '../game-bridge/command-state.js';
import type { AuthenticatedStaff } from '../auth/auth.types.js';
import { StaffUser } from '../staff/entities/staff-user.entity.js';
import { Permission as P } from '../rbac/permissions.js';
import { ROLE_PERMISSIONS } from '../rbac/role-permissions.js';
import { RoleName as R } from '../rbac/roles.js';
const incomplete: SubmitCommand = {
  type: 'WORLD_ENTITY_SPAWN',
  // @ts-expect-error spawn requires authenticated actor in the bridge contract
  payload: { baseFormId: 'b', quantity: 1 },
  gameServerId: 's',
  idempotencyKey: 'k',
};
void incomplete;
const cases = worldCases(randomUUID());
describe('World closed contracts', () => {
  it('registers exactly four World operations in the 32-command catalog', () => {
    expect(WORLD_COMMAND_TYPES).toHaveLength(4);
    expect(COMMAND_TYPES).toHaveLength(32);
    expect(new Set(COMMAND_TYPES).size).toBe(32);
  });
  it.each(cases)(
    'validates $type payload/result, policy, audit allowlist and redaction',
    (sample) => {
      expect(commandPayload(sample.type, sample.payload)).toEqual(
        sample.payload,
      );
      expect(commandResult(sample.type, sample.result, sample.payload)).toEqual(
        sample.result,
      );
      expect(WORLD_POLICY[sample.type].permission).toBe(sample.permission);
      expect(WORLD_POLICY[sample.type].auditAction).toBe(sample.action);
      for (const extra of [
        { rawCommand: 'x' },
        { consoleCommand: 'x' },
        { script: 'x' },
        { coordinates: [] },
        { staffId: randomUUID() },
      ])
        expect(() =>
          worldPayload(sample.type, { ...sample.payload, ...extra }),
        ).toThrow();
      for (const result of [
        null,
        [],
        {},
        { ...sample.result, extra: true },
        { arbitrary: 'x'.repeat(65536) },
      ])
        expect(() =>
          worldResult(sample.type, result, sample.payload),
        ).toThrow();
      const command = Object.assign(new GameCommand(), {
        id: randomUUID(),
        gameServerId: randomUUID(),
        correlationId: randomUUID(),
        type: sample.type,
        payload: sample.payload,
        status: S.SUCCEEDED,
        idempotencyKey: 'secret-key',
        dispatchLeaseId: randomUUID(),
        dispatchedConnectionId: randomUUID(),
        result: Object.assign(new GameCommandResult(), {
          outcome: S.SUCCEEDED,
          result: sample.result,
          errorCode: null,
          errorMessage: null,
          receivedAt: new Date(),
        }),
      });
      expect(worldDetail(command).result?.result).toEqual(sample.result);
      expect(worldReference(command)).not.toHaveProperty('payload');
      expect(JSON.stringify(commandDetail(command))).not.toMatch(
        /gameHour|weatherId|baseFormId|quantity|Quantity|actorStaffId|opaque:|secret-key|dispatchLease|dispatchedConnection/,
      );
      if (sample.action) {
        const audit = worldAuditMetadata(command);
        expect(audit).toEqual({
          gameServerId: command.gameServerId,
          commandId: command.id,
          correlationId: command.correlationId,
          ...sample.payload,
        });
        expect(sanitizeMetadata(audit)).toEqual(audit);
      } else expect(() => worldAuditMetadata(command)).toThrow();
    },
  );
  it.each([-1, 24, 25, NaN, Infinity, -Infinity, '12', null, undefined, true])(
    'rejects invalid hour %#',
    (value) => {
      expect(() => gameHour(value)).toThrow();
      expect(() =>
        worldPayload('WORLD_TIME_SET', { gameHour: value }),
      ).toThrow();
      expect(() =>
        worldResult(
          'WORLD_STATE_QUERY',
          { gameHour: value, weatherId: null },
          {},
        ),
      ).toThrow();
    },
  );
  it.each([0, 0.5, 23.999999999])(
    'accepts hour %s and validates explicit SET result',
    (value) => {
      expect(worldPayload('WORLD_TIME_SET', { gameHour: value })).toEqual({
        gameHour: value,
      });
      expect(
        worldResult('WORLD_TIME_SET', { gameHour: value }, { gameHour: value }),
      ).toEqual({ gameHour: value });
      expect(() =>
        worldResult('WORLD_TIME_SET', { gameHour: value }, { gameHour: 12 }),
      ).toThrow();
    },
  );
  it.each([
    '',
    ' ',
    'x'.repeat(129),
    'x\n',
    '\u0000',
    '\u0085',
    '\ud800',
    null,
    1,
  ])('rejects opaque identifier %#', (value) => {
    expect(() =>
      worldPayload('WORLD_WEATHER_SET', { weatherId: value }),
    ).toThrow();
    expect(() =>
      worldPayload('WORLD_ENTITY_SPAWN', {
        actorStaffId: randomUUID(),
        baseFormId: value,
        quantity: 1,
      }),
    ).toThrow();
    if (value === null)
      expect(
        worldResult(
          'WORLD_STATE_QUERY',
          { gameHour: 12, weatherId: value },
          {},
        ),
      ).toEqual({ gameHour: 12, weatherId: null });
    else
      expect(() =>
        worldResult(
          'WORLD_STATE_QUERY',
          { gameHour: 12, weatherId: value },
          {},
        ),
      ).toThrow();
  });
  it.each([0, -1, 11, 1.5, NaN, Infinity, '1', null, undefined])(
    'rejects invalid quantity %#',
    (value) => {
      expect(() => spawnQuantity(value)).toThrow();
      expect(() =>
        worldPayload('WORLD_ENTITY_SPAWN', {
          actorStaffId: randomUUID(),
          baseFormId: 'b',
          quantity: value,
        }),
      ).toThrow();
    },
  );
  it('normalizes opaque IDs without format assumptions and never evaluates them', () => {
    const weatherId = 'text ; with spaces () <literal>';
    expect(
      worldPayload('WORLD_WEATHER_SET', { weatherId: ` ${weatherId} ` }),
    ).toEqual({ weatherId });
    expect(
      worldResult(
        'WORLD_WEATHER_SET',
        { weatherId: ` ${weatherId} ` },
        { weatherId },
      ),
    ).toEqual({ weatherId });
    expect(() =>
      worldResult('WORLD_WEATHER_SET', { weatherId: 'other' }, { weatherId }),
    ).toThrow();
    expect(
      sameCommand(
        { type: 'WORLD_WEATHER_SET', payload: { weatherId } },
        'WORLD_WEATHER_SET',
        { weatherId: ` ${weatherId} ` },
      ),
    ).toBe(true);
    expect(
      worldPayload('WORLD_WEATHER_SET', { weatherId: 'x'.repeat(128) }),
    ).toEqual({ weatherId: 'x'.repeat(128) });
  });
  it('validates spawn identity, quantities and partial results', () => {
    const payload = {
      actorStaffId: randomUUID(),
      baseFormId: 'b',
      quantity: 10,
    };
    const result = {
      actorStaffId: payload.actorStaffId,
      baseFormId: 'b',
      requestedQuantity: 10,
      spawnedQuantity: 10,
    };
    for (const spawnedQuantity of [0, 1, 10])
      expect(
        worldResult(
          'WORLD_ENTITY_SPAWN',
          { ...result, spawnedQuantity },
          payload,
        ),
      ).toEqual({ ...result, spawnedQuantity });
    for (const extra of [
      { actorStaffId: randomUUID() },
      { baseFormId: 'other' },
      { requestedQuantity: 1 },
      { spawnedQuantity: 11 },
      { spawnedQuantity: -1 },
      { spawnedQuantity: 1.5 },
      { spawnedQuantity: '1' },
    ])
      expect(() =>
        worldResult('WORLD_ENTITY_SPAWN', { ...result, ...extra }, payload),
      ).toThrow();
    expect(() =>
      worldPayload('WORLD_ENTITY_SPAWN', {
        ...payload,
        actorStaffId: 'invalid',
      }),
    ).toThrow();
  });
  it('rejects hostile JSON without executing getters or toJSON', () => {
    for (const value of [
      {
        get gameHour() {
          throw new Error('invoked');
        },
      },
      {
        gameHour: 1,
        toJSON() {
          throw new Error('invoked');
        },
      },
    ])
      expect(() => worldPayload('WORLD_TIME_SET', value)).toThrow(
        'Invalid JSON',
      );
    expect(() =>
      worldReference(Object.assign(new GameCommand(), { type: 'PLAYER_BAN' })),
    ).toThrow();
  });
  it.each(Object.values(R))(
    'explicitly grants World permissions to %s',
    (role) => {
      const expected =
        role === R.COORDINATOR || role === R.GENERAL_CHIEF
          ? [
              P.WORLD_READ,
              P.WORLD_TIME_WRITE,
              P.WORLD_WEATHER_WRITE,
              P.WORLD_ENTITY_SPAWN,
            ]
          : role === R.ADMIN
            ? [P.WORLD_READ]
            : [];
      expect(
        ROLE_PERMISSIONS[role].filter((p) => p.startsWith('WORLD_')),
      ).toEqual(expected);
    },
  );
  it('rejects forged actor at the domain boundary, snapshots identity and omits audit callback for query', async () => {
    const auth: AuthenticatedStaff = {
      user: Object.assign(new StaffUser(), { id: randomUUID() }),
      permissions: [P.WORLD_ENTITY_SPAWN, P.WORLD_READ],
      sessionId: randomUUID(),
    };
    const submissions: SubmitCommand[] = [];
    const callbacks: unknown[] = [];
    const commands = {
      async create(
        input: SubmitCommand,
        _auth: AuthenticatedStaff,
        _permission: P,
        event: unknown,
      ) {
        submissions.push(input);
        callbacks.push(event);
        return Object.assign(new GameCommand(), { id: randomUUID(), ...input });
      },
    };
    const service = new WorldService(
      commands as unknown as AdministrativeCommandService,
    );
    const input: WorldSubmission = {
      type: 'WORLD_ENTITY_SPAWN',
      gameServerId: randomUUID(),
      idempotencyKey: 'k',
      payload: { baseFormId: ' b ', quantity: 1 },
    };
    await expect(
      service.create(
        {
          ...input,
          payload: { ...input.payload, actorStaffId: auth.user.id },
        } as unknown as WorldSubmission,
        auth,
      ),
    ).rejects.toThrow();
    expect(submissions).toHaveLength(0);
    const original = auth.user.id;
    const pending = service.create(input, auth);
    auth.user.id = randomUUID();
    input.payload.quantity = 9;
    await pending;
    expect(submissions[0].payload).toEqual({
      actorStaffId: original,
      baseFormId: 'b',
      quantity: 1,
    });
    expect(callbacks[0]).toEqual(expect.any(Function));
    await service.create(
      {
        type: 'WORLD_STATE_QUERY',
        gameServerId: randomUUID(),
        idempotencyKey: 'query',
        payload: {},
      },
      auth,
    );
    expect(callbacks[1]).toBeUndefined();
  });
});
