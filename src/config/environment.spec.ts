import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { validateEnvironment } from './environment.js';

const example: Record<string, string> = {
  ...parse(readFileSync('.env.example')),
  JWT_ACCESS_SECRET: randomBytes(48).toString('hex'),
  JWT_REFRESH_SECRET: randomBytes(48).toString('hex'),
  PLAYER_JWT_ACCESS_SECRET: randomBytes(48).toString('hex'),
  PLAYER_JWT_REFRESH_SECRET: randomBytes(48).toString('hex'),
  // Production requires an explicit database TLS decision (12.2).
  DB_SSL_MODE: 'disable',
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
      pendingTimeoutMs: 60000,
      workerIntervalMs: 500,
    });
  });
  it.each([
    'GAME_BRIDGE_HEARTBEAT_TIMEOUT_MS',
    'GAME_COMMAND_ACK_TIMEOUT_MS',
    'GAME_COMMAND_EXECUTION_TIMEOUT_MS',
    'GAME_COMMAND_MAX_DISPATCH_ATTEMPTS',
    'GAME_COMMAND_PENDING_TIMEOUT_MS',
    'GAME_COMMAND_WORKER_INTERVAL_MS',
  ])('rejects invalid %s', (field) => {
    for (const value of ['0', '-1', '1.5', 'abc', 'Infinity', '999999999999'])
      expect(() => validateEnvironment({ ...example, [field]: value })).toThrow(
        field,
      );
  });
});

