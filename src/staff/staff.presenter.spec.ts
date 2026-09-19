import { publicStaff } from './staff.presenter.js';
import { StaffUser } from './entities/staff-user.entity.js';

describe('Staff presenter', () => {
  it('explicitly returns public fields even when secrets or relations were loaded', () => {
    const user = Object.assign(new StaffUser(), {
      id: 'id',
      username: 'staff',
      displayName: 'Staff',
      roleName: 'SUPPORT',
      status: 'ACTIVE',
      passwordHash: 'secret',
      refreshTokenHash: 'secret-token',
      sessions: [{ refreshTokenHash: 'nested-secret' }],
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const response = publicStaff(user);
    expect(Object.keys(response).sort()).toEqual(
      [
        'id',
        'username',
        'displayName',
        'role',
        'status',
        'lastLoginAt',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
    expect(JSON.stringify(response)).not.toContain('secret');
  });
});
