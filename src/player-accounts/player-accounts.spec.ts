import { BadRequestException } from '@nestjs/common';
import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  IdentityProvider,
  identityProvider,
  MAX_PLAYER_DISPLAY_NAME_LENGTH,
  playerDisplayName,
  PlayerStatus,
  providerSubject,
} from './player-account.contracts.js';
import { PlayerAccountsModule } from './player-accounts.module.js';

describe('Player account contracts', () => {
  it('defines the three account statuses and initial providers', () => {
    expect(Object.values(PlayerStatus)).toEqual([
      'ACTIVE',
      'SUSPENDED',
      'BANNED',
    ]);
    expect(Object.values(IdentityProvider)).toEqual(['DISCORD', 'STEAM']);
    for (const provider of Object.values(IdentityProvider))
      expect(identityProvider(provider)).toBe(provider);
    for (const invalid of ['GOOGLE', 'discord', '', null, 1])
      expect(() => identityProvider(invalid)).toThrow(BadRequestException);
  });
  it('trims and bounds display names without requiring uniqueness', () => {
    expect(MAX_PLAYER_DISPLAY_NAME_LENGTH).toBe(64);
    expect(playerDisplayName('  Lydia  ')).toBe('Lydia');
    expect(playerDisplayName('x'.repeat(64))).toHaveLength(64);
    for (const invalid of ['', ' ', 'x'.repeat(65), 'a\tb', '\ud800', 1, null])
      expect(() => playerDisplayName(invalid)).toThrow(BadRequestException);
  });
  it('keeps provider subjects opaque and never echoes them in errors', () => {
    expect(providerSubject('  123456789012345678  ')).toBe(
      '123456789012345678',
    );
    expect(providerSubject('https://x/y?z#w')).toBe('https://x/y?z#w');
    const leak = 'private-subject';
    for (const invalid of ['', 'x'.repeat(129), `${leak}\u0000`, {}, null]) {
      let error: unknown;
      try {
        providerSubject(invalid);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(BadRequestException);
      expect(
        JSON.stringify((error as BadRequestException).getResponse()),
      ).not.toContain(leak);
    }
  });
  it('has no HTTP surface and no staff, session, token or logging dependency', () => {
    expect(Reflect.getMetadata('controllers', PlayerAccountsModule)).toBe(
      undefined,
    );
    const files = globSync(
      fileURLToPath(new URL('./**/*.ts', import.meta.url)),
    ).filter((file) => !file.endsWith('.spec.ts'));
    expect(files.length).toBe(5);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      for (const module of imports)
        expect(module).not.toMatch(/staff|auth|rbac|session|jose|argon2/i);
      expect(source).not.toMatch(/\bLogger\b|console\./);
    }
  });
});
