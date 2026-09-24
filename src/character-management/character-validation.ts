import { BadRequestException } from '@nestjs/common';
export {
  externalId,
  fields,
  MAX_EXTERNAL_ID_LENGTH,
} from '../game-bridge/command-validation.js';
export const MAX_CHARACTER_QUANTITY = 10000;
export const MAX_CHARACTER_RESULT_ENTRIES = 512;

export function quantity(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_CHARACTER_QUANTITY
  )
    throw new BadRequestException('Invalid quantity');
  return value;
}
