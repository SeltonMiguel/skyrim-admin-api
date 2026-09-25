import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MAX_PROFESSION_EXPERIENCE,
  MAX_PROFESSION_LEVEL,
  Profession,
  ProfessionProgressionPolicy as Policy,
} from './profession.contracts.js';
import { ProfessionsModule } from './professions.module.js';
import { ProfessionController } from './profession.controller.js';

describe('Profession catalog', () => {
  it('is the closed list of seven professions', () => {
    expect(Object.values(Profession)).toEqual([
      'TAILOR',
      'HUNTER',
      'MINER',
      'BLACKSMITH',
      'ALCHEMIST',
      'CHARCOAL_BURNER',
      'COOK',
    ]);
  });
});

describe('Profession progression policy', () => {
  it.each([
    [1, 0],
    [2, 100],
    [3, 400],
    [4, 900],
    [5, 1600],
    [10, 8100],
    [50, 240100],
    [100, 980100],
  ])('requires cumulative XP 100*(N-1)^2 for level %i (%i)', (level, xp) => {
    expect(Policy.threshold(level)).toBe(xp);
    expect(Policy.levelFor(xp)).toBe(level);
    if (xp > 0) expect(Policy.levelFor(xp - 1)).toBe(level - 1);
  });
  it.each([
    [0, 1],
    [99, 1],
    [100, 2],
    [399, 2],
    [400, 3],
    [899, 3],
    [980099, 99],
    [980100, 100],
    [980101, 100],
    [MAX_PROFESSION_EXPERIENCE, 100],
  ])('maps %i XP to level %i', (xp, level) => {
    expect(Policy.levelFor(xp)).toBe(level);
  });
  it('matches the threshold definition for every XP boundary', () => {
    for (let level = 1; level <= MAX_PROFESSION_LEVEL; level++) {
      const at = Policy.threshold(level);
      expect(Policy.levelFor(at)).toBe(level);
      if (level < MAX_PROFESSION_LEVEL)
        expect(Policy.levelFor(Policy.threshold(level + 1) - 1)).toBe(level);
    }
  });
  it('caps the level at 100, keeps XP beyond it and saturates at the safe ceiling', () => {
    expect(Policy.nextLevelExperience(1)).toBe(100);
    expect(Policy.nextLevelExperience(99)).toBe(980100);
    expect(Policy.nextLevelExperience(100)).toBeNull();
    expect(Policy.add(980100, 5)).toBe(980105);
    expect(Policy.add(MAX_PROFESSION_EXPERIENCE - 1, 1_000_000)).toBe(
      MAX_PROFESSION_EXPERIENCE,
    );
    expect(Number.isSafeInteger(MAX_PROFESSION_EXPERIENCE * 2)).toBe(true);
  });
  it('rejects non-integer, negative or out-of-range inputs', () => {
    for (const xp of [-1, 1.5, Number.NaN, MAX_PROFESSION_EXPERIENCE + 1])
      expect(() => Policy.levelFor(xp)).toThrow(RangeError);
    for (const level of [0, 101, 2.5])
      expect(() => Policy.threshold(level)).toThrow(RangeError);
  });
});

describe('Professions boundaries', () => {
  it('exposes only the player profession controller, with no XP route or GameCommand', () => {
    expect(Reflect.getMetadata('controllers', ProfessionsModule)).toEqual([
      ProfessionController,
    ]);
    const files = globSync(
      fileURLToPath(new URL('./**/*.ts', import.meta.url)),
    ).filter((file) => !file.endsWith('.spec.ts'));
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      for (const module of imports)
        expect(module).not.toMatch(
          /game-command|actor-operations|game-gateway/,
        );
      expect(source).not.toMatch(
        /@(Post|Get|Put|Patch|Delete)\(['"][^'"]*(experience|xp|grant|agent)/i,
      );
      expect(source).not.toMatch(/\bLogger\b|console\./);
    }
  });
});
