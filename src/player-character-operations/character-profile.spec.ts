import {
  COMMAND_TYPES,
  commandPayload,
  commandResult,
} from '../game-bridge/command-contract.js';
import { CHARACTER_COMMAND_TYPES } from '../character-management/character-command.contracts.js';
import {
  CHARACTER_PROFILE_COMMAND_TYPES,
  SKILL_NAMES,
} from './character-profile.contracts.js';

const payload = { characterId: 'char-1' };
const profile = {
  characterId: 'char-1',
  name: 'Lydia',
  level: 42,
  race: 'NordRace',
  sex: 'FEMALE',
  health: 312.5,
  magicka: 100,
  stamina: 0,
};
const skills = {
  characterId: 'char-1',
  skills: Object.fromEntries(SKILL_NAMES.map((name, i) => [name, i * 5])),
};
const profileResult = (value: unknown) =>
  commandResult('CHARACTER_PROFILE_QUERY', value, payload);
const skillsResult = (value: unknown) =>
  commandResult('CHARACTER_SKILLS_QUERY', value, payload);

describe('Character profile and skills contracts', () => {
  it('registers two read-only query types outside staff Character Management', () => {
    expect(CHARACTER_PROFILE_COMMAND_TYPES).toEqual([
      'CHARACTER_PROFILE_QUERY',
      'CHARACTER_SKILLS_QUERY',
    ]);
    for (const type of CHARACTER_PROFILE_COMMAND_TYPES) {
      expect(COMMAND_TYPES).toContain(type);
      expect(CHARACTER_COMMAND_TYPES).not.toContain(type);
      expect(commandPayload(type, { characterId: ' char-1 ' })).toEqual(
        payload,
      );
      for (const invalid of [
        {},
        { characterId: '' },
        { ...payload, playerId: 'x' },
        { ...payload, skill: 'x' },
      ])
        expect(() => commandPayload(type, invalid)).toThrow();
    }
    expect(SKILL_NAMES).toHaveLength(18);
  });
  it('accepts a strict profile and normalizes opaque strings', () => {
    expect(profileResult(profile)).toEqual(profile);
    expect(
      profileResult({ ...profile, name: ' Lydia ', level: 65535 }),
    ).toEqual({
      ...profile,
      level: 65535,
    });
    expect(
      profileResult({ ...profile, sex: 'MALE', health: 1_000_000 }).sex,
    ).toBe('MALE');
  });
  it.each([
    ['extra field', { ...profile, gold: 1 }],
    ['missing field', { ...profile, stamina: undefined }],
    ['level zero', { ...profile, level: 0 }],
    ['fractional level', { ...profile, level: 1.5 }],
    ['level overflow', { ...profile, level: 65536 }],
    ['string level', { ...profile, level: '42' }],
    ['negative health', { ...profile, health: -1 }],
    ['huge magicka', { ...profile, magicka: 1_000_001 }],
    ['unknown sex', { ...profile, sex: 'OTHER' }],
    ['empty name', { ...profile, name: ' ' }],
    ['control characters', { ...profile, race: 'Nord\u0000' }],
    ['array', [profile]],
    ['null', null],
  ])('rejects a profile with %s', (_name, value) => {
    expect(() => profileResult(value)).toThrow();
  });
  it('rejects a profile or skills result for another character', () => {
    expect(() => profileResult({ ...profile, characterId: 'char-2' })).toThrow(
      'Result character mismatch',
    );
    expect(() => skillsResult({ ...skills, characterId: 'char-2' })).toThrow(
      'Result character mismatch',
    );
  });
  it('accepts all 18 skills as integers from 0 to 100', () => {
    expect(skillsResult(skills)).toEqual(skills);
    const max = Object.fromEntries(SKILL_NAMES.map((name) => [name, 100]));
    expect(skillsResult({ ...skills, skills: max }).skills).toEqual(max);
  });
  it.each([
    ['missing skill', (s: Record<string, unknown>) => delete s.sneak],
    ['unknown skill', (s: Record<string, unknown>) => (s.necromancy = 50)],
    ['above 100', (s: Record<string, unknown>) => (s.smithing = 101)],
    ['negative', (s: Record<string, unknown>) => (s.block = -1)],
    ['fractional', (s: Record<string, unknown>) => (s.speech = 15.5)],
    ['string', (s: Record<string, unknown>) => (s.archery = '50')],
    ['null', (s: Record<string, unknown>) => (s.illusion = null)],
  ])('rejects skills with %s', (_name, mutate) => {
    const levels: Record<string, unknown> = { ...skills.skills };
    mutate(levels);
    expect(() => skillsResult({ ...skills, skills: levels })).toThrow();
  });
  it('rejects extra top-level fields and oversized results', () => {
    expect(() => skillsResult({ ...skills, perks: [] })).toThrow();
    expect(() => skillsResult({ characterId: 'char-1', skills: [] })).toThrow();
    expect(() =>
      profileResult({ ...profile, name: 'x'.repeat(70000) }),
    ).toThrow();
  });
});
