import { createHash } from 'node:crypto';
import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CHALLENGE_ALPHABET,
  CHALLENGE_LENGTH,
  challengeHash,
  CharacterLinkStatus,
  generateChallenge,
  normalizeChallenge,
} from './player-character.contracts.js';
import { PlayerCharactersModule } from './player-characters.module.js';
import { CharacterLinkController } from './character-link.controller.js';

describe('Character link challenge', () => {
  it('uses an unambiguous alphabet with at least 60 bits of entropy', () => {
    expect(new Set(CHALLENGE_ALPHABET).size).toBe(CHALLENGE_ALPHABET.length);
    for (const ambiguous of ['0', 'O', '1', 'I', 'L'])
      expect(CHALLENGE_ALPHABET).not.toContain(ambiguous);
    expect(
      CHALLENGE_LENGTH * Math.log2(CHALLENGE_ALPHABET.length),
    ).toBeGreaterThanOrEqual(60);
  });
  it('generates grouped, well-formed and unique challenges', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const value = generateChallenge();
      expect(value).toMatch(
        /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{5}$/,
      );
      seen.add(value);
    }
    expect(seen.size).toBe(2000);
  });
  it('normalizes typed input and hashes only the canonical form', () => {
    const value = generateChallenge();
    const canonical = value.replaceAll('-', '');
    for (const typed of [
      value,
      canonical,
      value.toLowerCase(),
      ` ${value.replaceAll('-', ' ')} `,
    ])
      expect(normalizeChallenge(typed)).toBe(canonical);
    for (const invalid of [
      '',
      'ABCD',
      `${canonical}X`,
      canonical.replace(/./, '0'),
      1,
      null,
      'x'.repeat(65),
    ])
      expect(normalizeChallenge(invalid)).toBeNull();
    expect(challengeHash(canonical)).toBe(
      createHash('sha256').update(canonical).digest('hex'),
    );
    expect(challengeHash(canonical)).not.toContain(canonical);
  });
  it('defines the three ownership states', () => {
    expect(Object.values(CharacterLinkStatus)).toEqual([
      'PENDING',
      'VERIFIED',
      'REVOKED',
    ]);
  });
});

describe('Player characters boundaries', () => {
  it('exposes only the player link controller, no Agent endpoint or GameCommand', () => {
    expect(Reflect.getMetadata('controllers', PlayerCharactersModule)).toEqual([
      CharacterLinkController,
    ]);
    const files = globSync(
      fileURLToPath(new URL('./**/*.ts', import.meta.url)),
    ).filter((file) => !file.endsWith('.spec.ts'));
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      for (const module of imports)
        expect(module).not.toMatch(
          /game-command|actor-operations|administrative-operations|game-gateway/,
        );
      expect(source).not.toMatch(
        /@(Post|Get|Put|Patch|Delete)\(['"][^'"]*(agent|confirm|verify)/i,
      );
      expect(source).not.toMatch(/\bLogger\b|console\./);
    }
  });
});
