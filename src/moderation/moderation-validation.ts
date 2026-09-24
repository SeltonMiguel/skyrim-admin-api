import { BadRequestException } from '@nestjs/common';
import { isUUID } from 'class-validator';

export const MAX_MODERATION_TEXT_LENGTH = 500;
export function moderationText(value: unknown): string {
  // Plain literal text: no markup interpretation, controls or malformed Unicode.
  // eslint-disable-next-line no-control-regex
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/u.test(value))
    throw new BadRequestException('Invalid moderation text');
  const text = value.trim();
  if (
    !text ||
    text.length > MAX_MODERATION_TEXT_LENGTH ||
    Buffer.from(text, 'utf8').toString('utf8') !== text
  )
    throw new BadRequestException('Invalid moderation text');
  return text;
}
export function enabledValue(value: unknown): boolean {
  if (typeof value !== 'boolean')
    throw new BadRequestException('Invalid enabled value');
  return value;
}
export function staffId(value: unknown): string {
  if (typeof value !== 'string' || !isUUID(value))
    throw new BadRequestException('Invalid actor staff UUID');
  return value;
}
