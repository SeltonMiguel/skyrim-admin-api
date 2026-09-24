import type { CommandType } from '../game-bridge/command-contract.js';

// Closed allowlist of read-only Skyrim queries a player may request for an
// owned character. Every entry reuses an existing contract unchanged:
// profile/skills (10.5) and the Etapa 05 Character Management queries for
// properties (houses) and holds (10.10). Mutations are never listed here.
export const PLAYER_CHARACTER_QUERY_TYPES = [
  'CHARACTER_PROFILE_QUERY',
  'CHARACTER_SKILLS_QUERY',
  'CHARACTER_PROPERTIES_QUERY',
  'CHARACTER_HOLDS_QUERY',
] as const satisfies readonly CommandType[];
export type PlayerCharacterQueryType =
  (typeof PLAYER_CHARACTER_QUERY_TYPES)[number];
export function isPlayerCharacterQuery(
  type: string,
): type is PlayerCharacterQueryType {
  return (PLAYER_CHARACTER_QUERY_TYPES as readonly string[]).includes(type);
}
