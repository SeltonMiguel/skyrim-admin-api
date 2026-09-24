import { BadRequestException } from '@nestjs/common';
import { externalId } from '../game-bridge/command-validation.js';

export enum PlayerStatus {
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  BANNED = 'BANNED',
}
// Extending providers requires a migration for the CHECK constraint.
export enum IdentityProvider {
  DISCORD = 'DISCORD',
  STEAM = 'STEAM',
}
export const MAX_PLAYER_DISPLAY_NAME_LENGTH = 64;

export function playerDisplayName(value: unknown): string {
  // eslint-disable-next-line no-control-regex
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/u.test(value))
    throw new BadRequestException('Invalid display name');
  const name = value.trim();
  if (
    !name ||
    name.length > MAX_PLAYER_DISPLAY_NAME_LENGTH ||
    Buffer.from(name, 'utf8').toString('utf8') !== name
  )
    throw new BadRequestException('Invalid display name');
  return name;
}
export function identityProvider(value: unknown): IdentityProvider {
  if (!Object.values(IdentityProvider).includes(value as IdentityProvider))
    throw new BadRequestException('Invalid identity provider');
  return value as IdentityProvider;
}
// Opaque: trimmed and bounded, never parsed. Errors never echo the value.
export function providerSubject(value: unknown): string {
  try {
    return externalId(value);
  } catch {
    throw new BadRequestException('Invalid provider subject');
  }
}
