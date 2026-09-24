import { BadRequestException } from '@nestjs/common';
export const MAX_EXTERNAL_ID_LENGTH = 128;

export function externalId(value: unknown): string {
  // IDs must reject C0/C1 controls, including NUL unsupported by PostgreSQL JSONB.
  // eslint-disable-next-line no-control-regex
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/u.test(value))
    throw new BadRequestException('Invalid external identifier');
  const id = value.trim();
  if (
    !id ||
    id.length > MAX_EXTERNAL_ID_LENGTH ||
    Buffer.from(id, 'utf8').toString('utf8') !== id
  )
    throw new BadRequestException('Invalid external identifier');
  return id;
}
// Internal validation helper only. Public payloads/results are closed types.
export function fields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new BadRequestException('Invalid command data');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== 'string' ||
        ![...required, ...optional].includes(key) ||
        !descriptors[key]?.enumerable ||
        !('value' in descriptors[key]),
    ) ||
    required.some((key) => !Object.hasOwn(descriptors, key))
  )
    throw new BadRequestException('Invalid command fields');
  return value as Record<string, unknown>;
}
