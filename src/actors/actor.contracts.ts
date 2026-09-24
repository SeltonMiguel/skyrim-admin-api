import { isUUID } from 'class-validator';
import type { RoleName } from '../rbac/roles.js';

// Internal origin of an operation. Never parsed from HTTP input: STAFF comes
// from the authenticated staff session, PLAYER from the future player session
// (10.3) and SYSTEM from server-side code with a closed source.
export enum ActorType {
  STAFF = 'STAFF',
  PLAYER = 'PLAYER',
  SYSTEM = 'SYSTEM',
}
// Closed allowlist; each value is also enforced by database CHECK constraints.
export enum SystemSource {
  AGENT = 'AGENT',
  PROFESSION = 'PROFESSION',
  VIP_DELIVERY = 'VIP_DELIVERY',
}
export interface StaffActor {
  type: ActorType.STAFF;
  id: string;
  username: string;
  displayName: string;
  roleName: RoleName;
}
// No role, permission or provider data: authorization is ownership-based.
export interface PlayerActor {
  type: ActorType.PLAYER;
  playerId: string;
}
export interface SystemActor {
  type: ActorType.SYSTEM;
  source: SystemSource;
}
export type Actor = StaffActor | PlayerActor | SystemActor;

const invalid = (): never => {
  throw new TypeError('Invalid actor');
};
function closed(value: object, keys: readonly string[]): void {
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== 'string' || !keys.includes(key))
  )
    invalid();
}
// Validates and copies; the caller can no longer mutate the returned actor.
export function actor(value: unknown): Actor {
  if (!value || typeof value !== 'object') return invalid();
  const input = value as Record<string, unknown>;
  switch (input.type) {
    case ActorType.STAFF:
      closed(input, ['type', 'id', 'username', 'displayName', 'roleName']);
      return staffActor(input as unknown as Omit<StaffActor, 'type'>);
    case ActorType.PLAYER:
      closed(input, ['type', 'playerId']);
      return playerActor(input.playerId as string);
    case ActorType.SYSTEM:
      closed(input, ['type', 'source']);
      return systemActor(input.source as SystemSource);
    default:
      return invalid();
  }
}
export function staffActor(staff: {
  id: string;
  username: string;
  displayName: string;
  roleName: RoleName;
}): StaffActor {
  // Staff identity comes from the authenticated session; the uuid column and
  // FKs remain the storage guarantee, as before this refactor.
  if (typeof staff?.id !== 'string' || !staff.id) invalid();
  return {
    type: ActorType.STAFF,
    id: staff.id,
    username: staff.username,
    displayName: staff.displayName,
    roleName: staff.roleName,
  };
}
export function playerActor(playerId: string): PlayerActor {
  if (typeof playerId !== 'string' || !isUUID(playerId)) invalid();
  // Canonical lowercase, matching PostgreSQL uuid::text in the scope CHECK.
  return { type: ActorType.PLAYER, playerId: playerId.toLowerCase() };
}
export function systemActor(source: SystemSource): SystemActor {
  if (!Object.values(SystemSource).includes(source)) invalid();
  return { type: ActorType.SYSTEM, source };
}

// Persisted idempotency namespace. All staff share one scope (existing
// semantics); each player and each system source is isolated. Internal only.
export const STAFF_IDEMPOTENCY_SCOPE = 'STAFF';
export function idempotencyScope(value: Actor): string {
  switch (value.type) {
    case ActorType.STAFF:
      return STAFF_IDEMPOTENCY_SCOPE;
    case ActorType.PLAYER:
      return `PLAYER:${value.playerId}`;
    case ActorType.SYSTEM:
      return `SYSTEM:${value.source}`;
  }
}
