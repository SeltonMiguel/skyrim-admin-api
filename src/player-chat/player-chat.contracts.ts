import { BadRequestException } from '@nestjs/common';

// Player Chat (10.15): persistent, plain-text, short-retention messages.
// HTTP is the source of truth for history; realtime only delivers new ones.
export enum ChatChannel {
  GLOBAL = 'GLOBAL',
  GROUP = 'GROUP',
  GUILD = 'GUILD',
  DIRECT = 'DIRECT',
}
// Also PostgreSQL CHECKs (char_length counts code points).
export const MAX_CHAT_MESSAGE_LENGTH = 500;
export const CHAT_PAGE_DEFAULT_LIMIT = 50;

// C0/C1 controls (newlines and tabs included: messages are one line),
// bidirectional embedding/override/isolate controls (spoofing) and the BOM.
// With the u flag a surrogate range only matches lone (ill-formed) halves.
const FORBIDDEN = new RegExp(
  // eslint-disable-next-line no-control-regex
  '[\\u0000-\\u001f\\u007f-\\u009f\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff\\ud800-\\udfff]',
  'u',
);

// Plain text only: trimmed, 1..500 code points, well-formed Unicode. HTML
// or Markdown is never interpreted or rendered; clients must escape it.
export function chatMessage(value: unknown): string {
  if (typeof value !== 'string')
    throw new BadRequestException('Invalid message');
  const message = value.trim();
  const length = [...message].length;
  if (!length || length > MAX_CHAT_MESSAGE_LENGTH || FORBIDDEN.test(message))
    throw new BadRequestException('Invalid message');
  return message;
}
