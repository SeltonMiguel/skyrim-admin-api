import { BadRequestException, ConflictException } from '@nestjs/common';
import { commandJson } from '../game-bridge/command-json.js';
import {
  MAX_COMMAND_PAYLOAD_BYTES,
  MAX_COMMAND_RESULT_BYTES,
} from '../game-bridge/command-limits.js';
import { externalId, fields } from '../game-bridge/command-validation.js';
import {
  enabledValue,
  moderationText,
  staffId,
} from './moderation-validation.js';

export interface PlayerBanPayload {
  playerId: string;
  reason?: string;
}
export interface PlayerModePayload {
  playerId: string;
  enabled: boolean;
}
export interface StaffModePayload {
  actorStaffId: string;
  enabled: boolean;
}
export interface TeleportPayload {
  actorStaffId: string;
  targetPlayerId: string;
}
export interface AnnouncementPayload {
  message: string;
}
export interface ModerationCommandMap {
  PLAYER_BAN: {
    payload: PlayerBanPayload;
    result: { playerId: string; banned: true };
  };
  PLAYER_UNBAN: {
    payload: PlayerBanPayload;
    result: { playerId: string; banned: false };
  };
  PLAYER_GOD_MODE_SET: {
    payload: PlayerModePayload;
    result: PlayerModePayload;
  };
  STAFF_NOCLIP_SET: { payload: StaffModePayload; result: StaffModePayload };
  STAFF_INVISIBILITY_SET: {
    payload: StaffModePayload;
    result: StaffModePayload;
  };
  ANNOUNCEMENT_SEND: { payload: AnnouncementPayload; result: { sent: true } };
  STAFF_TELEPORT_TO_PLAYER: {
    payload: TeleportPayload;
    result: TeleportPayload & { teleported: true };
  };
  PLAYER_TELEPORT_TO_STAFF: {
    payload: TeleportPayload;
    result: TeleportPayload & { teleported: true };
  };
}
export type ModerationCommandType = keyof ModerationCommandMap;
export type ModerationPayload<
  T extends ModerationCommandType = ModerationCommandType,
> = ModerationCommandMap[T]['payload'];
export type ModerationResult<
  T extends ModerationCommandType = ModerationCommandType,
> = ModerationCommandMap[T]['result'];
function ban(value: unknown): PlayerBanPayload {
  const data = fields(value, ['playerId'], ['reason']);
  return {
    playerId: externalId(data.playerId),
    ...(data.reason === undefined
      ? {}
      : { reason: moderationText(data.reason) }),
  };
}
function playerMode(value: unknown): PlayerModePayload {
  const data = fields(value, ['playerId', 'enabled']);
  return {
    playerId: externalId(data.playerId),
    enabled: enabledValue(data.enabled),
  };
}
function staffMode(value: unknown): StaffModePayload {
  const data = fields(value, ['actorStaffId', 'enabled']);
  return {
    actorStaffId: staffId(data.actorStaffId),
    enabled: enabledValue(data.enabled),
  };
}
function teleport(value: unknown): TeleportPayload {
  const data = fields(value, ['actorStaffId', 'targetPlayerId']);
  return {
    actorStaffId: staffId(data.actorStaffId),
    targetPlayerId: externalId(data.targetPlayerId),
  };
}
const contracts: {
  [T in ModerationCommandType]: {
    payload: (value: unknown) => ModerationPayload<T>;
    expectedResult: (payload: ModerationPayload<T>) => ModerationResult<T>;
  };
} = {
  PLAYER_BAN: {
    payload: ban,
    expectedResult: (p) => ({ playerId: p.playerId, banned: true }),
  },
  PLAYER_UNBAN: {
    payload: ban,
    expectedResult: (p) => ({ playerId: p.playerId, banned: false }),
  },
  PLAYER_GOD_MODE_SET: {
    payload: playerMode,
    expectedResult: (p) => ({ ...p }),
  },
  STAFF_NOCLIP_SET: { payload: staffMode, expectedResult: (p) => ({ ...p }) },
  STAFF_INVISIBILITY_SET: {
    payload: staffMode,
    expectedResult: (p) => ({ ...p }),
  },
  ANNOUNCEMENT_SEND: {
    payload: (value) => ({
      message: moderationText(fields(value, ['message']).message),
    }),
    expectedResult: () => ({ sent: true }),
  },
  STAFF_TELEPORT_TO_PLAYER: {
    payload: teleport,
    expectedResult: (p) => ({ ...p, teleported: true }),
  },
  PLAYER_TELEPORT_TO_STAFF: {
    payload: teleport,
    expectedResult: (p) => ({ ...p, teleported: true }),
  },
};
export const MODERATION_COMMAND_TYPES = Object.keys(
  contracts,
) as ModerationCommandType[];
export function isModerationCommand(
  type: string,
): type is ModerationCommandType {
  return Object.hasOwn(contracts, type);
}
export function moderationPayload<T extends ModerationCommandType>(
  type: T,
  value: unknown,
): ModerationPayload<T> {
  if (!isModerationCommand(type))
    throw new BadRequestException('Unsupported moderation command');
  return contracts[type].payload(commandJson(value, MAX_COMMAND_PAYLOAD_BYTES));
}
export function moderationResult<T extends ModerationCommandType>(
  type: T,
  value: unknown,
  payload: unknown,
): ModerationResult<T> {
  const request = moderationPayload(type, payload);
  const expected = contracts[type].expectedResult(request);
  const data = fields(
    commandJson(value, MAX_COMMAND_RESULT_BYTES),
    Object.keys(expected),
  );
  for (const [key, wanted] of Object.entries(expected)) {
    const actual =
      key === 'playerId' || key === 'targetPlayerId'
        ? externalId(data[key])
        : data[key];
    if (actual !== wanted)
      throw new ConflictException(
        'Moderation result does not match requested operation',
      );
  }
  return expected;
}
