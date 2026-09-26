import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { validateEnvironment } from '../config/environment.js';
import {
  createDatabaseOptions,
  createMigrationOptions,
  databaseSsl,
} from './database.options.js';

describe('Database options shared by Nest and CLI', () => {
  it('uses validated configuration without automatic schema changes', () => {
    const config = validateEnvironment({
      ...parse(readFileSync('.env.example')),
      JWT_ACCESS_SECRET: randomBytes(48).toString('hex'),
      JWT_REFRESH_SECRET: randomBytes(48).toString('hex'),
      PLAYER_JWT_ACCESS_SECRET: randomBytes(48).toString('hex'),
      PLAYER_JWT_REFRESH_SECRET: randomBytes(48).toString('hex'),
    });
    const options = createDatabaseOptions(config);
    expect(options).toMatchObject({
      type: 'postgres',
      host: config.database.host,
      port: config.database.port,
      username: config.database.username,
      database: config.database.database,
      ssl: false,
      synchronize: false,
      migrationsRun: false,
      // The runtime never creates extensions (12.2).
      installExtensions: false,
      connectTimeoutMS: 5000,
      // Bounded pool; client and server-side timeouts for the API (12.2).
      extra: {
        max: 10,
        connectionTimeoutMillis: 5000,
        query_timeout: 5000,
        statement_timeout: 10000,
      },
    });
    // The migration runner never inherits the API's short timeout.
    expect(createMigrationOptions(config)).toMatchObject({
      installExtensions: false,
      synchronize: false,
      migrationsRun: false,
      extra: {
        max: 1,
        statement_timeout: 600000,
        lock_timeout: 10000,
        query_timeout: 605000,
      },
    });
    expect(
      databaseSsl({
        ...config.database,
        ssl: { mode: 'verify-full', ca: 'CA' },
      }),
    ).toEqual({ rejectUnauthorized: true, ca: 'CA' });
    expect(
      databaseSsl({ ...config.database, ssl: { mode: 'require' } }),
    ).toEqual({
      rejectUnauthorized: false,
    });
    expect(options.migrations).toEqual([
      expect.stringMatching(/\/database\/migrations\/\*\.js$/),
    ]);
    expect(options.entities).toEqual([
      expect.stringMatching(/\/\*\*\/\*\.entity\.js$/),
    ]);
  });
});
