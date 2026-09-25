import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import Joi from 'joi';
import { parseTrustProxy } from '../common/net/client-ip.js';

export interface ApplicationConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  gameBridge: {
    heartbeatTimeoutMs: number;
    ackTimeoutMs: number;
    executionTimeoutMs: number;
    maxDispatchAttempts: number;
    // Never-reserved PENDING commands fail after this (11.2).
    pendingTimeoutMs: number;
    workerIntervalMs: number;
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
  // Retention and the per player + character send limit, in seconds.
  playerChat: {
    retention: number;
    rateLimitCount: number;
    rateLimitWindow: number;
  };
  realtime: { authTimeoutMs: number };
  // Server Control over the Host Agent (11.3), at-most-once. The result
  // timeout always exceeds the delivery window.
  serverControl: {
    // Unclaimed PENDING (never sent) fails after this.
    pendingTimeoutMs: number;
    // notAfter = claim + window; the Agent refuses later execution.
    deliveryWindowMs: number;
    // Claimed without a result after this: UNCERTAIN, never resent.
    resultTimeoutMs: number;
    workerIntervalMs: number;
  };
  // Host Agent transport (11.1). The heartbeat timeout never exceeds the Game
  // Bridge connection timeout, so a live socket always has a healthy session.
  agent: {
    authTimeoutMs: number;
    heartbeatIntervalMs: number;
    heartbeatTimeoutMs: number;
    // DB-counted GameCommands in flight per server (11.2).
    maxInFlightCommands: number;
    // Authenticated frames per session per window (in memory, 11.2).
    messageRateLimitCount: number;
    messageRateLimitWindowMs: number;
    // Best-effort push of new work to connected Agents (11.4).
    workPushIntervalMs: number;
  };
  // VIP CHARACTER reward delivery worker (11.4).
  vipDelivery: { workerIntervalMs: number };
  // Abuse controls and HTTP/WebSocket boundary (12.1). Limits are per process
  // (single replica until 12.5); the defaults are a conservative baseline to
  // be tuned by the load tests of 12.6.
  security: {
    // Raw TRUST_PROXY value, compiled by src/common/net/client-ip.ts.
    trustProxy: string;
    // Exact browser origins allowed by CORS and by the realtime upgrade.
    corsOrigins: string[];
    realtimeOrigins: string[];
    swaggerEnabled: boolean;
    hstsMaxAgeSeconds: number;
    // A rotated refresh token presented within this window after the last
    // rotation is a stale concurrent refresh (401, session kept); later it
    // is a replay and the session is revoked. 0 = strict.
    refreshReuseGraceMs: number;
    staffLogin: {
      windowMs: number;
      perIp: number;
      perUsername: number;
      maxConcurrent: number;
    };
    staffRefresh: { windowMs: number; perIp: number; perSession: number };
    realtime: {
      maxConnections: number;
      maxPendingConnections: number;
      maxConnectionsPerIdentity: number;
      connectsPerIpPerMinute: number;
    };
    agent: {
      maxPendingConnections: number;
      maxConcurrentAuth: number;
      connectsPerIpPerMinute: number;
      authFailuresPerIpPerMinute: number;
    };
    // Per authenticated player, per minute.
    playerLimits: { characterQueries: number; marketMutations: number };
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
  GAME_COMMAND_PENDING_TIMEOUT_MS: number;
  GAME_COMMAND_WORKER_INTERVAL_MS: number;
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
  PLAYER_CHAT_RETENTION: string;
  PLAYER_CHAT_RATE_LIMIT_COUNT: number;
  PLAYER_CHAT_RATE_LIMIT_WINDOW: string;
  REALTIME_AUTH_TIMEOUT_MS: number;
  SERVER_CONTROL_PENDING_TIMEOUT_MS: number;
  AGENT_WORK_PUSH_INTERVAL_MS: number;
  VIP_DELIVERY_WORKER_INTERVAL_MS: number;
  SERVER_CONTROL_DELIVERY_WINDOW_MS: number;
  SERVER_CONTROL_RESULT_TIMEOUT_MS: number;
  SERVER_CONTROL_WORKER_INTERVAL_MS: number;
  AGENT_AUTH_TIMEOUT_MS: number;
  AGENT_HEARTBEAT_INTERVAL: string;
  AGENT_HEARTBEAT_TIMEOUT: string;
  AGENT_MAX_IN_FLIGHT_COMMANDS: number;
  AGENT_MESSAGE_RATE_LIMIT_COUNT: number;
  AGENT_MESSAGE_RATE_LIMIT_WINDOW_MS: number;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  DISCORD_REDIRECT_URIS?: string;
  BOOTSTRAP_COORDINATOR_USERNAME?: string;
  BOOTSTRAP_COORDINATOR_DISPLAY_NAME?: string;
  BOOTSTRAP_COORDINATOR_PASSWORD?: string;
  TRUST_PROXY: string;
  CORS_ORIGINS?: string;
  REALTIME_ALLOWED_ORIGINS?: string;
  SWAGGER_ENABLED?: boolean;
  SECURITY_HSTS_MAX_AGE_SECONDS: number;
  AUTH_REFRESH_REUSE_GRACE_MS: number;
  STAFF_LOGIN_RATE_LIMIT_WINDOW: string;
  STAFF_LOGIN_RATE_LIMIT_PER_IP: number;
  STAFF_LOGIN_RATE_LIMIT_PER_USERNAME: number;
  STAFF_LOGIN_MAX_CONCURRENT: number;
  STAFF_REFRESH_RATE_LIMIT_WINDOW: string;
  STAFF_REFRESH_RATE_LIMIT_PER_IP: number;
  STAFF_REFRESH_RATE_LIMIT_PER_SESSION: number;
  REALTIME_MAX_CONNECTIONS: number;
  REALTIME_MAX_PENDING_CONNECTIONS: number;
  REALTIME_MAX_CONNECTIONS_PER_IDENTITY: number;
  REALTIME_CONNECT_RATE_LIMIT_PER_MINUTE: number;
  AGENT_MAX_PENDING_CONNECTIONS: number;
  AGENT_MAX_CONCURRENT_AUTH: number;
  AGENT_CONNECT_RATE_LIMIT_PER_MINUTE: number;
  AGENT_AUTH_FAILURE_LIMIT_PER_MINUTE: number;
  PLAYER_CHARACTER_QUERY_RATE_LIMIT_PER_MINUTE: number;
  PLAYER_MARKET_MUTATION_RATE_LIMIT_PER_MINUTE: number;
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
const count = (min: number, max: number, fallback: number) =>
  Joi.number().integer().min(min).max(max).default(fallback);
const list = (raw?: string) =>
  (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
// Exact origins only (scheme://host[:port]); never a wildcard or a path.
function origins(raw: string | undefined, name: string): string[] {
  const values = list(raw);
  for (const value of values) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`Invalid environment variables: ${name}`);
    }
    if (url.origin !== value)
      throw new Error(`Invalid environment variables: ${name}`);
  }
  return values;
}
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
  GAME_COMMAND_PENDING_TIMEOUT_MS: Joi.number()
    .integer()
    .min(1000)
    .max(86400000)
    .default(60000),
  GAME_COMMAND_WORKER_INTERVAL_MS: Joi.number()
    .integer()
    .min(50)
    .max(60000)
    .default(500),
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
  PLAYER_CHAT_RETENTION: ttl('7d'),
  PLAYER_CHAT_RATE_LIMIT_COUNT: Joi.number()
    .integer()
    .min(1)
    .max(100)
    .default(5),
  PLAYER_CHAT_RATE_LIMIT_WINDOW: ttl('10s'),
  REALTIME_AUTH_TIMEOUT_MS: Joi.number()
    .integer()
    .min(100)
    .max(60000)
    .default(5000),
  AGENT_WORK_PUSH_INTERVAL_MS: Joi.number()
    .integer()
    .min(100)
    .max(60000)
    .default(2000),
  VIP_DELIVERY_WORKER_INTERVAL_MS: Joi.number()
    .integer()
    .min(50)
    .max(60000)
    .default(2000),
  SERVER_CONTROL_PENDING_TIMEOUT_MS: Joi.number()
    .integer()
    .min(500)
    .max(3600000)
    .default(30000),
  SERVER_CONTROL_DELIVERY_WINDOW_MS: Joi.number()
    .integer()
    .min(100)
    .max(600000)
    .default(10000),
  SERVER_CONTROL_RESULT_TIMEOUT_MS: Joi.number()
    .integer()
    .min(500)
    .max(3600000)
    .default(300000),
  SERVER_CONTROL_WORKER_INTERVAL_MS: Joi.number()
    .integer()
    .min(50)
    .max(60000)
    .default(1000),
  AGENT_AUTH_TIMEOUT_MS: Joi.number()
    .integer()
    .min(100)
    .max(60000)
    .default(5000),
  AGENT_HEARTBEAT_INTERVAL: ttl('10s'),
  AGENT_HEARTBEAT_TIMEOUT: ttl('30s'),
  AGENT_MAX_IN_FLIGHT_COMMANDS: Joi.number()
    .integer()
    .min(1)
    .max(1000)
    .default(32),
  AGENT_MESSAGE_RATE_LIMIT_COUNT: Joi.number()
    .integer()
    .min(10)
    .max(100000)
    .default(200),
  AGENT_MESSAGE_RATE_LIMIT_WINDOW_MS: Joi.number()
    .integer()
    .min(100)
    .max(3600000)
    .default(10000),
  DISCORD_CLIENT_ID: Joi.string().trim().allow('').max(128),
  DISCORD_CLIENT_SECRET: Joi.string().allow('').max(256),
  DISCORD_REDIRECT_URIS: Joi.string().allow('').max(4096),
  BOOTSTRAP_COORDINATOR_USERNAME: Joi.string().allow(''),
  BOOTSTRAP_COORDINATOR_DISPLAY_NAME: Joi.string().allow(''),
  BOOTSTRAP_COORDINATOR_PASSWORD: Joi.string().allow(''),
  // Proxy trust is explicit: false (default), a hop count, or a
  // comma-separated list of loopback/linklocal/uniquelocal, IPs and CIDRs.
  TRUST_PROXY: Joi.string().trim().max(1024).default('false'),
  CORS_ORIGINS: Joi.string().allow('').max(4096),
  REALTIME_ALLOWED_ORIGINS: Joi.string().allow('').max(4096),
  SWAGGER_ENABLED: Joi.boolean(),
  SECURITY_HSTS_MAX_AGE_SECONDS: count(0, 63072000, 0),
  AUTH_REFRESH_REUSE_GRACE_MS: count(0, 60000, 10000),
  STAFF_LOGIN_RATE_LIMIT_WINDOW: ttl('15m'),
  STAFF_LOGIN_RATE_LIMIT_PER_IP: count(1, 10000, 30),
  STAFF_LOGIN_RATE_LIMIT_PER_USERNAME: count(1, 10000, 10),
  STAFF_LOGIN_MAX_CONCURRENT: count(1, 64, 4),
  STAFF_REFRESH_RATE_LIMIT_WINDOW: ttl('1m'),
  STAFF_REFRESH_RATE_LIMIT_PER_IP: count(1, 100000, 60),
  STAFF_REFRESH_RATE_LIMIT_PER_SESSION: count(1, 10000, 10),
  REALTIME_MAX_CONNECTIONS: count(1, 1000000, 10000),
  REALTIME_MAX_PENDING_CONNECTIONS: count(1, 100000, 500),
  REALTIME_MAX_CONNECTIONS_PER_IDENTITY: count(1, 100, 5),
  REALTIME_CONNECT_RATE_LIMIT_PER_MINUTE: count(1, 100000, 60),
  AGENT_MAX_PENDING_CONNECTIONS: count(1, 10000, 32),
  AGENT_MAX_CONCURRENT_AUTH: count(1, 1000, 8),
  AGENT_CONNECT_RATE_LIMIT_PER_MINUTE: count(1, 100000, 30),
  AGENT_AUTH_FAILURE_LIMIT_PER_MINUTE: count(1, 10000, 10),
  PLAYER_CHARACTER_QUERY_RATE_LIMIT_PER_MINUTE: count(1, 10000, 30),
  PLAYER_MARKET_MUTATION_RATE_LIMIT_PER_MINUTE: count(1, 10000, 30),
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
  const chatRetention = ttlSeconds(value.PLAYER_CHAT_RETENTION);
  if (chatRetention < 86400 || chatRetention > 30 * 86400)
    throw new Error('Invalid environment variables: PLAYER_CHAT_RETENTION');
  const chatWindow = ttlSeconds(value.PLAYER_CHAT_RATE_LIMIT_WINDOW);
  if (chatWindow > 3600)
    throw new Error(
      'Invalid environment variables: PLAYER_CHAT_RATE_LIMIT_WINDOW',
    );
  const agentInterval = ttlSeconds(value.AGENT_HEARTBEAT_INTERVAL) * 1000;
  const agentTimeout = ttlSeconds(value.AGENT_HEARTBEAT_TIMEOUT) * 1000;
  if (
    agentInterval >= agentTimeout ||
    agentTimeout > 3600000 ||
    agentTimeout > value.GAME_BRIDGE_HEARTBEAT_TIMEOUT_MS
  )
    throw new Error(
      'Invalid environment variables: AGENT_HEARTBEAT_INTERVAL, AGENT_HEARTBEAT_TIMEOUT',
    );
  if (
    value.SERVER_CONTROL_RESULT_TIMEOUT_MS <=
    value.SERVER_CONTROL_DELIVERY_WINDOW_MS
  )
    throw new Error(
      'Invalid environment variables: SERVER_CONTROL_RESULT_TIMEOUT_MS, SERVER_CONTROL_DELIVERY_WINDOW_MS',
    );
  try {
    parseTrustProxy(value.TRUST_PROXY);
  } catch {
    throw new Error('Invalid environment variables: TRUST_PROXY');
  }
  const corsOrigins = origins(value.CORS_ORIGINS, 'CORS_ORIGINS');
  const staffLoginWindow = ttlSeconds(value.STAFF_LOGIN_RATE_LIMIT_WINDOW);
  const staffRefreshWindow = ttlSeconds(value.STAFF_REFRESH_RATE_LIMIT_WINDOW);
  if (staffLoginWindow > 86400 || staffRefreshWindow > 3600)
    throw new Error(
      'Invalid environment variables: STAFF_LOGIN_RATE_LIMIT_WINDOW, STAFF_REFRESH_RATE_LIMIT_WINDOW',
    );
  return {
    security: {
      trustProxy: value.TRUST_PROXY,
      corsOrigins,
      realtimeOrigins:
        value.REALTIME_ALLOWED_ORIGINS === undefined
          ? corsOrigins
          : origins(value.REALTIME_ALLOWED_ORIGINS, 'REALTIME_ALLOWED_ORIGINS'),
      swaggerEnabled: value.SWAGGER_ENABLED ?? value.NODE_ENV !== 'production',
      hstsMaxAgeSeconds: value.SECURITY_HSTS_MAX_AGE_SECONDS,
      refreshReuseGraceMs: value.AUTH_REFRESH_REUSE_GRACE_MS,
      staffLogin: {
        windowMs: staffLoginWindow * 1000,
        perIp: value.STAFF_LOGIN_RATE_LIMIT_PER_IP,
        perUsername: value.STAFF_LOGIN_RATE_LIMIT_PER_USERNAME,
        maxConcurrent: value.STAFF_LOGIN_MAX_CONCURRENT,
      },
      staffRefresh: {
        windowMs: staffRefreshWindow * 1000,
        perIp: value.STAFF_REFRESH_RATE_LIMIT_PER_IP,
        perSession: value.STAFF_REFRESH_RATE_LIMIT_PER_SESSION,
      },
      realtime: {
        maxConnections: value.REALTIME_MAX_CONNECTIONS,
        maxPendingConnections: value.REALTIME_MAX_PENDING_CONNECTIONS,
        maxConnectionsPerIdentity: value.REALTIME_MAX_CONNECTIONS_PER_IDENTITY,
        connectsPerIpPerMinute: value.REALTIME_CONNECT_RATE_LIMIT_PER_MINUTE,
      },
      agent: {
        maxPendingConnections: value.AGENT_MAX_PENDING_CONNECTIONS,
        maxConcurrentAuth: value.AGENT_MAX_CONCURRENT_AUTH,
        connectsPerIpPerMinute: value.AGENT_CONNECT_RATE_LIMIT_PER_MINUTE,
        authFailuresPerIpPerMinute: value.AGENT_AUTH_FAILURE_LIMIT_PER_MINUTE,
      },
      playerLimits: {
        characterQueries: value.PLAYER_CHARACTER_QUERY_RATE_LIMIT_PER_MINUTE,
        marketMutations: value.PLAYER_MARKET_MUTATION_RATE_LIMIT_PER_MINUTE,
      },
    },
    agent: {
      authTimeoutMs: value.AGENT_AUTH_TIMEOUT_MS,
      heartbeatIntervalMs: agentInterval,
      heartbeatTimeoutMs: agentTimeout,
      maxInFlightCommands: value.AGENT_MAX_IN_FLIGHT_COMMANDS,
      messageRateLimitCount: value.AGENT_MESSAGE_RATE_LIMIT_COUNT,
      messageRateLimitWindowMs: value.AGENT_MESSAGE_RATE_LIMIT_WINDOW_MS,
      workPushIntervalMs: value.AGENT_WORK_PUSH_INTERVAL_MS,
    },
    vipDelivery: { workerIntervalMs: value.VIP_DELIVERY_WORKER_INTERVAL_MS },
    playerCharacters: { challengeTtl },
    playerGroups: { inviteTtl },
    playerGuilds: { inviteTtl: guildInviteTtl },
    playerChat: {
      retention: chatRetention,
      rateLimitCount: value.PLAYER_CHAT_RATE_LIMIT_COUNT,
      rateLimitWindow: chatWindow,
    },
    realtime: { authTimeoutMs: value.REALTIME_AUTH_TIMEOUT_MS },
    serverControl: {
      pendingTimeoutMs: value.SERVER_CONTROL_PENDING_TIMEOUT_MS,
      deliveryWindowMs: value.SERVER_CONTROL_DELIVERY_WINDOW_MS,
      resultTimeoutMs: value.SERVER_CONTROL_RESULT_TIMEOUT_MS,
      workerIntervalMs: value.SERVER_CONTROL_WORKER_INTERVAL_MS,
    },
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
      pendingTimeoutMs: value.GAME_COMMAND_PENDING_TIMEOUT_MS,
      workerIntervalMs: value.GAME_COMMAND_WORKER_INTERVAL_MS,
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
