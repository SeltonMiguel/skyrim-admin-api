import { Permission as P } from '../rbac/permissions.js';
import { AuditAction as A } from '../audit/audit.types.js';
import type { WorldCommandType } from './world-command.contracts.js';
export const WORLD_POLICY: Readonly<
  Record<WorldCommandType, { permission: P; auditAction?: A }>
> = {
  WORLD_STATE_QUERY: { permission: P.WORLD_READ },
  WORLD_TIME_SET: {
    permission: P.WORLD_TIME_WRITE,
    auditAction: A.WORLD_TIME_SET_REQUESTED,
  },
  WORLD_WEATHER_SET: {
    permission: P.WORLD_WEATHER_WRITE,
    auditAction: A.WORLD_WEATHER_SET_REQUESTED,
  },
  WORLD_ENTITY_SPAWN: {
    permission: P.WORLD_ENTITY_SPAWN,
    auditAction: A.WORLD_ENTITY_SPAWN_REQUESTED,
  },
};
