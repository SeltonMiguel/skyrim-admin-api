import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import Joi from 'joi';

export interface ApplicationConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  gameBridge: {
    heartbeatTimeoutMs: number;
    ackTimeoutMs: number;
    executionTimeoutMs: number;
    maxDispatchAttempts: number;
  };
  jwt: {
    accessSecret: string;
    refreshSecret: string;
    accessTtl: number;
    refreshTtl: number;
  };
  bootstrap: { username?: string; displayName?: string; password?: string };
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
  GAME_BRIDGE_HEARTBEAT_TIMEOUT_MS: number;
  GAME_COMMAND_ACK_TIMEOUT_MS: number;
  GAME_COMMAND_EXECUTION_TIMEOUT_MS: number;
  GAME_COMMAND_MAX_DISPATCH_ATTEMPTS: number;
  DB_HOST: string;
  DB_PORT: number;
  DB_USERNAME: string;
  DB_PASSWORD: string;
  DB_DATABASE: string;
  DB_LOGGING?: boolean;
  JWT_ACCESS_SECRET?: string;
  JWT_REFRESH_SECRET?: string;
  JWT_ACCESS_TTL: string;
  JWT_REFRESH_TTL: string;
  BOOTSTRAP_COORDINATOR_USERNAME?: string;
  BOOTSTRAP_COORDINATOR_DISPLAY_NAME?: string;
  BOOTSTRAP_COORDINATOR_PASSWORD?: string;
}

// Ephemeral per-process secrets are allowed only by the test schema.
const testAccessSecret = randomBytes(48).toString('base64url');
const testRefreshSecret = randomBytes(48).toString('base64url');
function ttlSeconds(ttl: string): number {
  const units: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return Number(ttl.slice(0, -1)) * units[ttl.slice(-1)];
}

const schema = Joi.object<Environment>({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().integer().min(1).max(65535).default(3000),
  GAME_BRIDGE_HEARTBEAT_TIMEOUT_MS: Joi.number()
    .integer()
    .min(100)
    .max(3600000)
    .default(30000),
  GAME_COMMAND_ACK_TIMEOUT_MS: Joi.number()
    .integer()
    .min(100)
    .max(3600000)
    .default(5000),
  GAME_COMMAND_EXECUTION_TIMEOUT_MS: Joi.number()
    .integer()
    .min(100)
    .max(86400000)
    .default(30000),
  GAME_COMMAND_MAX_DISPATCH_ATTEMPTS: Joi.number()
    .integer()
    .min(1)
    .max(10)
    .default(3),
  DB_HOST: Joi.string().trim().required(),
  DB_PORT: Joi.number().integer().min(1).max(65535).default(5432),
  DB_USERNAME: Joi.string().trim().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_DATABASE: Joi.string().trim().required(),
  DB_LOGGING: Joi.boolean(),
  JWT_ACCESS_SECRET: Joi.string()
    .min(32)
    .pattern(/^\S+$/)
    .when('NODE_ENV', {
      is: 'test',
      // Joi's conditional schema key, not a Promise method.
      // oxlint-disable-next-line unicorn/no-thenable
      then: Joi.optional().empty(''),
      otherwise: Joi.required(),
    }),
  JWT_REFRESH_SECRET: Joi.string()
    .min(32)
    .pattern(/^\S+$/)
    .invalid(Joi.ref('JWT_ACCESS_SECRET'))
    .when('NODE_ENV', {
      is: 'test',
      // Joi's conditional schema key, not a Promise method.
      // oxlint-disable-next-line unicorn/no-thenable
      then: Joi.optional().empty(''),
      otherwise: Joi.required(),
    }),
  JWT_ACCESS_TTL: Joi.string()
    .pattern(/^[1-9][0-9]*(s|m|h|d)$/)
    .default('15m'),
  JWT_REFRESH_TTL: Joi.string()
    .pattern(/^[1-9][0-9]*(s|m|h|d)$/)
    .default('7d'),
  BOOTSTRAP_COORDINATOR_USERNAME: Joi.string().allow(''),
  BOOTSTRAP_COORDINATOR_DISPLAY_NAME: Joi.string().allow(''),
  BOOTSTRAP_COORDINATOR_PASSWORD: Joi.string().allow(''),
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

  const accessTtl = ttlSeconds(value.JWT_ACCESS_TTL);
  const refreshTtl = ttlSeconds(value.JWT_REFRESH_TTL);
  if (accessTtl > 3600 || refreshTtl > 90 * 86400 || refreshTtl <= accessTtl) {
    throw new Error(
      'Invalid environment variables: JWT_ACCESS_TTL, JWT_REFRESH_TTL',
    );
  }
  return {
    gameBridge: {
      heartbeatTimeoutMs: value.GAME_BRIDGE_HEARTBEAT_TIMEOUT_MS,
      ackTimeoutMs: value.GAME_COMMAND_ACK_TIMEOUT_MS,
      executionTimeoutMs: value.GAME_COMMAND_EXECUTION_TIMEOUT_MS,
      maxDispatchAttempts: value.GAME_COMMAND_MAX_DISPATCH_ATTEMPTS,
    },
    jwt: {
      accessSecret: value.JWT_ACCESS_SECRET || testAccessSecret,
      refreshSecret: value.JWT_REFRESH_SECRET || testRefreshSecret,
      accessTtl,
      refreshTtl,
    },
    bootstrap: {
      username: value.BOOTSTRAP_COORDINATOR_USERNAME,
      displayName: value.BOOTSTRAP_COORDINATOR_DISPLAY_NAME,
      password: value.BOOTSTRAP_COORDINATOR_PASSWORD,
    },
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
