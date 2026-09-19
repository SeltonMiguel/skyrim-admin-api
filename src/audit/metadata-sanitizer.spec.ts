import { sanitizeMetadata } from './metadata-sanitizer.js';

describe('Audit metadata sanitizer', () => {
  it('preserves explicit safe context while removing sensitive keys recursively', () => {
    const secrets = {
      password: 'private',
      passwordHash: 'private',
      refreshToken: 'private',
      refreshTokenHash: 'private',
      accessToken: 'private',
      Authorization: 'private',
      JWT_ACCESS_SECRET: 'private',
      jwtRefreshSecret: 'private',
      BOOTSTRAP_COORDINATOR_PASSWORD: 'private',
      cookies: 'private',
      DB_PASSWORD: 'private',
      DB_USERNAME: 'private',
      database: { username: 'private', password: 'private' },
      db: { user: 'private' },
      databaseCredentials: 'private',
      'api-key': 'private',
      refresh_token: 'private',
      'PASSWORD-HASH': 'private',
      headers: { accept: 'private' },
      body: { value: 'private' },
    };
    const input = {
      previousRole: 'SUPPORT',
      newRole: 'MODERATOR',
      ...secrets,
      nested: { ...secrets, safe: true },
      array: [{ ...secrets, changed: 1 }],
    };
    expect(sanitizeMetadata(input)).toEqual({
      previousRole: 'SUPPORT',
      newRole: 'MODERATOR',
      nested: { safe: true },
      array: [{ changed: 1 }],
    });
    expect(input.password).toBe('private');
  });
  it('does not invoke getters, persist class instances or allow prototype keys', () => {
    const metadata = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":"private","safe":1}',
    ) as Record<string, unknown>;
    Object.defineProperty(metadata, 'danger', {
      enumerable: true,
      get: () => {
        throw new Error('Getter must not execute');
      },
    });
    metadata.error = new Error('private');
    expect(sanitizeMetadata(metadata)).toEqual({ safe: 1, error: null });
    expect({}).not.toHaveProperty('polluted');
  });
  it('bounds depth, arrays, strings and overall size and handles cycles', () => {
    const cyclic: Record<string, unknown> = { safe: true };
    cyclic.self = cyclic;
    expect(sanitizeMetadata(cyclic)).toEqual({ safe: true, self: null });
    expect(sanitizeMetadata({ text: 'x'.repeat(1000) })).toEqual({
      text: 'x'.repeat(512),
    });
    expect(
      sanitizeMetadata({ list: Array.from({ length: 100 }, () => 1) })?.list,
    ).toHaveLength(50);
    expect(
      sanitizeMetadata(
        Object.fromEntries(
          Array.from({ length: 40 }, (_, i) => [`safe${i}`, 'x'.repeat(512)]),
        ),
      ),
    ).toBeNull();
    expect(sanitizeMetadata()).toBeNull();
    expect(sanitizeMetadata({ value: Infinity, missing: undefined })).toEqual({
      value: null,
      missing: null,
    });
    expect(
      sanitizeMetadata({
        a: { b: { c: { d: { e: { f: { g: 'too deep' } } } } } },
      }),
    ).toEqual({ a: { b: { c: { d: { e: { f: { g: null } } } } } } });
  });
});
