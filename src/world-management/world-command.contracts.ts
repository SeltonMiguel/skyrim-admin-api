import { BadRequestException, ConflictException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { commandJson } from '../game-bridge/command-json.js';
import {
  MAX_COMMAND_PAYLOAD_BYTES,
  MAX_COMMAND_RESULT_BYTES,
} from '../game-bridge/command-limits.js';
import { externalId, fields } from '../game-bridge/command-validation.js';

export const MAX_SPAWN_QUANTITY = 10;
export interface WorldTime {
  gameHour: number;
}
export interface WorldWeather {
  weatherId: string;
}
export interface WorldSpawn {
  actorStaffId: string;
  baseFormId: string;
  quantity: number;
}
export interface WorldCommandMap {
  WORLD_STATE_QUERY: {
    payload: Record<string, never>;
    result: WorldTime & { weatherId: string | null };
  };
  WORLD_TIME_SET: { payload: WorldTime; result: WorldTime };
  WORLD_WEATHER_SET: { payload: WorldWeather; result: WorldWeather };
  WORLD_ENTITY_SPAWN: {
    payload: WorldSpawn;
    result: Omit<WorldSpawn, 'quantity'> & {
      requestedQuantity: number;
      spawnedQuantity: number;
    };
  };
}
export type WorldCommandType = keyof WorldCommandMap;
export type WorldPayload<T extends WorldCommandType = WorldCommandType> =
  WorldCommandMap[T]['payload'];
export type WorldResult<T extends WorldCommandType = WorldCommandType> =
  WorldCommandMap[T]['result'];
export function gameHour(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value >= 24
  )
    throw new BadRequestException('gameHour must be finite and in [0, 24)');
  return value;
}
export function spawnQuantity(
  value: unknown,
  minimum = 1,
  maximum = MAX_SPAWN_QUANTITY,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new BadRequestException('Invalid spawn quantity');
  return value;
}
const payloads: {
  [T in WorldCommandType]: (value: unknown) => WorldPayload<T>;
} = {
  WORLD_STATE_QUERY: (value) => {
    fields(value, []);
    return {};
  },
  WORLD_TIME_SET: (value) => ({
    gameHour: gameHour(fields(value, ['gameHour']).gameHour),
  }),
  WORLD_WEATHER_SET: (value) => ({
    weatherId: externalId(fields(value, ['weatherId']).weatherId),
  }),
  WORLD_ENTITY_SPAWN: (value) => {
    const data = fields(value, ['actorStaffId', 'baseFormId', 'quantity']);
    if (typeof data.actorStaffId !== 'string' || !isUUID(data.actorStaffId))
      throw new BadRequestException('Invalid actor staff UUID');
    return {
      actorStaffId: data.actorStaffId,
      baseFormId: externalId(data.baseFormId),
      quantity: spawnQuantity(data.quantity),
    };
  },
};
export const WORLD_COMMAND_TYPES = Object.keys(payloads) as WorldCommandType[];
export function isWorldCommand(type: string): type is WorldCommandType {
  return Object.hasOwn(payloads, type);
}
export function worldPayload<T extends WorldCommandType>(
  type: T,
  value: unknown,
): WorldPayload<T> {
  if (!isWorldCommand(type))
    throw new BadRequestException('Unsupported world command');
  return payloads[type](commandJson(value, MAX_COMMAND_PAYLOAD_BYTES));
}
const results: {
  [T in WorldCommandType]: (
    value: unknown,
    request: WorldPayload<T>,
  ) => WorldResult<T>;
} = {
  WORLD_STATE_QUERY: (value) => {
    const data = fields(value, ['gameHour', 'weatherId']);
    return {
      gameHour: gameHour(data.gameHour),
      weatherId: data.weatherId === null ? null : externalId(data.weatherId),
    };
  },
  WORLD_TIME_SET: (value, request) => {
    const result = payloads.WORLD_TIME_SET(value);
    if (result.gameHour !== request.gameHour)
      throw new ConflictException('World time result mismatch');
    return result;
  },
  WORLD_WEATHER_SET: (value, request) => {
    const result = payloads.WORLD_WEATHER_SET(value);
    if (result.weatherId !== request.weatherId)
      throw new ConflictException('World weather result mismatch');
    return result;
  },
  WORLD_ENTITY_SPAWN: (value, request) => {
    const data = fields(value, [
      'actorStaffId',
      'baseFormId',
      'requestedQuantity',
      'spawnedQuantity',
    ]);
    const baseFormId = externalId(data.baseFormId);
    if (
      data.actorStaffId !== request.actorStaffId ||
      baseFormId !== request.baseFormId ||
      data.requestedQuantity !== request.quantity
    )
      throw new ConflictException('World spawn result mismatch');
    return {
      actorStaffId: request.actorStaffId,
      baseFormId,
      requestedQuantity: request.quantity,
      spawnedQuantity: spawnQuantity(data.spawnedQuantity, 0, request.quantity),
    };
  },
};
export function worldResult<T extends WorldCommandType>(
  type: T,
  value: unknown,
  payload: unknown,
): WorldResult<T> {
  const request = worldPayload(type, payload);
  return results[type](commandJson(value, MAX_COMMAND_RESULT_BYTES), request);
}
