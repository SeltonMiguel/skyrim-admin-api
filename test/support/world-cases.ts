import type {
  WorldCommandType,
  WorldPayload,
  WorldResult,
} from '../../src/world-management/world-command.contracts.js';
import { Permission as P } from '../../src/rbac/permissions.js';
import { AuditAction as A } from '../../src/audit/audit.types.js';
export type WorldCase = {
  [T in WorldCommandType]: {
    type: T;
    path: string;
    permission: P;
    action?: A;
    body: Omit<WorldPayload<T>, 'actorStaffId'>;
    payload: WorldPayload<T>;
    result: WorldResult<T>;
  };
}[WorldCommandType];
export function worldCases(actorStaffId: string): WorldCase[] {
  return [
    {
      type: 'WORLD_STATE_QUERY',
      path: 'state/query',
      permission: P.WORLD_READ,
      body: {},
      payload: {},
      result: { gameHour: 12.5, weatherId: null },
    },
    {
      type: 'WORLD_TIME_SET',
      path: 'time',
      permission: P.WORLD_TIME_WRITE,
      action: A.WORLD_TIME_SET_REQUESTED,
      body: { gameHour: 6.25 },
      payload: { gameHour: 6.25 },
      result: { gameHour: 6.25 },
    },
    {
      type: 'WORLD_WEATHER_SET',
      path: 'weather',
      permission: P.WORLD_WEATHER_WRITE,
      action: A.WORLD_WEATHER_SET_REQUESTED,
      body: { weatherId: 'opaque:weather' },
      payload: { weatherId: 'opaque:weather' },
      result: { weatherId: 'opaque:weather' },
    },
    {
      type: 'WORLD_ENTITY_SPAWN',
      path: 'spawn',
      permission: P.WORLD_ENTITY_SPAWN,
      action: A.WORLD_ENTITY_SPAWN_REQUESTED,
      body: { baseFormId: 'opaque:entity', quantity: 3 },
      payload: { actorStaffId, baseFormId: 'opaque:entity', quantity: 3 },
      result: {
        actorStaffId,
        baseFormId: 'opaque:entity',
        requestedQuantity: 3,
        spawnedQuantity: 2,
      },
    },
  ];
}
