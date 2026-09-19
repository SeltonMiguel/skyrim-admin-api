import { ROLE_PERMISSIONS } from './role-permissions.js';
import { Permission as P } from './permissions.js';
import { RoleName as R } from './roles.js';

describe('Explicit role permission matrix', () => {
  it('grants all 29 permissions to coordinator without duplicates', () => {
    expect(Object.values(P)).toHaveLength(29);
    expect(new Set(ROLE_PERMISSIONS[R.COORDINATOR])).toEqual(
      new Set(Object.values(P)),
    );
    for (const grants of Object.values(ROLE_PERMISSIONS))
      expect(new Set(grants).size).toBe(grants.length);
  });
  it('keeps DEV isolated to server operations', () => {
    expect(ROLE_PERMISSIONS[R.DEV]).toEqual([
      P.SERVER_START,
      P.SERVER_PAUSE,
      P.SERVER_RESTART,
    ]);
    for (const role of [R.GENERAL_CHIEF, R.ADMIN, R.MODERATOR, R.SUPPORT]) {
      for (const permission of [
        P.SERVER_START,
        P.SERVER_PAUSE,
        P.SERVER_RESTART,
        P.STAFF_READ,
        P.STAFF_WRITE,
        P.VIP_STORE_WRITE,
      ])
        expect(ROLE_PERMISSIONS[role]).not.toContain(permission);
    }
  });
  it('explicitly assigns administrative grants', () => {
    expect(ROLE_PERMISSIONS[R.SUPPORT]).toEqual([P.PLAYER_TELEPORT_TO_STAFF]);
    expect(ROLE_PERMISSIONS[R.MODERATOR]).toHaveLength(6);
    expect(ROLE_PERMISSIONS[R.ADMIN]).toHaveLength(9);
    expect(ROLE_PERMISSIONS[R.GENERAL_CHIEF]).toHaveLength(23);
    expect(ROLE_PERMISSIONS[R.MODERATOR]).toContain(P.AUDIT_READ);
    expect(ROLE_PERMISSIONS[R.MODERATOR]).not.toContain(P.PLAYER_BAN);
    expect(ROLE_PERMISSIONS[R.ADMIN]).toContain(P.PLAYER_BAN);
    expect(ROLE_PERMISSIONS[R.ADMIN]).not.toContain(P.CHARACTER_ITEM_GIVE);
    expect(ROLE_PERMISSIONS[R.GENERAL_CHIEF]).toContain(P.CHARACTER_ITEM_GIVE);
  });
});
