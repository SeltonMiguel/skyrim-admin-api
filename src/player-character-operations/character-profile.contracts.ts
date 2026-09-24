import { BadRequestException, ConflictException } from '@nestjs/common';
import { commandJson } from '../game-bridge/command-json.js';
import {
  MAX_COMMAND_PAYLOAD_BYTES,
  MAX_COMMAND_RESULT_BYTES,
} from '../game-bridge/command-limits.js';
import { externalId, fields } from '../game-bridge/command-validation.js';

// Read-only Skyrim queries requested by players (10.5). Skyrim stays the
// source of truth: results are validated and returned, never cached.
export const MAX_CHARACTER_LEVEL = 65535; // Skyrim stores level as uint16.
export const MAX_ATTRIBUTE_VALUE = 1_000_000;
export const MIN_SKILL_LEVEL = 0;
export const MAX_SKILL_LEVEL = 100;
export const CHARACTER_SEXES = ['MALE', 'FEMALE'] as const;
export type CharacterSex = (typeof CHARACTER_SEXES)[number];
export const SKILL_NAMES = [
  'alchemy',
  'alteration',
  'archery',
  'block',
  'conjuration',
  'destruction',
  'enchanting',
  'heavyArmor',
  'illusion',
  'lightArmor',
  'lockpicking',
  'oneHanded',
  'pickpocket',
  'restoration',
  'smithing',
  'sneak',
  'speech',
  'twoHanded',
] as const;
export type SkillName = (typeof SKILL_NAMES)[number];

export interface CharacterProfile {
  characterId: string;
  name: string;
  level: number;
  race: string;
  sex: CharacterSex;
  health: number;
  magicka: number;
  stamina: number;
}
export interface CharacterSkills {
  characterId: string;
  skills: Record<SkillName, number>;
}
export interface CharacterProfileCommandMap {
  CHARACTER_PROFILE_QUERY: {
    payload: { characterId: string };
    result: CharacterProfile;
  };
  CHARACTER_SKILLS_QUERY: {
    payload: { characterId: string };
    result: CharacterSkills;
  };
}
export type CharacterProfileCommandType = keyof CharacterProfileCommandMap;
export type CharacterProfileResult<
  T extends CharacterProfileCommandType = CharacterProfileCommandType,
> = CharacterProfileCommandMap[T]['result'];

function integer(value: unknown, min: number, max: number, name: string) {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new BadRequestException(`Invalid ${name}`);
  return value;
}
// Current actor value; may be fractional, never negative or unbounded.
function attribute(value: unknown, name: string) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_ATTRIBUTE_VALUE
  )
    throw new BadRequestException(`Invalid ${name}`);
  return value;
}
function queryPayload(value: unknown): { characterId: string } {
  const data = fields(value, ['characterId']);
  return { characterId: externalId(data.characterId) };
}
function profileResult(value: unknown): CharacterProfile {
  const data = fields(value, [
    'characterId',
    'name',
    'level',
    'race',
    'sex',
    'health',
    'magicka',
    'stamina',
  ]);
  if (!CHARACTER_SEXES.includes(data.sex as CharacterSex))
    throw new BadRequestException('Invalid sex');
  return {
    characterId: externalId(data.characterId),
    name: externalId(data.name),
    level: integer(data.level, 1, MAX_CHARACTER_LEVEL, 'level'),
    race: externalId(data.race),
    sex: data.sex as CharacterSex,
    health: attribute(data.health, 'health'),
    magicka: attribute(data.magicka, 'magicka'),
    stamina: attribute(data.stamina, 'stamina'),
  };
}
// All 18 skills are required; unknown skills are rejected.
function skillsResult(value: unknown): CharacterSkills {
  const data = fields(value, ['characterId', 'skills']);
  const levels = fields(data.skills, SKILL_NAMES);
  const skills = {} as Record<SkillName, number>;
  for (const skill of SKILL_NAMES)
    skills[skill] = integer(
      levels[skill],
      MIN_SKILL_LEVEL,
      MAX_SKILL_LEVEL,
      'skill level',
    );
  return { characterId: externalId(data.characterId), skills };
}
const contracts: {
  [T in CharacterProfileCommandType]: (
    value: unknown,
  ) => CharacterProfileResult<T>;
} = {
  CHARACTER_PROFILE_QUERY: profileResult,
  CHARACTER_SKILLS_QUERY: skillsResult,
};
export const CHARACTER_PROFILE_COMMAND_TYPES = Object.keys(
  contracts,
) as CharacterProfileCommandType[];
export function isCharacterProfileCommand(
  type: string,
): type is CharacterProfileCommandType {
  return Object.hasOwn(contracts, type);
}
export function characterProfilePayload(
  type: CharacterProfileCommandType,
  value: unknown,
): { characterId: string } {
  if (!isCharacterProfileCommand(type))
    throw new BadRequestException('Unsupported character profile command');
  return queryPayload(commandJson(value, MAX_COMMAND_PAYLOAD_BYTES));
}
export function characterProfileResult<T extends CharacterProfileCommandType>(
  type: T,
  value: unknown,
  payload: unknown,
): CharacterProfileResult<T> {
  const request = characterProfilePayload(type, payload);
  const result = contracts[type](commandJson(value, MAX_COMMAND_RESULT_BYTES));
  if (request.characterId !== result.characterId)
    throw new ConflictException('Result character mismatch');
  return result as CharacterProfileResult<T>;
}
