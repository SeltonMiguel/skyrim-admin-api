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
  // Player tokens never fall back to, or share, staff secrets.
  playerAuth: {
    accessSecret: string;
    refreshSecret: string;
    accessTtl: number;
    refreshTtl: number;
    rateLimitPerMinute: number;
    // null when Discord credentials are not configured: exchange returns 503.
    discord: {
      clientId: string;
      clientSecret: string;
      redirectUris: string[];
    } | null;
  };
  playerCharacters: { challengeTtl: number };
  playerGroups: { inviteTtl: number };
  playerGuilds: { inviteTtl: number };
  realtime: { authTimeoutMs: number };
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
  PLAYER_JWT_ACCESS_SECRET?: string;
  PLAYER_JWT_REFRESH_SECRET?: string;
  PLAYER_JWT_ACCESS_TTL: string;
  PLAYER_JWT_REFRESH_TTL: string;
  PLAYER_AUTH_RATE_LIMIT_PER_MINUTE: number;
  PLAYER_LINK_CHALLENGE_TTL: string;
  PLAYER_GROUP_INVITE_TTL: string;
  PLAYER_GUILD_INVITE_TTL: string;
  REALTIME_AUTH_TIMEOUT_MS: number;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  DISCORD_REDIRECT_URIS?: string;
  BOOTSTRAP_COORDINATOR_USERNAME?: string;
  BOOTSTRAP_COORDINATOR_DISPLAY_NAME?: string;
  BOOTSTRAP_COORDINATOR_PASSWORD?: string;
}

// Ephemeral per-process secrets are allowed only by the test schema.
const testAccessSecret = randomBytes(48).toString('base64url');
const testRefreshSecret = randomBytes(48).toString('base64url');
const testPlayerAccessSecret = randomBytes(48).toString('base64url');
const testPlayerRefreshSecret = randomBytes(48).toString('base64url');
const secret = () =>
  Joi.string()
    .min(32)
    .pattern(/^\S+$/)
    .when('NODE_ENV', {
      is: 'test',
      // Joi's conditional schema key, not a Promise method.
      // oxlint-disable-next-line unicorn/no-thenable
      then: Joi.optional().empty(''),
      otherwise: Joi.required(),
    });
const ttl = (fallback: string) =>
  Joi.string()
    .pattern(/^[1-9][0-9]*(s|m|h|d)$/)
    .default(fallback);
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
  PLAYER_JWT_ACCESS_SECRET: secret().invalid(
    Joi.ref('JWT_ACCESS_SECRET'),
    Joi.ref('JWT_REFRESH_SECRET'),
  ),
  PLAYER_JWT_REFRESH_SECRET: secret().invalid(
    Joi.ref('PLAYER_JWT_ACCESS_SECRET'),
    Joi.ref('JWT_ACCESS_SECRET'),
    Joi.ref('JWT_REFRESH_SECRET'),
  ),
  PLAYER_JWT_ACCESS_TTL: ttl('15m'),
  PLAYER_JWT_REFRESH_TTL: ttl('30d'),
  PLAYER_AUTH_RATE_LIMIT_PER_MINUTE: Joi.number()
    .integer()
    .min(1)
    .max(1000)
    .default(20),
  PLAYER_LINK_CHALLENGE_TTL: ttl('10m'),
  PLAYER_GROUP_INVITE_TTL: ttl('10m'),
  PLAYER_GUILD_INVITE_TTL: ttl('7d'),
  REALTIME_AUTH_TIMEOUT_MS: Joi.number()
    .integer()
    .min(100)
    .max(60000)
    .default(5000),
  DISCORD_CLIENT_ID: Joi.string().trim().allow('').max(128),
  DISCORD_CLIENT_SECRET: Joi.string().allow('').max(256),
  DISCORD_REDIRECT_URIS: Joi.string().allow('').max(4096),
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
  const playerAccessTtl = ttlSeconds(value.PLAYER_JWT_ACCESS_TTL);
  const playerRefreshTtl = ttlSeconds(value.PLAYER_JWT_REFRESH_TTL);
  if (
    playerAccessTtl > 3600 ||
    playerRefreshTtl > 90 * 86400 ||
    playerRefreshTtl <= playerAccessTtl
  ) {
    throw new Error(
      'Invalid environment variables: PLAYER_JWT_ACCESS_TTL, PLAYER_JWT_REFRESH_TTL',
    );
  }
  const challengeTtl = ttlSeconds(value.PLAYER_LINK_CHALLENGE_TTL);
  if (challengeTtl < 60 || challengeTtl > 3600)
    throw new Error('Invalid environment variables: PLAYER_LINK_CHALLENGE_TTL');
  const inviteTtl = ttlSeconds(value.PLAYER_GROUP_INVITE_TTL);
  if (inviteTtl < 60 || inviteTtl > 86400)
    throw new Error('Invalid environment variables: PLAYER_GROUP_INVITE_TTL');
  const guildInviteTtl = ttlSeconds(value.PLAYER_GUILD_INVITE_TTL);
  if (guildInviteTtl < 3600 || guildInviteTtl > 30 * 86400)
    throw new Error('Invalid environment variables: PLAYER_GUILD_INVITE_TTL');
  return {
    playerCharacters: { challengeTtl },
    playerGroups: { inviteTtl },
    playerGuilds: { inviteTtl: guildInviteTtl },
    realtime: { authTimeoutMs: value.REALTIME_AUTH_TIMEOUT_MS },
    playerAuth: {
      accessSecret: value.PLAYER_JWT_ACCESS_SECRET || testPlayerAccessSecret,
      refreshSecret: value.PLAYER_JWT_REFRESH_SECRET || testPlayerRefreshSecret,
      accessTtl: playerAccessTtl,
      refreshTtl: playerRefreshTtl,
      rateLimitPerMinute: value.PLAYER_AUTH_RATE_LIMIT_PER_MINUTE,
      discord: discordConfig(value),
    },
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

// Discord is optional; partial credentials or malformed redirect URIs are
// configuration errors. Redirect URIs form an exact-match allowlist.
function discordConfig(
  value: Environment,
): ApplicationConfig['playerAuth']['discord'] {
  const clientId = value.DISCORD_CLIENT_ID ?? '';
  const clientSecret = value.DISCORD_CLIENT_SECRET ?? '';
  const redirectUris = (value.DISCORD_REDIRECT_URIS ?? '')
    .split(',')
    .map((uri) => uri.trim())
    .filter(Boolean);
  if (!clientId && !clientSecret && !redirectUris.length) return null;
  const valid = (uri: string) => {
    try {
      const url = new URL(uri);
      return !url.hash && !url.username && !url.password;
    } catch {
      return false;
    }
  };
  if (
    !clientId ||
    !clientSecret ||
    !redirectUris.length ||
    !redirectUris.every(valid)
  )
    throw new Error(
      'Invalid environment variables: DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URIS',
    );
  return { clientId, clientSecret, redirectUris };
}

// Used by the standalone TypeORM CLI. Runtime variables override .env,
// matching ConfigModule's precedence without modifying process.env.
export function loadEnvironment(): ApplicationConfig {
  const path = resolve('.env');
  const file = existsSync(path) ? parse(readFileSync(path)) : {};
  return validateEnvironment({ ...file, ...process.env });
}
