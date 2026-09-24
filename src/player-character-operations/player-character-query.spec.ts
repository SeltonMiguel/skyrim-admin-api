import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  COMMAND_TYPES,
  commandPayload,
  commandResult,
} from '../game-bridge/command-contract.js';
import { CHARACTER_COMMAND_TYPES } from '../character-management/character-command.contracts.js';
import { CHARACTER_POLICY } from '../character-management/character-policy.js';
import {
  PLAYER_CHARACTER_QUERY_TYPES,
  isPlayerCharacterQuery,
} from './player-character-query.contracts.js';

const payload = { characterId: 'char-1' };
const properties = {
  characterId: 'char-1',
  properties: [
    { propertyId: 'BreezehomeLocation', displayName: 'Breezehome' },
    { propertyId: 'HoneysideLocation' },
  ],
};
const holds = {
  characterId: 'char-1',
  holds: [{ holdId: 'Whiterun', displayName: 'Whiterun Hold' }],
};

describe('Player character query allowlist', () => {
  it('lists only existing read-only query types', () => {
    expect(PLAYER_CHARACTER_QUERY_TYPES).toEqual([
      'CHARACTER_PROFILE_QUERY',
      'CHARACTER_SKILLS_QUERY',
      'CHARACTER_PROPERTIES_QUERY',
      'CHARACTER_HOLDS_QUERY',
    ]);
    for (const type of PLAYER_CHARACTER_QUERY_TYPES) {
      expect(COMMAND_TYPES).toContain(type);
      expect(type).toMatch(/_QUERY$/);
    }
    // Etapa 05 queries are reused as they are: read permission, no Audit.
    for (const type of [
      'CHARACTER_PROPERTIES_QUERY',
      'CHARACTER_HOLDS_QUERY',
    ] as const) {
      expect(CHARACTER_COMMAND_TYPES).toContain(type);
      expect(CHARACTER_POLICY[type].auditAction).toBeNull();
    }
  });
  it('never allows property or hold mutations (or any other mutation)', () => {
    for (const type of [
      'CHARACTER_PROPERTY_GRANT',
      'CHARACTER_PROPERTY_REVOKE',
      'CHARACTER_HOLD_GRANT',
      'CHARACTER_HOLD_REVOKE',
    ])
      expect(isPlayerCharacterQuery(type)).toBe(false);
    for (const type of COMMAND_TYPES.filter((t) => !t.endsWith('_QUERY')))
      expect(isPlayerCharacterQuery(type)).toBe(false);
  });
  it('keeps the player module free of property/hold mutation types', () => {
    const sources = globSync(
      fileURLToPath(new URL('./**/*.ts', import.meta.url)),
    )
      .filter((file) => !file.endsWith('.spec.ts'))
      .map((file) => readFileSync(file, 'utf8'));
    for (const source of sources)
      expect(source).not.toMatch(
        /CHARACTER_(PROPERTY|HOLD)_(GRANT|REVOKE)|RequirePermissions|AdministrativeCommandService/,
      );
  });
});

describe('Properties and holds contracts reused by players', () => {
  it('builds the payload from the character only', () => {
    for (const type of [
      'CHARACTER_PROPERTIES_QUERY',
      'CHARACTER_HOLDS_QUERY',
    ] as const) {
      expect(commandPayload(type, { characterId: ' char-1 ' })).toEqual(
        payload,
      );
      expect(() =>
        commandPayload(type, { characterId: 'char-1', propertyId: 'x' }),
      ).toThrow();
      expect(() => commandPayload(type, {})).toThrow();
    }
  });
  it('validates results and rejects a character mismatch', () => {
    expect(
      commandResult('CHARACTER_PROPERTIES_QUERY', properties, payload),
    ).toEqual(properties);
    expect(commandResult('CHARACTER_HOLDS_QUERY', holds, payload)).toEqual(
      holds,
    );
    expect(() =>
      commandResult(
        'CHARACTER_PROPERTIES_QUERY',
        { ...properties, characterId: 'char-2' },
        payload,
      ),
    ).toThrow('Result character mismatch');
    expect(() =>
      commandResult(
        'CHARACTER_HOLDS_QUERY',
        { ...holds, characterId: 'char-2' },
        payload,
      ),
    ).toThrow('Result character mismatch');
    for (const invalid of [
      { ...properties, owner: 'x' },
      { characterId: 'char-1', properties: [{ propertyId: '' }] },
      { characterId: 'char-1', properties: [{ propertyId: 'a', price: 1 }] },
      {
        characterId: 'char-1',
        properties: Array.from({ length: 513 }, (_, i) => ({
          propertyId: `p${i}`,
        })),
      },
      { characterId: 'char-1', properties: {} },
    ])
      expect(() =>
        commandResult('CHARACTER_PROPERTIES_QUERY', invalid, payload),
      ).toThrow();
    expect(() =>
      commandResult('CHARACTER_HOLDS_QUERY', properties, payload),
    ).toThrow();
  });
});
