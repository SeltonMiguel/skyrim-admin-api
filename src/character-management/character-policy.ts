import { Permission as P } from '../rbac/permissions.js';
import { AuditAction as A } from '../audit/audit.types.js';
import type { CharacterCommandType } from './character-command.contracts.js';

export const CHARACTER_POLICY: Readonly<
  Record<CharacterCommandType, { permission: P; auditAction: A | null }>
> = {
  CHARACTER_INVENTORY_QUERY: {
    permission: P.CHARACTER_INVENTORY_READ,
    auditAction: null,
  },
  CHARACTER_INVENTORY_REMOVE_ITEM: {
    permission: P.CHARACTER_INVENTORY_WRITE,
    auditAction: A.CHARACTER_INVENTORY_ITEM_REMOVE_REQUESTED,
  },
  CHARACTER_ITEM_GIVE: {
    permission: P.CHARACTER_ITEM_GIVE,
    auditAction: A.CHARACTER_ITEM_GIVE_REQUESTED,
  },
  CHARACTER_PROPERTIES_QUERY: {
    permission: P.CHARACTER_PROPERTY_READ,
    auditAction: null,
  },
  CHARACTER_PROPERTY_GRANT: {
    permission: P.CHARACTER_PROPERTY_WRITE,
    auditAction: A.CHARACTER_PROPERTY_GRANT_REQUESTED,
  },
  CHARACTER_PROPERTY_REVOKE: {
    permission: P.CHARACTER_PROPERTY_WRITE,
    auditAction: A.CHARACTER_PROPERTY_REVOKE_REQUESTED,
  },
  CHARACTER_HOLDS_QUERY: {
    permission: P.CHARACTER_HOLD_READ,
    auditAction: null,
  },
  CHARACTER_HOLD_GRANT: {
    permission: P.CHARACTER_HOLD_WRITE,
    auditAction: A.CHARACTER_HOLD_GRANT_REQUESTED,
  },
  CHARACTER_HOLD_REVOKE: {
    permission: P.CHARACTER_HOLD_WRITE,
    auditAction: A.CHARACTER_HOLD_REVOKE_REQUESTED,
  },
  CHARACTER_HORSES_QUERY: {
    permission: P.CHARACTER_HORSE_READ,
    auditAction: null,
  },
  CHARACTER_HORSE_GIVE: {
    permission: P.CHARACTER_HORSE_GIVE,
    auditAction: A.CHARACTER_HORSE_GIVE_REQUESTED,
  },
  CHARACTER_HORSE_REVOKE: {
    permission: P.CHARACTER_HORSE_WRITE,
    auditAction: A.CHARACTER_HORSE_REVOKE_REQUESTED,
  },
  CHARACTER_TITLE_GIVE: {
    permission: P.CHARACTER_TITLE_GIVE,
    auditAction: A.CHARACTER_TITLE_GIVE_REQUESTED,
  },
  CHARACTER_SPELL_GIVE: {
    permission: P.CHARACTER_SPELL_GIVE,
    auditAction: A.CHARACTER_SPELL_GIVE_REQUESTED,
  },
  CHARACTER_FACTIONS_QUERY: { permission: P.FACTION_READ, auditAction: null },
  CHARACTER_FACTION_ADD: {
    permission: P.FACTION_WRITE,
    auditAction: A.CHARACTER_FACTION_ADD_REQUESTED,
  },
  CHARACTER_FACTION_REMOVE: {
    permission: P.FACTION_WRITE,
    auditAction: A.CHARACTER_FACTION_REMOVE_REQUESTED,
  },
};
