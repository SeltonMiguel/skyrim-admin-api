import { BadRequestException } from '@nestjs/common';

// Account-scoped Player preferences (10.16): they belong to players.id, so
// every character of the player shares them. Launcher/Electron-local
// settings (theme, window, paths, graphics, keybinds...) stay client-side.
export const PLAYER_SETTINGS_DEFAULTS = {
  locale: 'pt-BR',
  timeZone: 'UTC',
  allowDirectMessages: true,
  allowTradeRequests: true,
  allowGroupInvites: true,
  allowGuildInvites: true,
} as const;
export type PlayerSettingsValues = {
  -readonly [
    K in keyof typeof PLAYER_SETTINGS_DEFAULTS
  ]: (typeof PLAYER_SETTINGS_DEFAULTS)[K] extends boolean ? boolean : string;
};
export type PlayerSettingField = keyof PlayerSettingsValues;
export const PLAYER_SETTING_FIELDS = Object.keys(
  PLAYER_SETTINGS_DEFAULTS,
) as PlayerSettingField[];
// New interactions another player may start with this player. They never
// cancel or hide what already exists.
export enum PlayerInteraction {
  DIRECT_MESSAGE = 'DIRECT_MESSAGE',
  TRADE_REQUEST = 'TRADE_REQUEST',
  GROUP_INVITE = 'GROUP_INVITE',
  GUILD_INVITE = 'GUILD_INVITE',
}
export const INTERACTION_SETTING = {
  [PlayerInteraction.DIRECT_MESSAGE]: 'allowDirectMessages',
  [PlayerInteraction.TRADE_REQUEST]: 'allowTradeRequests',
  [PlayerInteraction.GROUP_INVITE]: 'allowGroupInvites',
  [PlayerInteraction.GUILD_INVITE]: 'allowGuildInvites',
} as const satisfies Record<PlayerInteraction, PlayerSettingField>;
// Also PostgreSQL CHECKs.
export const MAX_LOCALE_LENGTH = 35;
export const MAX_TIME_ZONE_LENGTH = 64;
const LOCALE_SHAPE = /^[A-Za-z0-9-]+$/;
const TIME_ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

// A BCP 47 tag the runtime supports, stored in canonical form (en-us -> en-US).
export function settingsLocale(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > MAX_LOCALE_LENGTH ||
    !LOCALE_SHAPE.test(value)
  )
    throw new BadRequestException('Invalid locale');
  let canonical: string;
  try {
    [canonical] = Intl.getCanonicalLocales(value);
  } catch {
    throw new BadRequestException('Invalid locale');
  }
  if (
    !canonical ||
    canonical.length > MAX_LOCALE_LENGTH ||
    !Intl.DateTimeFormat.supportedLocalesOf([canonical], {
      localeMatcher: 'lookup',
    }).length
  )
    throw new BadRequestException('Invalid locale');
  return canonical;
}
// An IANA time zone the runtime knows, stored as the runtime resolves it
// (america/sao_paulo -> America/Sao_Paulo). Offsets like +03:00 are refused.
export function settingsTimeZone(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > MAX_TIME_ZONE_LENGTH ||
    !TIME_ZONE_SHAPE.test(value)
  )
    throw new BadRequestException('Invalid time zone');
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en-US', {
      timeZone: value,
    }).resolvedOptions().timeZone;
  } catch {
    throw new BadRequestException('Invalid time zone');
  }
  if (resolved.length > MAX_TIME_ZONE_LENGTH || !TIME_ZONE_SHAPE.test(resolved))
    throw new BadRequestException('Invalid time zone');
  return resolved;
}
