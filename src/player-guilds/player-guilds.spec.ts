import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import type { AuditService } from '../audit/audit.service.js';
import {
  REALTIME_EVENT_TYPES,
  RealtimeEventBus,
} from '../realtime-events/realtime-event-bus.js';
import { PlayerGuildService } from './player-guild.service.js';
import {
  GUILD_NAME_MAX_LENGTH,
  GUILD_NAME_MIN_LENGTH,
  GuildInviteCancelReason,
  GuildRole,
  MAX_GUILD_MEMBERS,
  guildCan,
  guildName,
  guildNameKey,
} from './player-guild.contracts.js';

describe('Guild name', () => {
  it('trims and preserves the display name within 3..48 code points', () => {
    expect(guildName('  Os Companheiros  ')).toBe('Os Companheiros');
    expect(guildName('ÁÉÍ')).toBe('ÁÉÍ');
    expect(guildName('🐉🐉🐉')).toBe('🐉🐉🐉');
    expect(guildName('x'.repeat(GUILD_NAME_MAX_LENGTH))).toHaveLength(48);
    expect([...guildName('ç'.repeat(48))]).toHaveLength(48);
    expect(GUILD_NAME_MIN_LENGTH).toBe(3);
  });
  it('rejects wrong types, lengths, controls, invisible and invalid Unicode', () => {
    for (const value of [
      undefined,
      null,
      123,
      ['abc'],
      '',
      '   ',
      'ab',
      '  ab  ',
      'x'.repeat(49),
      'abc\u0000',
      'a\nbc',
      'a\tbc',
      'ab\u009fc',
      'ab​c',
      'ab‮c',
      'ab c',
      'abc',
      'ab\ud800c',
    ])
      expect(() => guildName(value)).toThrow('Invalid guild name');
  });
  it('derives a deterministic, case- and compatibility-insensitive key', () => {
    const key = guildNameKey('Os Companheiros');
    for (const variant of [
      'OS COMPANHEIROS',
      'os companheiros',
      'Os  Companheiros',
      'Ｏｓ Ｃｏｍｐａｎｈｅｉｒｏｓ',
    ])
      expect(guildNameKey(variant)).toBe(key);
    expect(guildNameKey('Straße')).toBe(guildNameKey('STRASSE'));
    expect(guildNameKey('Café')).toBe(guildNameKey('Café'));
    expect(guildNameKey('Guild A')).not.toBe(guildNameKey('Guild B'));
    expect(guildNameKey('Cafe')).not.toBe(guildNameKey('Café'));
  });
});

describe('Guild role policy', () => {
  it('lets MASTER do everything, OFFICER only invite and MEMBER nothing', () => {
    const permissions = [
      'invite',
      'kick',
      'changeRole',
      'transferMaster',
      'disband',
    ] as const;
    const allowed = (role: GuildRole) =>
      permissions.filter((p) => guildCan(role, p));
    expect(allowed(GuildRole.MASTER)).toEqual([...permissions]);
    expect(allowed(GuildRole.OFFICER)).toEqual(['invite']);
    expect(allowed(GuildRole.MEMBER)).toEqual([]);
  });
  it('keeps the provisional member limit centralized', () => {
    expect(MAX_GUILD_MEMBERS).toBe(50);
  });
  it('publishes typed guild events through the shared bus', () => {
    expect(REALTIME_EVENT_TYPES.filter((t) => t.startsWith('GUILD_'))).toEqual([
      'GUILD_CREATED',
      'GUILD_INVITE_CREATED',
      'GUILD_INVITE_ACCEPTED',
      'GUILD_INVITE_DECLINED',
      'GUILD_INVITE_CANCELLED',
      'GUILD_MEMBER_JOINED',
      'GUILD_MEMBER_LEFT',
      'GUILD_MEMBER_KICKED',
      'GUILD_MEMBER_ROLE_CHANGED',
      'GUILD_MASTER_TRANSFERRED',
      'GUILD_DISBANDED',
    ]);
  });
});

describe('Guild boundaries', () => {
  const sources = globSync(fileURLToPath(new URL('./**/*.ts', import.meta.url)))
    .filter((file) => !file.endsWith('.spec.ts'))
    .map((file) => readFileSync(file, 'utf8'));
  it('has no Game Bridge command, Agent, faction or group coupling', () => {
    for (const source of sources) {
      for (const [, module] of source.matchAll(/from '([^']+)'/g))
        expect(module).not.toMatch(
          /game-command|actor-operations|player-character-operations|player-groups|character-management|\/realtime\/|^ws$/,
        );
      expect(source).not.toMatch(/CHARACTER_FACTION|GameCommand/);
    }
  });
});

describe('Guild realtime publication', () => {
  type Work = (manager: unknown, events: unknown[]) => Promise<unknown>;
  const service = (transaction: (work: Work) => Promise<unknown>) => {
    const bus = new RealtimeEventBus();
    const publish = jest.spyOn(bus, 'publish');
    const guilds = new PlayerGuildService(
      { transaction } as unknown as DataSource,
      {} as AuditService,
      bus,
      {
        get: () => ({ playerGuilds: { inviteTtl: 60 } }),
      } as unknown as ConfigService<never, true>,
    );
    const mutate = (
      guilds as unknown as { mutate: (work: Work) => Promise<unknown> }
    ).mutate.bind(guilds);
    return { mutate, publish };
  };
  const cancelled = {
    type: 'GUILD_INVITE_CANCELLED',
    data: {
      guildId: 'g',
      inviteId: 'i',
      targetCharacterId: 'c',
      reason: GuildInviteCancelReason.GUILD_DISBANDED,
    },
    playerIds: ['p'],
  };
  it('publishes queued events only after the transaction commits', async () => {
    let committed = false;
    const { mutate, publish } = service(async (work) => {
      const result = await work({}, []);
      expect(publish).not.toHaveBeenCalled();
      committed = true;
      return result;
    });
    publish.mockImplementation(() => {
      expect(committed).toBe(true);
      return {} as never;
    });
    await mutate(async (_manager, events) => {
      events.push(cancelled);
      return 'ok';
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      'GUILD_INVITE_CANCELLED',
      cancelled.data,
      { playerIds: ['p'] },
    );
  });
  it('publishes nothing when the transaction rolls back', async () => {
    const { mutate, publish } = service(async (work) => {
      await work({}, []);
      throw new Error('rolled back');
    });
    await expect(
      mutate(async (_manager, events) => {
        events.push(cancelled);
      }),
    ).rejects.toThrow('rolled back');
    expect(publish).not.toHaveBeenCalled();
  });
  it('has a closed set of cancellation reasons', () => {
    expect(Object.values(GuildInviteCancelReason)).toEqual([
      'TARGET_JOINED_ANOTHER_GUILD',
      'GUILD_DISBANDED',
    ]);
  });
});
