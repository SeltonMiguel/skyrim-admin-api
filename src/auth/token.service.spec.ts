import { ConfigService } from '@nestjs/config';
import { jest } from '@jest/globals';
import { randomBytes, randomUUID } from 'node:crypto';
import { decodeJwt, SignJWT } from 'jose';
import { TokenService } from './token.service.js';

const accessSecret = randomBytes(48).toString('hex');
const refreshSecret = randomBytes(48).toString('hex');
const tokens = new TokenService(
  new ConfigService({
    application: {
      jwt: { accessSecret, refreshSecret, accessTtl: 900, refreshTtl: 604800 },
    },
  }),
);

describe('TokenService', () => {
  it('caps rotated refresh JWTs at the original expiry across multiple rotations', async () => {
    const now = Math.floor(Date.now() / 1000) * 1000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const sub = randomUUID(),
        sid = randomUUID();
      const initial = await tokens.issue(sub, sid);
      // Round down fractional seconds so exp can never exceed session expiry.
      const sessionExpiresAt = new Date(
        initial.refreshExpiresAt.getTime() + 999,
      );
      let previous = initial.refreshToken;
      for (const elapsed of [86400, 3 * 86400, 604799]) {
        clock.mockReturnValue(now + elapsed * 1000);
        const rotated = await tokens.issue(sub, sid, sessionExpiresAt);
        expect(rotated.refreshToken).not.toBe(previous);
        expect(decodeJwt(rotated.refreshToken).exp).toBe(
          initial.refreshExpiresAt.getTime() / 1000,
        );
        expect(rotated.refreshExpiresAt.getTime()).toBeLessThanOrEqual(
          sessionExpiresAt.getTime(),
        );
        previous = rotated.refreshToken;
      }
      clock.mockReturnValue(initial.refreshExpiresAt.getTime());
      await expect(
        tokens.issue(sub, sid, initial.refreshExpiresAt),
      ).rejects.toThrow('Invalid or expired session');
      const freshLogin = await tokens.issue(sub, randomUUID());
      expect(freshLogin.refreshExpiresAt.getTime()).toBe(
        initial.refreshExpiresAt.getTime() + 604800000,
      );
    } finally {
      clock.mockRestore();
    }
  });
  it('issues distinct signed tokens with minimal claims and TTLs', async () => {
    const sub = randomUUID(),
      sid = randomUUID();
    const pair = await tokens.issue(sub, sid);
    expect(await tokens.verify(pair.accessToken, 'access')).toEqual({
      sub,
      sid,
    });
    expect(await tokens.verify(pair.refreshToken, 'refresh')).toEqual({
      sub,
      sid,
    });
    const access = decodeJwt(pair.accessToken),
      refresh = decodeJwt(pair.refreshToken);
    expect(access.exp! - access.iat!).toBe(900);
    expect(refresh.exp! - refresh.iat!).toBe(604800);
    expect(access).not.toHaveProperty('permissions');
    expect(pair.refreshExpiresAt.getTime()).toBe(refresh.exp! * 1000);
    expect((await tokens.issue(sub, sid)).refreshToken).not.toBe(
      pair.refreshToken,
    );
  });
  it('rejects swapped token types, tampering and invalid tokens', async () => {
    const pair = await tokens.issue(randomUUID(), randomUUID());
    await expect(tokens.verify(pair.refreshToken, 'access')).rejects.toThrow(
      'Invalid or expired token',
    );
    await expect(tokens.verify(pair.accessToken, 'refresh')).rejects.toThrow(
      'Invalid or expired token',
    );
    await expect(
      tokens.verify(`x${pair.accessToken}`, 'access'),
    ).rejects.toThrow();
    await expect(tokens.verify('invalid', 'refresh')).rejects.toThrow();
  });
  it('rejects an expired signed token', async () => {
    const expired = await new SignJWT({ sid: randomUUID(), kind: 'refresh' })
      .setSubject(randomUUID())
      .setJti(randomUUID())
      .setIssuedAt(1)
      .setExpirationTime(2)
      .setIssuer('skyrim-admin-api')
      .setAudience('skyrim-admin-refresh')
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .sign(new TextEncoder().encode(refreshSecret));
    await expect(tokens.verify(expired, 'refresh')).rejects.toThrow();
  });
  it('stores only a SHA-256 digest and compares safely', () => {
    const hash = tokens.hash('random-token');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens.matches('random-token', hash)).toBe(true);
    expect(tokens.matches('wrong', hash)).toBe(false);
    expect(tokens.matches('random-token', 'invalid')).toBe(false);
  });
});
