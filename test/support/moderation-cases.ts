import type {
  ModerationCommandType,
  ModerationPayload,
  ModerationResult,
} from '../../src/moderation/moderation-command.contracts.js';
import { Permission as P } from '../../src/rbac/permissions.js';
import { AuditAction as A } from '../../src/audit/audit.types.js';
export type ModerationCase = {
  [T in ModerationCommandType]: {
    type: T;
    path: string;
    permission: P;
    action: A;
    body: T extends 'PLAYER_TELEPORT_TO_STAFF'
      ? Record<string, never>
      : Omit<ModerationPayload<T>, 'actorStaffId' | 'playerId'>;
    payload: ModerationPayload<T>;
    result: ModerationResult<T>;
  };
}[ModerationCommandType];
export function moderationCases(actorStaffId: string): ModerationCase[] {
  return [
    {
      type: 'PLAYER_BAN',
      path: 'players/opaque:player-42/ban',
      permission: P.PLAYER_BAN,
      action: A.PLAYER_BAN_REQUESTED,
      body: { reason: 'private ban reason' },
      payload: { playerId: 'opaque:player-42', reason: 'private ban reason' },
      result: { playerId: 'opaque:player-42', banned: true },
    },
    {
      type: 'PLAYER_UNBAN',
      path: 'players/opaque:player-42/unban',
      permission: P.PLAYER_UNBAN,
      action: A.PLAYER_UNBAN_REQUESTED,
      body: {},
      payload: { playerId: 'opaque:player-42' },
      result: { playerId: 'opaque:player-42', banned: false },
    },
    {
      type: 'PLAYER_GOD_MODE_SET',
      path: 'players/opaque:player-42/god-mode',
      permission: P.PLAYER_GOD_MODE,
      action: A.PLAYER_GOD_MODE_SET_REQUESTED,
      body: { enabled: true },
      payload: { playerId: 'opaque:player-42', enabled: true },
      result: { playerId: 'opaque:player-42', enabled: true },
    },
    {
      type: 'STAFF_NOCLIP_SET',
      path: 'staff/me/noclip',
      permission: P.STAFF_NOCLIP,
      action: A.STAFF_NOCLIP_SET_REQUESTED,
      body: { enabled: true },
      payload: { actorStaffId, enabled: true },
      result: { actorStaffId, enabled: true },
    },
    {
      type: 'STAFF_INVISIBILITY_SET',
      path: 'staff/me/invisibility',
      permission: P.STAFF_INVISIBILITY,
      action: A.STAFF_INVISIBILITY_SET_REQUESTED,
      body: { enabled: false },
      payload: { actorStaffId, enabled: false },
      result: { actorStaffId, enabled: false },
    },
    {
      type: 'ANNOUNCEMENT_SEND',
      path: 'announcements',
      permission: P.ANNOUNCEMENT_SEND,
      action: A.ANNOUNCEMENT_SEND_REQUESTED,
      body: { message: 'private announcement text' },
      payload: { message: 'private announcement text' },
      result: { sent: true },
    },
    {
      type: 'STAFF_TELEPORT_TO_PLAYER',
      path: 'staff/me/teleport-to-player',
      permission: P.STAFF_TELEPORT_TO_PLAYER,
      action: A.STAFF_TELEPORT_TO_PLAYER_REQUESTED,
      body: { targetPlayerId: 'opaque:player-42' },
      payload: { actorStaffId, targetPlayerId: 'opaque:player-42' },
      result: {
        actorStaffId,
        targetPlayerId: 'opaque:player-42',
        teleported: true,
      },
    },
    {
      type: 'PLAYER_TELEPORT_TO_STAFF',
      path: 'players/opaque:player-42/teleport-to-me',
      permission: P.PLAYER_TELEPORT_TO_STAFF,
      action: A.PLAYER_TELEPORT_TO_STAFF_REQUESTED,
      body: {},
      payload: { actorStaffId, targetPlayerId: 'opaque:player-42' },
      result: {
        actorStaffId,
        targetPlayerId: 'opaque:player-42',
        teleported: true,
      },
    },
  ] satisfies ModerationCase[];
}
