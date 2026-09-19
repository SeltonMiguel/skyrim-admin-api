import { jest } from '@jest/globals';
import { DataSource } from 'typeorm';
import { AuthService } from './auth.service.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';
import { StaffStatus, StaffUser } from '../staff/entities/staff-user.entity.js';
import { StaffSession } from './entities/staff-session.entity.js';
import type { AuthenticatedStaff } from './auth.types.js';

function fixture() {
  const user = Object.assign(new StaffUser(), {
    id: 'user',
    username: 'staff',
    passwordHash: 'hash',
    status: StaffStatus.ACTIVE,
    roleName: 'SUPPORT',
  });
  const session: StaffSession = Object.assign(new StaffSession(), {
    id: 'session',
    staffUserId: 'user',
    refreshTokenHash: 'digest-old',
    expiresAt: new Date(Date.now() + 60000),
    revokedAt: null,
    staffUser: user,
  });
  const userResult = jest
    .fn<() => Promise<StaffUser | null>>()
    .mockResolvedValue(user);
  const sessionResult = jest
    .fn<() => Promise<StaffSession | null>>()
    .mockResolvedValue(session);
  const chain = (getOne: unknown) => {
    const builder = {
      addSelect: () => builder,
      where: () => builder,
      setLock: () => builder,
      getOne,
    };
    return builder;
  };
  const insert = jest.fn<() => Promise<void>>().mockResolvedValue();
  const update = jest.fn<() => Promise<void>>().mockResolvedValue();
  const save = jest
    .fn<(value: unknown) => Promise<unknown>>()
    .mockImplementation(async (value) => value);
  const users = {
    createQueryBuilder: () => chain(userResult),
    findOne: userResult,
    save,
  };
  const sessions = {
    createQueryBuilder: () => chain(sessionResult),
    findOne: sessionResult,
    insert,
    update,
    save,
  };
  const manager = {
    getRepository: (name: string) =>
      name === 'StaffUser'
        ? users
        : name === 'StaffSession'
          ? sessions
          : {
              findBy: async () => [
                { permissionName: 'PLAYER_TELEPORT_TO_STAFF' },
              ],
            },
  };
  const database = {
    ...manager,
    transaction: async (
      callback: (value: typeof manager) => Promise<unknown>,
    ) => callback(manager),
  } as unknown as DataSource;
  const passwords = {
    verify: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
    verifyMissing: jest.fn<() => Promise<void>>().mockResolvedValue(),
  };
  const pair = {
    accessToken: 'new-access',
    refreshToken: 'new-refresh',
    expiresIn: 900,
    refreshExpiresAt: new Date(Date.now() + 120000),
  };
  const tokens = {
    verify: jest
      .fn<() => Promise<{ sub: string; sid: string }>>()
      .mockResolvedValue({ sub: 'user', sid: 'session' }),
    issue: jest.fn<() => Promise<typeof pair>>().mockResolvedValue(pair),
    hash: () => 'digest-new',
    matches: jest.fn<() => boolean>().mockReturnValue(true),
  };
  const auth = new AuthService(
    database,
    passwords as unknown as PasswordService,
    tokens as unknown as TokenService,
  );
  return {
    auth,
    user,
    session,
    userResult,
    sessionResult,
    passwords,
    tokens,
    pair,
    insert,
    update,
    save,
  };
}

