import { ROLE_PERMISSIONS } from './role-permissions.js';
import { Permission as P } from './permissions.js';
import { RoleName as R } from './roles.js';

describe('Explicit role permission matrix', () => {
  it('grants all 45 permissions to coordinator without duplicates', () => {
    expect(Object.values(P)).toHaveLength(45);
    expect(new Set(ROLE_PERMISSIONS[R.COORDINATOR])).toEqual(
      new Set(Object.values(P)),
    );
    for (const grants of Object.values(ROLE_PERMISSIONS))
      expect(new Set(grants).size).toBe(grants.length);
  });
  it('keeps DEV writes isolated to server operations and transport recovery', () => {
    expect(ROLE_PERMISSIONS[R.DEV]).toEqual([
      P.DASHBOARD_READ,
      P.GAME_BRIDGE_READ,
      P.SERVER_START,
      P.SERVER_PAUSE,
      P.SERVER_RESTART,
      P.GAME_AGENT_CREDENTIAL_MANAGE,
      P.OPERATIONS_READ,
      P.SERVER_CONTROL_RESOLVE,
      P.PLAYER_TRADE_RECOVER,
      P.PLAYER_MARKETPLACE_RECOVER,
    ]);
    for (const role of [R.GENERAL_CHIEF, R.ADMIN, R.MODERATOR, R.SUPPORT]) {
      for (const permission of [
        P.SERVER_START,
        P.SERVER_PAUSE,
        P.SERVER_RESTART,
        P.STAFF_READ,
        P.STAFF_WRITE,
        P.VIP_STORE_WRITE,
        P.GAME_AGENT_CREDENTIAL_MANAGE,
      ])
        expect(ROLE_PERMISSIONS[role]).not.toContain(permission);
    }
  });
  it.each(Object.values(R))(
    'grants operational reads to %s without granting Audit to Support or DEV',
    (role) => {
      expect(ROLE_PERMISSIONS[role]).toEqual(
        expect.arrayContaining([P.DASHBOARD_READ, P.GAME_BRIDGE_READ]),
      );
      if (role === R.SUPPORT || role === R.DEV)
        expect(ROLE_PERMISSIONS[role]).not.toContain(P.AUDIT_READ);
    },
  );
  it('explicitly assigns administrative grants', () => {
    expect(ROLE_PERMISSIONS[R.SUPPORT]).toEqual([
      P.DASHBOARD_READ,
      P.GAME_BRIDGE_READ,
      P.PLAYER_TELEPORT_TO_STAFF,
    ]);
    expect(ROLE_PERMISSIONS[R.MODERATOR]).toHaveLength(9);
    expect(ROLE_PERMISSIONS[R.ADMIN]).toHaveLength(14);
    expect(ROLE_PERMISSIONS[R.GENERAL_CHIEF]).toHaveLength(35);
    expect(ROLE_PERMISSIONS[R.MODERATOR]).toContain(P.AUDIT_READ);
    expect(ROLE_PERMISSIONS[R.MODERATOR]).not.toContain(P.PLAYER_BAN);
    expect(ROLE_PERMISSIONS[R.ADMIN]).toContain(P.PLAYER_BAN);
    expect(ROLE_PERMISSIONS[R.ADMIN]).not.toContain(P.CHARACTER_ITEM_GIVE);
    expect(ROLE_PERMISSIONS[R.GENERAL_CHIEF]).toContain(P.CHARACTER_ITEM_GIVE);
  });
  // 12.4: one narrow permission per recovery domain.
  it('keeps operational recovery grants narrow', () => {
    const holders = (permission: P) =>
      Object.values(R).filter((role) =>
        ROLE_PERMISSIONS[role].includes(permission),
      );
    expect(holders(P.PLAYER_ECONOMY_ADJUST)).toEqual([R.COORDINATOR]);
    expect(holders(P.SERVER_CONTROL_RESOLVE)).toEqual([R.COORDINATOR, R.DEV]);
    expect(holders(P.VIP_DELIVERY_RECOVER)).toEqual([
      R.COORDINATOR,
      R.GENERAL_CHIEF,
    ]);
    expect(holders(P.PLAYER_ACCOUNT_MODERATE)).toEqual([
      R.COORDINATOR,
      R.GENERAL_CHIEF,
      R.ADMIN,
    ]);
    expect(holders(P.PLAYER_CHAT_MODERATE)).toEqual([
      R.COORDINATOR,
      R.GENERAL_CHIEF,
      R.ADMIN,
      R.MODERATOR,
    ]);
    for (const permission of [
      P.PLAYER_TRADE_RECOVER,
      P.PLAYER_MARKETPLACE_RECOVER,
      P.OPERATIONS_READ,
    ])
      expect(holders(permission)).toEqual([
        R.COORDINATOR,
        R.GENERAL_CHIEF,
        R.DEV,
      ]);
    expect(ROLE_PERMISSIONS[R.SUPPORT]).not.toEqual(
      expect.arrayContaining([P.OPERATIONS_READ]),
    );
  });
});
