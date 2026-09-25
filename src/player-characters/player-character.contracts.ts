import { createHash, randomInt } from 'node:crypto';

export enum CharacterLinkStatus {
  PENDING = 'PENDING',
  VERIFIED = 'VERIFIED',
  REVOKED = 'REVOKED',
}
// Typed by the player inside the game: no 0/O, 1/I/L. 31 symbols × 13
// characters ≈ 64.4 bits, generated with rejection-free crypto.randomInt.
export const CHALLENGE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CHALLENGE_LENGTH = 13;
export function generateChallenge(): string {
  let value = '';
  for (let i = 0; i < CHALLENGE_LENGTH; i++)
    value += CHALLENGE_ALPHABET[randomInt(CHALLENGE_ALPHABET.length)];
  return `${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8)}`;
}
// Accepts the displayed grouping, spaces and lowercase; null when malformed.
export function normalizeChallenge(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const canonical = value.replace(/[\s-]/g, '').toUpperCase();
  return new RegExp(`^[${CHALLENGE_ALPHABET}]{${CHALLENGE_LENGTH}}$`).test(
    canonical,
  )
    ? canonical
    : null;
}
export function challengeHash(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex');
}

// Result of a trusted Agent confirmation (Etapa 11 maps it to its transport).
// Rejections change nothing and carry no owner identity.
export type OwnershipConfirmation =
  | { outcome: 'VERIFIED'; linkId: string; playerId: string }
  | { outcome: 'ALREADY_VERIFIED'; linkId: string; playerId: string }
  | {
      outcome: 'REJECTED';
      reason:
        | 'INVALID_CHALLENGE'
        | 'EXPIRED_CHALLENGE'
        | 'CHALLENGE_MISMATCH'
        | 'PLAYER_UNAVAILABLE'
        | 'SERVER_UNAVAILABLE'
        | 'CHARACTER_UNAVAILABLE';
    };
