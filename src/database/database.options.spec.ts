import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { validateEnvironment } from '../config/environment.js';
import { createDatabaseOptions } from './database.options.js';

describe('Database options shared by Nest and CLI', () => {
  it('uses validated configuration without automatic schema changes', () => {
    const config = validateEnvironment(parse(readFileSync('.env.example')));
    const options = createDatabaseOptions(config);
    expect(options).toMatchObject({
      ...config.database,
      type: 'postgres',
      synchronize: false,
      migrationsRun: false,
      connectTimeoutMS: 5000,
      extra: { connectionTimeoutMillis: 5000, query_timeout: 5000 },
    });
    expect(options.migrations).toEqual([
      expect.stringMatching(/\/database\/migrations\/\*\.js$/),
    ]);
    expect(options.entities).toEqual([
      expect.stringMatching(/\/\*\*\/\*\.entity\.js$/),
    ]);
  });
});
