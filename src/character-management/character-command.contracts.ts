import { BadRequestException, ConflictException } from '@nestjs/common';
import { commandJson } from '../game-bridge/command-json.js';
import {
  MAX_COMMAND_PAYLOAD_BYTES,
  MAX_COMMAND_RESULT_BYTES,
} from '../game-bridge/command-limits.js';
import {
  externalId,
  fields,
  quantity,
  MAX_CHARACTER_RESULT_ENTRIES,
} from './character-validation.js';

export interface CharacterQueryPayload {
  characterId: string;
}
export interface ItemPayload extends CharacterQueryPayload {
  itemId: string;
  quantity: number;
}
export type TargetPayload<K extends string> = CharacterQueryPayload & {
  [P in K]: string;
};
export type NamedEntry<K extends string> = { [P in K]: string } & {
  displayName?: string;
};
export interface InventoryResult {
  characterId: string;
  items: (NamedEntry<'itemId'> & { quantity: number })[];
}
export interface PropertiesResult {
  characterId: string;
  properties: NamedEntry<'propertyId'>[];
}
export interface HoldsResult {
  characterId: string;
  holds: NamedEntry<'holdId'>[];
}
export interface HorsesResult {
  characterId: string;
  horses: NamedEntry<'horseId'>[];
}
export interface FactionsResult {
  characterId: string;
  factions: NamedEntry<'factionId'>[];
}
export interface CharacterMutationResult {
  characterId: string;
  applied: true;
  targetId: string;
}

function queryPayload(value: unknown): CharacterQueryPayload {
  const data = fields(value, ['characterId']);
  return { characterId: externalId(data.characterId) };
}
function itemPayload(value: unknown): ItemPayload {
  const data = fields(value, ['characterId', 'itemId', 'quantity']);
  return {
    characterId: externalId(data.characterId),
    itemId: externalId(data.itemId),
    quantity: quantity(data.quantity),
  };
}
function targetPayload<K extends string>(key: K) {
  return (value: unknown): TargetPayload<K> => {
    const data = fields(value, ['characterId', key]);
    return {
      characterId: externalId(data.characterId),
      [key]: externalId(data[key]),
    } as TargetPayload<K>;
  };
}
function named<K extends string>(value: unknown, key: K): NamedEntry<K> {
  const data = fields(value, [key], ['displayName']);
  return {
    [key]: externalId(data[key]),
    ...(data.displayName === undefined
      ? {}
      : { displayName: externalId(data.displayName) }),
  } as NamedEntry<K>;
}
function listResult<K extends string, T>(key: K, parse: (item: unknown) => T) {
  return (value: unknown): CharacterQueryPayload & { [P in K]: T[] } => {
    const data = fields(value, ['characterId', key]);
    const entries = data[key];
    if (
      !Array.isArray(entries) ||
      entries.length > MAX_CHARACTER_RESULT_ENTRIES
    )
      throw new BadRequestException('Invalid result collection');
    return {
      characterId: externalId(data.characterId),
      [key]: entries.map(parse),
    } as CharacterQueryPayload & { [P in K]: T[] };
  };
}
const inventoryResult = listResult('items', (value) => {
  const data = fields(value, ['itemId', 'quantity'], ['displayName']);
  return {
    itemId: externalId(data.itemId),
    quantity: quantity(data.quantity),
    ...(data.displayName === undefined
      ? {}
      : { displayName: externalId(data.displayName) }),
  };
});
function mutationResult(value: unknown): CharacterMutationResult {
  const data = fields(value, ['characterId', 'applied', 'targetId']);
  if (data.applied !== true)
    throw new BadRequestException('Invalid mutation result');
  return {
    characterId: externalId(data.characterId),
    applied: true,
    targetId: externalId(data.targetId),
  };
}

export interface CharacterCommandMap {
  CHARACTER_INVENTORY_QUERY: {
    payload: CharacterQueryPayload;
    result: InventoryResult;
  };
  CHARACTER_INVENTORY_REMOVE_ITEM: {
    payload: ItemPayload;
    result: CharacterMutationResult;
  };
  CHARACTER_ITEM_GIVE: {
    payload: ItemPayload;
    result: CharacterMutationResult;
  };
  CHARACTER_PROPERTIES_QUERY: {
    payload: CharacterQueryPayload;
    result: PropertiesResult;
  };
  CHARACTER_PROPERTY_GRANT: {
    payload: TargetPayload<'propertyId'>;
    result: CharacterMutationResult;
  };
  CHARACTER_PROPERTY_REVOKE: {
    payload: TargetPayload<'propertyId'>;
    result: CharacterMutationResult;
  };
  CHARACTER_HOLDS_QUERY: {
    payload: CharacterQueryPayload;
    result: HoldsResult;
  };
  CHARACTER_HOLD_GRANT: {
    payload: TargetPayload<'holdId'>;
    result: CharacterMutationResult;
  };
  CHARACTER_HOLD_REVOKE: {
    payload: TargetPayload<'holdId'>;
    result: CharacterMutationResult;
  };
  CHARACTER_HORSES_QUERY: {
    payload: CharacterQueryPayload;
    result: HorsesResult;
  };
  CHARACTER_HORSE_GIVE: {
    payload: TargetPayload<'horseId'>;
    result: CharacterMutationResult;
  };
  CHARACTER_HORSE_REVOKE: {
    payload: TargetPayload<'horseId'>;
    result: CharacterMutationResult;
  };
  CHARACTER_TITLE_GIVE: {
    payload: TargetPayload<'titleId'>;
    result: CharacterMutationResult;
  };
  CHARACTER_SPELL_GIVE: {
    payload: TargetPayload<'spellId'>;
    result: CharacterMutationResult;
  };
  CHARACTER_FACTIONS_QUERY: {
    payload: CharacterQueryPayload;
    result: FactionsResult;
  };
  CHARACTER_FACTION_ADD: {
    payload: TargetPayload<'factionId'>;
    result: CharacterMutationResult;
  };
  CHARACTER_FACTION_REMOVE: {
    payload: TargetPayload<'factionId'>;
    result: CharacterMutationResult;
  };
}
export type CharacterCommandType = keyof CharacterCommandMap;
export type CharacterPayload<
  T extends CharacterCommandType = CharacterCommandType,