describe('AuthService', () => {
  it('logs in, persists a digest and updates last login without leaking the password hash', async () => {
    const f = fixture();
    const result = await f.auth.login({
      username: 'staff',
      password: 'password',
    });
    expect(result.accessToken).toBe('new-access');
    expect(result.staff).not.toHaveProperty('passwordHash');
    expect(f.user.lastLoginAt).toBeInstanceOf(Date);
    expect(f.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        refreshTokenHash: 'digest-new',
        expiresAt: f.pair.refreshExpiresAt,
      }),
    );
  });
  it.each(['missing', 'password', 'disabled'])(
    'uses a generic error for %s credentials',
    async (reason) => {
      const f = fixture();
      if (reason === 'missing') f.userResult.mockResolvedValue(null);
      if (reason === 'password') f.passwords.verify.mockResolvedValue(false);
      if (reason === 'disabled') f.user.status = StaffStatus.DISABLED;
      await expect(
        f.auth.login({ username: 'staff', password: 'password' }),
      ).rejects.toThrow('Invalid credentials');
      expect(f.insert).not.toHaveBeenCalled();
      if (reason === 'missing')
        expect(f.passwords.verifyMissing).toHaveBeenCalled();
    },
  );
  it('rotates refresh tokens and updates usage without changing absolute expiry', async () => {
    const f = fixture();
    const expiresAt = f.session.expiresAt.getTime();
    expect(await f.auth.refresh('old-refresh')).toMatchObject(f.pair);
    expect(f.tokens.issue).toHaveBeenCalledWith(
      'user',
      'session',
      f.session.expiresAt,
    );
    expect(f.tokens.matches).toHaveBeenCalledWith('old-refresh', 'digest-old');
    expect(f.session.refreshTokenHash).toBe('digest-new');
    expect(f.session.expiresAt.getTime()).toBe(expiresAt);
    expect(f.session.lastUsedAt).toBeInstanceOf(Date);
    expect(f.save).toHaveBeenCalledWith(f.session);
  });
  it.each([0, 1])(
    'rejects refresh and access at expiry + %i ms',
    async (offset) => {
      const f = fixture();
      const clock = jest
        .spyOn(Date, 'now')
        .mockReturnValue(f.session.expiresAt.getTime() + offset);
      try {
        await expect(f.auth.refresh('refresh')).rejects.toThrow(
          'Invalid or expired session',
        );
        await expect(f.auth.authenticate('access')).rejects.toThrow(
          'Invalid or expired session',
        );
        expect(f.tokens.issue).not.toHaveBeenCalled();
        expect(f.save).not.toHaveBeenCalled();
      } finally {
        clock.mockRestore();
      }
    },
  );
  it.each(['missing', 'expired', 'revoked', 'mismatch', 'disabled'])(
    'rejects %s refresh sessions',
    async (reason) => {
      const f = fixture();
      if (reason === 'missing') f.sessionResult.mockResolvedValue(null);
      if (reason === 'expired') f.session.expiresAt = new Date(0);
      if (reason === 'revoked') f.session.revokedAt = new Date();
      if (reason === 'mismatch') f.tokens.matches.mockReturnValue(false);
      if (reason === 'disabled') f.user.status = StaffStatus.DISABLED;
      await expect(f.auth.refresh('refresh')).rejects.toThrow(
        'Invalid or expired session',
      );
      expect(f.tokens.issue).not.toHaveBeenCalled();
    },
  );
  it('loads current database permissions on access authentication', async () => {
    const f = fixture();
    expect(await f.auth.authenticate('access')).toMatchObject({
      sessionId: 'session',
      permissions: ['PLAYER_TELEPORT_TO_STAFF'],
    });
  });
  it.each(['disabled', 'revoked', 'expired'])(
    'rejects %s access sessions',
    async (reason) => {
      const f = fixture();
      if (reason === 'disabled') f.user.status = StaffStatus.DISABLED;
      if (reason === 'revoked') f.session.revokedAt = new Date();
      if (reason === 'expired') f.session.expiresAt = new Date(0);
      await expect(f.auth.authenticate('access')).rejects.toThrow(
        'Invalid or expired session',
      );
    },
  );
  it('revokes the current session on logout', async () => {
    const f = fixture();
    await f.auth.logout({
      user: f.user,
      sessionId: 'session',
      permissions: [],
    } as AuthenticatedStaff);
    expect(f.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'session', staffUserId: 'user' }),
      { revokedAt: expect.any(Date) },
    );
  });
});
