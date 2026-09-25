import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REALTIME_EVENT_TYPES } from '../realtime-events/realtime-event-bus.js';
import { AuditAction, AuditResource } from '../audit/audit.types.js';
import {
  INTERACTION_SETTING,
  PLAYER_SETTING_FIELDS,
  PLAYER_SETTINGS_DEFAULTS,
  PlayerInteraction,
  settingsLocale,
  settingsTimeZone,
} from './player-settings.contracts.js';

describe('Player settings contracts', () => {
  it('has the six account-scoped fields with permissive defaults', () => {
    expect(PLAYER_SETTINGS_DEFAULTS).toEqual({
      locale: 'pt-BR',
      timeZone: 'UTC',
      allowDirectMessages: true,
      allowTradeRequests: true,
      allowGroupInvites: true,
      allowGuildInvites: true,
    });
    expect(PLAYER_SETTING_FIELDS).toEqual(
      Object.keys(PLAYER_SETTINGS_DEFAULTS),
    );
    expect(INTERACTION_SETTING).toEqual({
      [PlayerInteraction.DIRECT_MESSAGE]: 'allowDirectMessages',
      [PlayerInteraction.TRADE_REQUEST]: 'allowTradeRequests',
      [PlayerInteraction.GROUP_INVITE]: 'allowGroupInvites',
      [PlayerInteraction.GUILD_INVITE]: 'allowGuildInvites',
    });
    expect(AuditAction.PLAYER_SETTINGS_UPDATED).toBe('PLAYER_SETTINGS_UPDATED');
    expect(AuditResource.PLAYER_SETTINGS).toBe('PLAYER_SETTINGS');
    expect(REALTIME_EVENT_TYPES).toContain('PLAYER_SETTINGS_UPDATED');
  });
  it('accepts runtime-supported BCP 47 locales in canonical form', () => {
    for (const [input, canonical] of [
      ['pt-BR', 'pt-BR'],
      ['en-us', 'en-US'],
      ['EN', 'en'],
      ['ja-JP', 'ja-JP'],
      ['sr-Latn-RS', 'sr-Latn-RS'],
      ['zh-Hant-TW', 'zh-Hant-TW'],
    ])
      expect(settingsLocale(input)).toBe(canonical);
  });
  it('rejects empty, malformed, unsupported, long or control-character locales', () => {
    for (const value of [
      '',
      ' ',
      'pt_BR',
      'pt-BR ',
      'pt\u0000BR',
      'zz',
      'x-private',
      'not a locale',
      'a'.repeat(36),
      `en-${'x'.repeat(40)}`,
      42,
      null,
    ])
      expect(() => settingsLocale(value)).toThrow('Invalid locale');
  });
  it('accepts IANA time zones as resolved by the runtime', () => {
    for (const [input, resolved] of [
      ['UTC', 'UTC'],
      ['utc', 'UTC'],
      ['America/Sao_Paulo', 'America/Sao_Paulo'],
      ['america/sao_paulo', 'America/Sao_Paulo'],
      ['Europe/London', 'Europe/London'],
      ['Etc/UTC', 'UTC'],
    ])
      expect(settingsTimeZone(input)).toBe(resolved);
  });
  it('rejects unknown zones, offsets and malformed values', () => {
    for (const value of [
      '',
      'Mars/Olympus_Mons',
      '+03:00',
      '-0300',
      'UTC ',
      'America/Sao Paulo',
      'Europe/\u0000London',
      'x'.repeat(65),
      true,
      null,
    ])
      expect(() => settingsTimeZone(value)).toThrow('Invalid time zone');
  });
});

describe('Player settings boundaries', () => {
  const read = (glob: string) =>
    globSync(fileURLToPath(new URL(glob, import.meta.url)))
      .filter((file) => !file.endsWith('.spec.ts'))
      .map((file) => [file, readFileSync(file, 'utf8')] as const);
  const imports = (source: string) =>
    [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  it('depends on no Player domain and never on GameServer', () => {
    for (const [, source] of read('./**/*.ts'))
      for (const module of imports(source))
        expect(module).not.toMatch(
          /player-chat|player-trades|player-groups|player-guilds|player-marketplace|game-bridge|economy|\/realtime\/|^ws$/,
        );
  });
  it('is used by the domains only through its public service and contracts', () => {
    for (const dir of [
      'player-chat',
      'player-trades',
      'player-groups',
      'player-guilds',
    ])
      for (const [, source] of read(`../${dir}/**/*.ts`))
        for (const module of imports(source).filter((m) =>
          m.includes('player-settings/'),
        ))
          expect(module).toMatch(
            /player-settings\/player-settings\.(service|contracts|module)\.js$/,
          );
  });
});
