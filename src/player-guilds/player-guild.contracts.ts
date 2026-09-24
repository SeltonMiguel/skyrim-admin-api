import { BadRequestException } from '@nestjs/common';

// Provisional guild size, not tied to VIP. Change here; capacity is enforced
// under the guild row lock, so no migration is needed to adjust it.
export const MAX_GUILD_MEMBERS = 50;
export const GUILD_NAME_MIN_LENGTH = 3;
export const GUILD_NAME_MAX_LENGTH = 48;

export enum GuildStatus {
  ACTIVE = 'ACTIVE',
  DISBANDED = 'DISBANDED',
}
export enum GuildRole {
  MASTER = 'MASTER',
  OFFICER = 'OFFICER',
  MEMBER = 'MEMBER',
}
export enum GuildInviteStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  DECLINED = 'DECLINED',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED',
}
// Why a PENDING invite was cancelled as a side effect of another mutation.
export enum GuildInviteCancelReason {
  TARGET_JOINED_ANOTHER_GUILD = 'TARGET_JOINED_ANOTHER_GUILD',
  GUILD_DISBANDED = 'GUILD_DISBANDED',
}
// Role policy in one place: who may do what (MASTER changes need transfer).
export const GUILD_PERMISSIONS = {
  invite: [GuildRole.MASTER, GuildRole.OFFICER],
  kick: [GuildRole.MASTER],
  changeRole: [GuildRole.MASTER],
  transferMaster: [GuildRole.MASTER],
  disband: [GuildRole.MASTER],
} as const satisfies Record<string, readonly GuildRole[]>;
export type GuildPermission = keyof typeof GUILD_PERMISSIONS;
export const guildCan = (role: GuildRole, permission: GuildPermission) =>
  (GUILD_PERMISSIONS[permission] as readonly GuildRole[]).includes(role);

// Controls, format characters (zero-width, bidi overrides), line/paragraph
// separators, private-use, unassigned and lone surrogate code points.
const FORBIDDEN_NAME_CHARACTERS =
  /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/u;

// Display name: trimmed, 3..48 code points, otherwise preserved as typed.
export function guildName(value: unknown): string {
  if (typeof value !== 'string' || FORBIDDEN_NAME_CHARACTERS.test(value))
    throw new BadRequestException('Invalid guild name');
  const name = value.trim();
  const length = [...name].length;
  if (length < GUILD_NAME_MIN_LENGTH || length > GUILD_NAME_MAX_LENGTH)
    throw new BadRequestException('Invalid guild name');
  return name;
}
// Uniqueness key, computed once and stored: NFKC (compatibility forms such as
// full-width letters fold together), full case folding approximated by
// upper-then-lower (so "ß" and "SS" collide), NFKC again, and whitespace runs
// collapsed to one space. Locale-independent, so it is deterministic.
export function guildNameKey(name: string): string {
  return name
    .normalize('NFKC')
    .toUpperCase()
    .toLowerCase()
    .normalize('NFKC')
    .replace(/\s+/gu, ' ');
}
