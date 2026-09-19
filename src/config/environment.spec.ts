import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { validateEnvironment } from './environment.js';

const example = parse(readFileSync('.env.example'));

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