describe('Player auth environment validation', () => {
  it('provides separate defaults and leaves Discord disabled when unset', () => {
    const { playerAuth, jwt } = validateEnvironment(example);
    expect(playerAuth).toMatchObject({
      accessSecret: example.PLAYER_JWT_ACCESS_SECRET,
      refreshSecret: example.PLAYER_JWT_REFRESH_SECRET,
      accessTtl: 900,
      refreshTtl: 30 * 86400,
      rateLimitPerMinute: 20,
      discord: null,
    });
    expect([jwt.accessSecret, jwt.refreshSecret]).not.toContain(
      playerAuth.accessSecret,
    );
  });
  describe.each(['development', 'production'])('%s', (nodeEnv) => {
    it.each(['PLAYER_JWT_ACCESS_SECRET', 'PLAYER_JWT_REFRESH_SECRET'])(
      'requires %s without falling back to staff secrets',
      (field) => {
        for (const value of [undefined, '', 'short', ' '.repeat(40)])
          expect(() =>
            validateEnvironment({
              ...example,
              NODE_ENV: nodeEnv,
              [field]: value,
            }),
          ).toThrow(field);
        for (const staff of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'])
          expect(() =>
            validateEnvironment({
              ...example,
              NODE_ENV: nodeEnv,
              [field]: example[staff],
            }),
          ).toThrow(field);
      },
    );
  });
  it('rejects shared player secrets and unsafe player TTLs', () => {
    expect(() =>
      validateEnvironment({
        ...example,
        PLAYER_JWT_REFRESH_SECRET: example.PLAYER_JWT_ACCESS_SECRET,
      }),
    ).toThrow('PLAYER_JWT_REFRESH_SECRET');
    for (const [field, value] of [
      ['PLAYER_JWT_ACCESS_TTL', '2h'],
      ['PLAYER_JWT_REFRESH_TTL', '91d'],
      ['PLAYER_JWT_REFRESH_TTL', '10m'],
      ['PLAYER_AUTH_RATE_LIMIT_PER_MINUTE', '0'],
    ])
      expect(() => validateEnvironment({ ...example, [field]: value })).toThrow(
        field,
      );
  });
  it('uses distinct ephemeral player secrets only in test', () => {
    const { playerAuth, jwt } = validateEnvironment({
      ...example,
      NODE_ENV: 'test',
      JWT_ACCESS_SECRET: '',
      JWT_REFRESH_SECRET: '',
      PLAYER_JWT_ACCESS_SECRET: '',
      PLAYER_JWT_REFRESH_SECRET: '',
    });
    const secrets = [
      playerAuth.accessSecret,
      playerAuth.refreshSecret,
      jwt.accessSecret,
      jwt.refreshSecret,
    ];
    expect(new Set(secrets).size).toBe(4);
  });
  it('requires complete Discord credentials and an exact redirect allowlist', () => {
    const discord = {
      DISCORD_CLIENT_ID: '1234',
      DISCORD_CLIENT_SECRET: 'client-secret-value',
      DISCORD_REDIRECT_URIS:
        'http://127.0.0.1:53682/callback, https://example.test/cb',
    };
    expect(
      validateEnvironment({ ...example, ...discord }).playerAuth.discord,
    ).toEqual({
      clientId: '1234',
      clientSecret: 'client-secret-value',
      redirectUris: [
        'http://127.0.0.1:53682/callback',
        'https://example.test/cb',
      ],
    });
    for (const partial of [
      { DISCORD_CLIENT_SECRET: '' },
      { DISCORD_CLIENT_ID: '' },
      { DISCORD_REDIRECT_URIS: '' },
      { DISCORD_REDIRECT_URIS: 'not a url' },
      { DISCORD_REDIRECT_URIS: 'https://example.test/cb#fragment' },
    ]) {
      const validate = () =>
        validateEnvironment({ ...example, ...discord, ...partial });
      expect(validate).toThrow('DISCORD_CLIENT_SECRET');
      expect(validate).not.toThrow('client-secret-value');
    }
  });
});

describe('Player character environment validation', () => {
  it('defaults the link challenge to 10 minutes within 1m–1h bounds', () => {
    expect(validateEnvironment(example).playerCharacters).toEqual({
      challengeTtl: 600,
    });
    for (const value of ['30s', '2h', '0m', 'x'])
      expect(() =>
        validateEnvironment({ ...example, PLAYER_LINK_CHALLENGE_TTL: value }),
      ).toThrow('PLAYER_LINK_CHALLENGE_TTL');
  });
});

describe('Player groups and realtime environment validation', () => {
  it('defaults the invite TTL to 10 minutes and the AUTH timeout to 5 seconds', () => {
    const config = validateEnvironment(example);
    expect(config.playerGroups).toEqual({ inviteTtl: 600 });
    expect(config.realtime).toEqual({ authTimeoutMs: 5000 });
    for (const value of ['30s', '2d'])
      expect(() =>
        validateEnvironment({ ...example, PLAYER_GROUP_INVITE_TTL: value }),
      ).toThrow('PLAYER_GROUP_INVITE_TTL');
    for (const value of ['50', '60001', 'x'])
      expect(() =>
        validateEnvironment({ ...example, REALTIME_AUTH_TIMEOUT_MS: value }),
      ).toThrow('REALTIME_AUTH_TIMEOUT_MS');
  });
});

describe('Player guilds environment validation', () => {
  it('defaults the guild invite TTL to 7 days within 1 hour to 30 days', () => {
    expect(validateEnvironment(example).playerGuilds).toEqual({
      inviteTtl: 7 * 86400,
    });
    expect(
      validateEnvironment({ ...example, PLAYER_GUILD_INVITE_TTL: '1h' })
        .playerGuilds.inviteTtl,
    ).toBe(3600);
    for (const value of ['59m', '31d', '0d', 'x'])
      expect(() =>
        validateEnvironment({ ...example, PLAYER_GUILD_INVITE_TTL: value }),
      ).toThrow('PLAYER_GUILD_INVITE_TTL');
  });
});

describe('Player chat environment validation', () => {
  it('defaults retention to 7 days and the send limit to 5 per 10 seconds', () => {
    expect(validateEnvironment(example).playerChat).toEqual({
      retention: 7 * 86400,
      rateLimitCount: 5,
      rateLimitWindow: 10,
    });
    expect(
      validateEnvironment({
        ...example,
        PLAYER_CHAT_RETENTION: '1d',
        PLAYER_CHAT_RATE_LIMIT_COUNT: '20',
        PLAYER_CHAT_RATE_LIMIT_WINDOW: '1m',
      }).playerChat,
    ).toEqual({ retention: 86400, rateLimitCount: 20, rateLimitWindow: 60 });
    for (const value of ['23h', '31d', '0d', 'x'])
      expect(() =>
        validateEnvironment({ ...example, PLAYER_CHAT_RETENTION: value }),
      ).toThrow('PLAYER_CHAT_RETENTION');
    for (const value of ['0', '101', '1.5', 'x'])
      expect(() =>
        validateEnvironment({
          ...example,
          PLAYER_CHAT_RATE_LIMIT_COUNT: value,
        }),
      ).toThrow('PLAYER_CHAT_RATE_LIMIT_COUNT');
    for (const value of ['0s', '2h', 'x'])
      expect(() =>
        validateEnvironment({
          ...example,
          PLAYER_CHAT_RATE_LIMIT_WINDOW: value,
        }),
      ).toThrow('PLAYER_CHAT_RATE_LIMIT_WINDOW');
  });
});

describe('Host Agent environment validation', () => {
  it('defaults to a 5s HELLO window, 10s heartbeat and 30s timeout', () => {
    expect(validateEnvironment(example).agent).toEqual({
      authTimeoutMs: 5000,
      heartbeatIntervalMs: 10000,
      heartbeatTimeoutMs: 30000,
      maxInFlightCommands: 32,
      messageRateLimitCount: 200,
      messageRateLimitWindowMs: 10000,
      workPushIntervalMs: 2000,
    });
    expect(validateEnvironment(example).vipDelivery).toEqual({
      workerIntervalMs: 2000,
    });
    expect(
      validateEnvironment({
        ...example,
        AGENT_HEARTBEAT_INTERVAL: '1s',
        AGENT_HEARTBEAT_TIMEOUT: '3s',
      }).agent,
    ).toMatchObject({ heartbeatIntervalMs: 1000, heartbeatTimeoutMs: 3000 });
  });
  it.each([
    { AGENT_HEARTBEAT_INTERVAL: '30s', AGENT_HEARTBEAT_TIMEOUT: '30s' },
    { AGENT_HEARTBEAT_INTERVAL: '10s', AGENT_HEARTBEAT_TIMEOUT: '5s' },
    // Never beyond the Game Bridge session timeout (30s by default).
    { AGENT_HEARTBEAT_TIMEOUT: '31s' },
    { AGENT_HEARTBEAT_INTERVAL: '10' },
    { AGENT_AUTH_TIMEOUT_MS: '50' },
    { AGENT_AUTH_TIMEOUT_MS: '60001' },
    { AGENT_MAX_IN_FLIGHT_COMMANDS: '0' },
    { AGENT_MESSAGE_RATE_LIMIT_COUNT: '9' },
    { AGENT_MESSAGE_RATE_LIMIT_WINDOW_MS: '99' },
    { AGENT_WORK_PUSH_INTERVAL_MS: '99' },
  ])('rejects %o', (override) =>
    expect(() => validateEnvironment({ ...example, ...override })).toThrow(
      /AGENT_/,
    ),
  );
});

describe('Server Control environment validation', () => {
  it('defaults to 30s pending, 10s delivery window, 5min result timeout', () => {
    expect(validateEnvironment(example).serverControl).toEqual({
      pendingTimeoutMs: 30000,
      deliveryWindowMs: 10000,
      resultTimeoutMs: 300000,
      workerIntervalMs: 1000,
    });
  });
  it.each([
    { SERVER_CONTROL_PENDING_TIMEOUT_MS: '499' },
    { SERVER_CONTROL_DELIVERY_WINDOW_MS: '99' },
    { SERVER_CONTROL_RESULT_TIMEOUT_MS: '3600001' },
    { SERVER_CONTROL_WORKER_INTERVAL_MS: '49' },
    // The result deadline never precedes the end of the delivery window.
    {
      SERVER_CONTROL_DELIVERY_WINDOW_MS: '10000',
      SERVER_CONTROL_RESULT_TIMEOUT_MS: '10000',
    },
  ])('rejects %o', (override) =>
    expect(() => validateEnvironment({ ...example, ...override })).toThrow(
      /SERVER_CONTROL_/,
    ),
  );
});

describe('Security environment (12.1)', () => {
  it('ships conservative abuse-control defaults and production-safe toggles', () => {
    const config = validateEnvironment(example);
    expect(config.security).toEqual({
      trustProxy: 'false',
      corsOrigins: [],
      realtimeOrigins: [],
      swaggerEnabled: true,
      hstsMaxAgeSeconds: 0,
      refreshReuseGraceMs: 10000,
      staffLogin: {
        windowMs: 900000,
        perIp: 30,
        perUsername: 10,
        maxConcurrent: 4,
      },
      staffRefresh: { windowMs: 60000, perIp: 60, perSession: 10 },
      realtime: {
        maxConnections: 10000,
        maxPendingConnections: 500,
        maxConnectionsPerIdentity: 5,
        connectsPerIpPerMinute: 60,
      },
      agent: {
        maxPendingConnections: 32,
        maxConcurrentAuth: 8,
        connectsPerIpPerMinute: 30,
        authFailuresPerIpPerMinute: 10,
      },
      playerLimits: { characterQueries: 30, marketMutations: 30 },
    });
    expect(
      validateEnvironment({ ...example, NODE_ENV: 'production' }).security
        .swaggerEnabled,
    ).toBe(false);
    expect(
      validateEnvironment({
        ...example,
        NODE_ENV: 'production',
        SWAGGER_ENABLED: 'true',
      }).security.swaggerEnabled,
    ).toBe(true);
  });
  it('accepts explicit proxy trust and exact origins, and refuses unsafe values', () => {
    for (const value of [
      'false',
      '1',
      '2',
      'loopback',
      'loopback, 10.0.0.0/8, ::1',
      '192.168.1.10',
    ])
      expect(() =>
        validateEnvironment({ ...example, TRUST_PROXY: value }),
      ).not.toThrow();
    for (const value of ['true', '*', '10.0.0.0/33', 'proxy.local', '99'])
      expect(() =>
        validateEnvironment({ ...example, TRUST_PROXY: value }),
      ).toThrow('TRUST_PROXY');
    const config = validateEnvironment({
      ...example,
      CORS_ORIGINS: 'https://admin.example.com, http://localhost:5173',
    });
    expect(config.security.corsOrigins).toEqual([
      'https://admin.example.com',
      'http://localhost:5173',
    ]);
    expect(config.security.realtimeOrigins).toEqual(
      config.security.corsOrigins,
    );
    for (const value of [
      '*',
      'https://admin.example.com/',
      'admin.example.com',
      'https://a.com/path',
    ])
      expect(() =>
        validateEnvironment({ ...example, CORS_ORIGINS: value }),
      ).toThrow('CORS_ORIGINS');
  });
});

describe('Deployment and database environment (12.2)', () => {
  it('defaults to one replica, a lock only in production and bounded pools', () => {
    const dev = validateEnvironment(example);
    expect(dev.deployment).toEqual({
      topology: 'SINGLE',
      singleInstanceLock: false,
      shutdownTimeoutMs: 8000,
    });
    expect(dev.database).toMatchObject({
      ssl: { mode: 'disable' },
      poolMax: 10,
      poolIdleTimeoutMs: 30000,
      connectTimeoutMs: 5000,
      queryTimeoutMs: 5000,
      statementTimeoutMs: 10000,
      migration: { statementTimeoutMs: 600000, lockTimeoutMs: 10000 },
    });
    const production = validateEnvironment({
      ...example,
      NODE_ENV: 'production',
    });
    expect(production.deployment.singleInstanceLock).toBe(true);
  });
  it('accepts MULTI without the global lock, never as a silent SINGLE', () => {
    const multi = validateEnvironment({
      ...example,
      NODE_ENV: 'production',
      BACKEND_TOPOLOGY: 'multi',
    });
    expect(multi.deployment).toMatchObject({
      topology: 'MULTI',
      singleInstanceLock: false,
    });
    expect(multi.cluster).toEqual({
      busChannel: 'skyrim_admin_bus',
      busEventTtlMs: 60000,
      busReconnectMaxMs: 30000,
      cleanupIntervalMs: 60000,
      realtimeLeaseTtlMs: 60000,
      realtimeLeaseRenewMs: 20000,
    });
    expect(() =>
      validateEnvironment({
        ...example,
        BACKEND_TOPOLOGY: 'MULTI',
        SINGLE_INSTANCE_LOCK_ENABLED: 'true',
      }),
    ).toThrow('not allowed with BACKEND_TOPOLOGY=MULTI');
    for (const topology of ['CLUSTER', 'DUAL', ''])
      expect(() =>
        validateEnvironment({ ...example, BACKEND_TOPOLOGY: topology }),
      ).toThrow('BACKEND_TOPOLOGY');
    // Renewal must fit twice in the lease; no zero or absurd lease.
    expect(() =>
      validateEnvironment({
        ...example,
        REALTIME_LEASE_TTL_MS: '30000',
        REALTIME_LEASE_RENEW_INTERVAL_MS: '20000',
      }),
    ).toThrow('REALTIME_LEASE_RENEW_INTERVAL_MS');
    for (const [name, value] of [
      ['REALTIME_LEASE_TTL_MS', '0'],
      ['REALTIME_LEASE_TTL_MS', '999999999'],
      ['CLUSTER_BUS_EVENT_TTL_MS', '0'],
      ['CLUSTER_BUS_CHANNEL', 'Bad-Channel;'],
    ])
      expect(() => validateEnvironment({ ...example, [name]: value })).toThrow(
        name,
      );
  });
  it('refuses a disabled SINGLE lock or an implicit TLS mode in production', () => {
    expect(() =>
      validateEnvironment({
        ...example,
        NODE_ENV: 'production',
        SINGLE_INSTANCE_LOCK_ENABLED: 'false',
      }),
    ).toThrow('SINGLE_INSTANCE_LOCK_ENABLED');
    expect(() =>
      validateEnvironment({
        ...example,
        NODE_ENV: 'production',
        DB_SSL_MODE: undefined,
      }),
    ).toThrow('DB_SSL_MODE');
    expect(
      validateEnvironment({ ...example, SINGLE_INSTANCE_LOCK_ENABLED: 'true' })
        .deployment.singleInstanceLock,
    ).toBe(true);
  });
  it('validates TLS modes, the CA file and timeout relations without printing values', () => {
    for (const mode of ['disable', 'require', 'verify-full'])
      expect(
        validateEnvironment({ ...example, DB_SSL_MODE: mode }).database.ssl
          .mode,
      ).toBe(mode);
    expect(() =>
      validateEnvironment({ ...example, DB_SSL_MODE: 'allow' }),
    ).toThrow('DB_SSL_MODE');
    expect(() =>
      validateEnvironment({
        ...example,
        DB_SSL_MODE: 'require',
        DB_SSL_CA_FILE: '.env.example',
      }),
    ).toThrow('DB_SSL_CA_FILE');
    expect(() =>
      validateEnvironment({
        ...example,
        DB_SSL_MODE: 'verify-full',
        DB_SSL_CA_FILE: '/nonexistent/secret-ca.pem',
      }),
    ).toThrow(/^Invalid environment variables: DB_SSL_CA_FILE$/);
    expect(
      validateEnvironment({
        ...example,
        DB_SSL_MODE: 'verify-full',
        DB_SSL_CA_FILE: '.env.example',
      }).database.ssl.ca,
    ).toContain('DB_HOST');
    expect(() =>
      validateEnvironment({
        ...example,
        DB_QUERY_TIMEOUT_MS: '20000',
        DB_STATEMENT_TIMEOUT_MS: '10000',
      }),
    ).toThrow('DB_QUERY_TIMEOUT_MS');
  });
});
