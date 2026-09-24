import { Permission as P } from '../rbac/permissions.js';
import { AuditAction as A } from '../audit/audit.types.js';
import type { ModerationCommandType } from './moderation-command.contracts.js';
export const MODERATION_POLICY: Readonly<
  Record<ModerationCommandType, { permission: P; auditAction: A }>
> = {
  PLAYER_BAN: { permission: P.PLAYER_BAN, auditAction: A.PLAYER_BAN_REQUESTED },
  PLAYER_UNBAN: {
    permission: P.PLAYER_UNBAN,
    auditAction: A.PLAYER_UNBAN_REQUESTED,
  },
  PLAYER_GOD_MODE_SET: {
    permission: P.PLAYER_GOD_MODE,
    auditAction: A.PLAYER_GOD_MODE_SET_REQUESTED,
  },
  STAFF_NOCLIP_SET: {
    permission: P.STAFF_NOCLIP,
    auditAction: A.STAFF_NOCLIP_SET_REQUESTED,
  },
  STAFF_INVISIBILITY_SET: {
    permission: P.STAFF_INVISIBILITY,
    auditAction: A.STAFF_INVISIBILITY_SET_REQUESTED,
  },
  ANNOUNCEMENT_SEND: {
    permission: P.ANNOUNCEMENT_SEND,
    auditAction: A.ANNOUNCEMENT_SEND_REQUESTED,
  },
  STAFF_TELEPORT_TO_PLAYER: {
    permission: P.STAFF_TELEPORT_TO_PLAYER,
    auditAction: A.STAFF_TELEPORT_TO_PLAYER_REQUESTED,
  },
  PLAYER_TELEPORT_TO_STAFF: {
    permission: P.PLAYER_TELEPORT_TO_STAFF,
    auditAction: A.PLAYER_TELEPORT_TO_STAFF_REQUESTED,
  },
};
