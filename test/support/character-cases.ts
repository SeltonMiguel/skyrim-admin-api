import type {
  CharacterCommandType,
  CharacterPayload,
  CharacterResult,
} from '../../src/character-management/character-command.contracts.js';
import { Permission as P } from '../../src/rbac/permissions.js';
import { AuditAction as A } from '../../src/audit/audit.types.js';
export type CharacterCase = {
  [T in CharacterCommandType]: {
    type: T;
    path: string;
    permission: P;
    action: A | null;
    body: Omit<CharacterPayload<T>, 'characterId'>;
    payload: CharacterPayload<T>;
    result: CharacterResult<T>;
  };
}[CharacterCommandType];
export const CHARACTER_CASES = [
  {
    type: 'CHARACTER_INVENTORY_QUERY',
    path: 'inventory/query',
    permission: P.CHARACTER_INVENTORY_READ,
    action: null,
    body: {},
    payload: { characterId: 'opaque:character-42' },
    result: {
      characterId: 'opaque:character-42',
      items: [
        { itemId: 'opaque:target-1', displayName: 'Example', quantity: 2 },
      ],
    },
  },
  {
    type: 'CHARACTER_INVENTORY_REMOVE_ITEM',
    path: 'inventory/items/remove',
    permission: P.CHARACTER_INVENTORY_WRITE,
    action: A.CHARACTER_INVENTORY_ITEM_REMOVE_REQUESTED,
    body: { itemId: 'opaque:target-1', quantity: 2 },
    payload: {
      characterId: 'opaque:character-42',
      itemId: 'opaque:target-1',
      quantity: 2,
    },
    result: {
      characterId: 'opaque:character-42',
      applied: true,
      targetId: 'opaque:target-1',
    },
  },
  {
    type: 'CHARACTER_ITEM_GIVE',
    path: 'inventory/items/give',
    permission: P.CHARACTER_ITEM_GIVE,
    action: A.CHARACTER_ITEM_GIVE_REQUESTED,
    body: { itemId: 'opaque:target-1', quantity: 2 },
    payload: {
      characterId: 'opaque:character-42',
      itemId: 'opaque:target-1',
      quantity: 2,
    },
    result: {
      characterId: 'opaque:character-42',
      applied: true,
      targetId: 'opaque:target-1',
    },
  },
  {
    type: 'CHARACTER_PROPERTIES_QUERY',
    path: 'properties/query',
    permission: P.CHARACTER_PROPERTY_READ,
    action: null,
    body: {},
    payload: { characterId: 'opaque:character-42' },
    result: {
      characterId: 'opaque:character-42',
      properties: [{ propertyId: 'opaque:target-1', displayName: 'Example' }],
    },
  },
  {
    type: 'CHARACTER_PROPERTY_GRANT',
    path: 'properties/grant',
    permission: P.CHARACTER_PROPERTY_WRITE,
    action: A.CHARACTER_PROPERTY_GRANT_REQUESTED,
    body: { propertyId: 'opaque:target-1' },
    payload: {
      characterId: 'opaque:character-42',
      propertyId: 'opaque:target-1',
    },
    result: {
      characterId: 'opaque:character-42',
      applied: true,
      targetId: 'opaque:target-1',
    },
  },
  {
    type: 'CHARACTER_PROPERTY_REVOKE',
    path: 'properties/revoke',
    permission: P.CHARACTER_PROPERTY_WRITE,
    action: A.CHARACTER_PROPERTY_REVOKE_REQUESTED,
    body: { propertyId: 'opaque:target-1' },
    payload: {
      characterId: 'opaque:character-42',
      propertyId: 'opaque:target-1',
    },
    result: {
      characterId: 'opaque:character-42',
      applied: true,
      targetId: 'opaque:target-1',
    },
  },
  {
    type: 'CHARACTER_HOLDS_QUERY',
    path: 'holds/query',
    permission: P.CHARACTER_HOLD_READ,
    action: null,
    body: {},
    payload: { characterId: 'opaque:character-42' },
    result: {
      characterId: 'opaque:character-42',
      holds: [{ holdId: 'opaque:target-1', displayName: 'Example' }],
    },
  },
  {
    type: 'CHARACTER_HOLD_GRANT',
    path: 'holds/grant',
    permission: P.CHARACTER_HOLD_WRITE,
    action: A.CHARACTER_HOLD_GRANT_REQUESTED,
    body: { holdId: 'opaque:target-1' },
    payload: { characterId: 'opaque:character-42', holdId: 'opaque:target-1' },
    result: {
      characterId: 'opaque:character-42',
      applied: true,
      targetId: 'opaque:target-1',
    },
  },
  {
    type: 'CHARACTER_HOLD_REVOKE',
    path: 'holds/revoke',
    permission: P.CHARACTER_HOLD_WRITE,
    action: A.CHARACTER_HOLD_REVOKE_REQUESTED,
    body: { holdId: 'opaque:target-1' },
    payload: { characterId: 'opaque:character-42', holdId: 'opaque:target-1' },
    result: {
      characterId: 'opaque:character-42',
      applied: true,
      targetId: 'opaque:target-1',
    },
  },
  {
    type: 'CHARACTER_HORSES_QUERY',
    path: 'horses/query',
    permission: P.CHARACTER_HORSE_READ,
    action: null,
    body: {},
    payload: { characterId: 'opaque:character-42' },
    result: {
      characterId: 'opaque:character-42',
      horses: [{ horseId: 'opaque:target-1', displayName: 'Example' }],
    },
  },
  {
    type: 'CHARACTER_HORSE_GIVE',
    path: 'horses/give',
    permission: P.CHARACTER_HORSE_GIVE,
    action: A.CHARACTER_HORSE_GIVE_REQUESTED,
    body: { horseId: 'opaque:target-1' },
    payload: { characterId: 'opaque:character-42', horseId: 'opaque:target-1' },
    result: {
      characterId: 'opaque:character-42',
      applied: true,
      targetId: 'opaque:target-1',
    },
  },
  {
    type: 'CHARACTER_HORSE_REVOKE',
    path: 'horses/revoke',
    permission: P.CHARACTER_HORSE_WRITE,
    action: A.CHARACTER_HORSE_REVOKE_REQUESTED,
    body: { horseId: 'opaque:target-1' },
    payload: { characterId: 'opaque:character-42', horseId: 'opaque:target-1' },
    result: {
      characterId: 'opaque:character-42',
      applied: true,
      targetId: 'opaque:target-1',
    },
  },
  {
    type: 'CHARACTER_TITLE_GIVE',
    path: 'titles/give',
    permission: P.CHARACTER_TITLE_GIVE,
    action: A.CHARACTER_TITLE_GIVE_REQUESTED,
    body: { titleId: 'opaque:target-1' },
    payload: { characterId: 'opaque:character-42', titleId: 'opaque:target-1' },
    result: {
      characterId: 'opaque:character-42',
      applied: true,
      targetId: 'opaque:target-1',
    },
  },
  {
    type: 'CHARACTER_SPELL_GIVE',
    path: 'spells/give',
    permission: P.CHARACTER_SPELL_GIVE,
    action: A.CHARACTER_SPELL_GIVE_REQUESTED,
    body: { spellId: 'opaque:target-1' },
    payload: { characterId: 'opaque:character-42', spellId: 'opaque:target-1' },
    result: {
      characterId: 'opaque:character-42',
      applied: true,
      targetId: 'opaque:target-1',
    },
  },
  {
    type: 'CHARACTER_FACTIONS_QUERY',
    path: 'factions/query',
    permission: P.FACTION_READ,
    action: null,
    body: {},
    payload: { characterId: 'opaque:character-42' },
    result: {
      characterId: 'opaque:character-42',
      factions: [{ factionId: 'opaque:target-1', displayName: 'Example' }],
    },
  },
  {
    type: 'CHARACTER_FACTION_ADD',
    path: 'factions/add',
    permission: P.FACTION_WRITE,
    action: A.CHARACTER_FACTION_ADD_REQUESTED,
    body: { factionId: 'opaque:target-1' },
    payload: {
      characterId: 'opaque:character-42',
      factionId: 'opaque:target-1',
    },
    result: {
      characterId: 'opaque:character-42',
      applied: true,
      targetId: 'opaque:target-1',
    },
  },
  {
    type: 'CHARACTER_FACTION_REMOVE',
    path: 'factions/remove',
    permission: P.FACTION_WRITE,
    action: A.CHARACTER_FACTION_REMOVE_REQUESTED,
    body: { factionId: 'opaque:target-1' },
    payload: {
      characterId: 'opaque:character-42',
      factionId: 'opaque:target-1',
    },
    result: {
      characterId: 'opaque:character-42',
      applied: true,
      targetId: 'opaque:target-1',
    },
  },
] satisfies readonly CharacterCase[];
