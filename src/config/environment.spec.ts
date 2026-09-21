import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { validateEnvironment } from './environment.js';

const example: Record<string, string> = {
  ...parse(readFileSync('.env.example')),
  JWT_ACCESS_SECRET: randomBytes(48).toString('hex'),
  JWT_REFRESH_SECRET: randomBytes(48).toString('hex'),
};

describe('Environment validation', () => {
  it('accepts documented settings and converts types', () => {
    const config = validateEnvironment(example);
    expect(config.port).toBe(3000);
    expect(config.database.port).toBe(5432);
    expect(config.database.username).toBe(example.DB_USERNAME);
    expect(config.database.logging).toBe(true);
  });

  it.each(['DB_HOST', 'DB_USERNAME', 'DB_PASSWORD', 'DB_DATABASE'])(
    'rejects missing or empty %s before connecting',
    (field) => {
      expect(() =>
        validateEnvironment({ ...example, [field]: undefined }),
      ).toThrow(field);
      expect(() => validateEnvironment({ ...example, [field]: '' })).toThrow(
        field,
      );
    },
  );

  it.each([
    ['PORT', '0'],
    ['PORT', '65536'],
    ['PORT', '3000abc'],
    ['DB_PORT', '-1'],
    ['DB_PORT', '1.5'],
    ['DB_PORT', 'abc'],
    ['NODE_ENV', 'invalid'],
    ['DB_LOGGING', 'maybe'],
  ])('rejects invalid %s=%s', (field, value) => {
    expect(() => validateEnvironment({ ...example, [field]: value })).toThrow(
      field,
    );
  });

  it('aggregates failures without including input values', () => {
    expect(() =>
      validateEnvironment({
        ...example,
        NODE_ENV: 'private-value',
        DB_PORT: 'secret',
      }),
    ).toThrow('Invalid environment variables: NODE_ENV, DB_PORT');
  });

  it('disables logging outside development and supports explicit overrides', () => {
    expect(
      validateEnvironment({ ...example, NODE_ENV: 'production' }).database
        .logging,
    ).toBe(false);
    expect(
      validateEnvironment({ ...example, NODE_ENV: 'test' }).database.logging,
    ).toBe(false);
    expect(
      validateEnvironment({ ...example, DB_LOGGING: 'false' }).database.logging,
    ).toBe(false);
    expect(
      validateEnvironment({
        ...example,
        NODE_ENV: 'production',
        DB_LOGGING: 'true',
      }).database.logging,
    ).toBe(true);
  });

  it('ignores unrelated host environment variables', () => {
    expect(() =>
      validateEnvironment({ ...example, UNRELATED: 'value' }),
    ).not.toThrow();
  });
});

describe('JWT environment validation', () => {
  describe.each(['development', 'production'])('%s secrets', (nodeEnv) => {
    it.each(['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'])(
      'requires %s, rejects trivial values and enforces 32 characters',
      (field) => {
        for (const value of [
          undefined,
          '',
          'secret',
          'password',
          '123456',
          randomBytes(24).toString('base64url').slice(0, 31),
          ' '.repeat(32),
          'secret'.padEnd(32),
        ]) {
          expect(() =>
            validateEnvironment({
              ...example,
              NODE_ENV: nodeEnv,
              [field]: value,
            }),
          ).toThrow(field);
        }
        const secret = randomBytes(24).toString('base64url');
        expect(secret).toHaveLength(32);
        const config = validateEnvironment({
          ...example,
          NODE_ENV: nodeEnv,
          [field]: secret,
        });
        expect(
          field === 'JWT_ACCESS_SECRET'
            ? config.jwt.accessSecret
            : config.jwt.refreshSecret,
        ).toBe(secret);
      },
    );
    it('requires distinct secrets without exposing them in validation errors', () => {
      const secret = randomBytes(32).toString('base64url');
      const validate = () =>
        validateEnvironment({
          ...example,
          NODE_ENV: nodeEnv,
          JWT_ACCESS_SECRET: secret,
          JWT_REFRESH_SECRET: secret,
        });
      expect(validate).toThrow('JWT_REFRESH_SECRET');
      expect(validate).not.toThrow(secret);
    });
  });
  it('rejects shared secrets and unsafe TTLs', () => {
    expect(() =>
      validateEnvironment({
        ...example,
        JWT_REFRESH_SECRET: example.JWT_ACCESS_SECRET,
      }),
    ).toThrow('JWT_REFRESH_SECRET');
    for (const value of ['0s', '15', '-1h', '2h', 'Infinityd'])
      expect(() =>
        validateEnvironment({ ...example, JWT_ACCESS_TTL: value }),
      ).toThrow('JWT_ACCESS_TTL');
    expect(() =>
      validateEnvironment({ ...example, JWT_REFRESH_TTL: '1s' }),
    ).toThrow('JWT_REFRESH_TTL');
    expect(() =>
      validateEnvironment({ ...example, JWT_REFRESH_TTL: '91d' }),
    ).toThrow('JWT_REFRESH_TTL');
  });
  it('uses distinct ephemeral secrets only in test', () => {
    const config = validateEnvironment({
      ...example,
      NODE_ENV: 'test',
      JWT_ACCESS_SECRET: '',
      JWT_REFRESH_SECRET: '',
    });
    expect(config.jwt.accessSecret.length).toBeGreaterThanOrEqual(32);
    expect(config.jwt.accessSecret).not.toBe(config.jwt.refreshSecret);
  });
});

describe('Game Bridge environment validation', () => {
  it('provides bounded documented defaults', () => {
    expect(validateEnvironment(example).gameBridge).toEqual({
      heartbeatTimeoutMs: 30000,
      ackTimeoutMs: 5000,
      executionTimeoutMs: 30000,
      maxDispatchAttempts: 3,
    });
  });
  it.each([
    'GAME_BRIDGE_HEARTBEAT_TIMEOUT_MS',
    'GAME_COMMAND_ACK_TIMEOUT_MS',
    'GAME_COMMAND_EXECUTION_TIMEOUT_MS',
    'GAME_COMMAND_MAX_DISPATCH_ATTEMPTS',
  ])('rejects invalid %s', (field) => {
    for (const value of ['0', '-1', '1.5', 'abc', 'Infinity', '999999999999'])
      expect(() => validateEnvironment({ ...example, [field]: value })).toThrow(
        field,
      );
  });
});