> = CharacterCommandMap[T]['payload'];
export type CharacterResult<
  T extends CharacterCommandType = CharacterCommandType,
> = CharacterCommandMap[T]['result'];

const contracts: {
  [T in CharacterCommandType]: {
    payload: (value: unknown) => CharacterPayload<T>;
    result: (value: unknown) => CharacterResult<T>;
  };
} = {
  CHARACTER_INVENTORY_QUERY: { payload: queryPayload, result: inventoryResult },
  CHARACTER_INVENTORY_REMOVE_ITEM: {
    payload: itemPayload,
    result: mutationResult,
  },
  CHARACTER_ITEM_GIVE: { payload: itemPayload, result: mutationResult },
  CHARACTER_PROPERTIES_QUERY: {
    payload: queryPayload,
    result: listResult('properties', (value) => named(value, 'propertyId')),
  },
  CHARACTER_PROPERTY_GRANT: {
    payload: targetPayload('propertyId'),
    result: mutationResult,
  },
  CHARACTER_PROPERTY_REVOKE: {
    payload: targetPayload('propertyId'),
    result: mutationResult,
  },
  CHARACTER_HOLDS_QUERY: {
    payload: queryPayload,
    result: listResult('holds', (value) => named(value, 'holdId')),
  },
  CHARACTER_HOLD_GRANT: {
    payload: targetPayload('holdId'),
    result: mutationResult,
  },
  CHARACTER_HOLD_REVOKE: {
    payload: targetPayload('holdId'),
    result: mutationResult,
  },
  CHARACTER_HORSES_QUERY: {
    payload: queryPayload,
    result: listResult('horses', (value) => named(value, 'horseId')),
  },
  CHARACTER_HORSE_GIVE: {
    payload: targetPayload('horseId'),
    result: mutationResult,
  },
  CHARACTER_HORSE_REVOKE: {
    payload: targetPayload('horseId'),
    result: mutationResult,
  },
  CHARACTER_TITLE_GIVE: {
    payload: targetPayload('titleId'),
    result: mutationResult,
  },
  CHARACTER_SPELL_GIVE: {
    payload: targetPayload('spellId'),
    result: mutationResult,
  },
  CHARACTER_FACTIONS_QUERY: {
    payload: queryPayload,
    result: listResult('factions', (value) => named(value, 'factionId')),
  },
  CHARACTER_FACTION_ADD: {
    payload: targetPayload('factionId'),
    result: mutationResult,
  },
  CHARACTER_FACTION_REMOVE: {
    payload: targetPayload('factionId'),
    result: mutationResult,
  },
};
export const CHARACTER_COMMAND_TYPES = Object.keys(
  contracts,
) as CharacterCommandType[];
export function isCharacterCommand(type: string): type is CharacterCommandType {
  return Object.hasOwn(contracts, type);
}
export function characterPayload<T extends CharacterCommandType>(
  type: T,
  value: unknown,
): CharacterPayload<T> {
  if (!isCharacterCommand(type))
    throw new BadRequestException('Unsupported character command');
  return contracts[type].payload(commandJson(value, MAX_COMMAND_PAYLOAD_BYTES));
}
export function characterResult<T extends CharacterCommandType>(
  type: T,
  value: unknown,
  payload: unknown,
): CharacterResult<T> {
  const request = characterPayload(type, payload);
  const result = contracts[type].result(
    commandJson(value, MAX_COMMAND_RESULT_BYTES),
  );
  if (request.characterId !== result.characterId)
    throw new ConflictException('Result character mismatch');
  if ('targetId' in result) {
    const key = [
      'itemId',
      'propertyId',
      'holdId',
      'horseId',
      'titleId',
      'spellId',
      'factionId',
    ].find((key) => Object.hasOwn(request, key));
    if (
      !key ||
      (request as unknown as Record<string, unknown>)[key] !== result.targetId
    )
      throw new ConflictException('Result target mismatch');
  }
  return result;
}
