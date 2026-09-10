import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import Joi from 'joi';

export interface ApplicationConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  database: {
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
    logging: boolean;
  };
}

interface Environment {
  NODE_ENV: ApplicationConfig['nodeEnv'];
  PORT: number;
  DB_HOST: string;
  DB_PORT: number;
  DB_USERNAME: string;
  DB_PASSWORD: string;
  DB_DATABASE: string;
  DB_LOGGING?: boolean;
}

const schema = Joi.object<Environment>({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().integer().min(1).max(65535).default(3000),
  DB_HOST: Joi.string().trim().required(),
  DB_PORT: Joi.number().integer().min(1).max(65535).default(5432),
  DB_USERNAME: Joi.string().trim().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_DATABASE: Joi.string().trim().required(),
  DB_LOGGING: Joi.boolean(),
});

export function validateEnvironment(
  raw: Record<string, unknown>,
): ApplicationConfig {
  const { value, error } = schema.validate(raw, {
    abortEarly: false,
    allowUnknown: true,
  });
  if (error) {
    // Report variable names, never potentially sensitive input values.
    const fields = error.details.map((detail) => detail.path.join('.'));
    throw new Error(`Invalid environment variables: ${fields.join(', ')}`);
  }

  return {
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    database: {
      host: value.DB_HOST,
      port: value.DB_PORT,
      username: value.DB_USERNAME,
      password: value.DB_PASSWORD,
      database: value.DB_DATABASE,
      logging: value.DB_LOGGING ?? value.NODE_ENV === 'development',
    },
  };
}

// Used by the standalone TypeORM CLI. Runtime variables override .env,
// matching ConfigModule's precedence without modifying process.env.
export function loadEnvironment(): ApplicationConfig {
  const path = resolve('.env');
  const file = existsSync(path) ? parse(readFileSync(path)) : {};
  return validateEnvironment({ ...file, ...process.env });
}
