import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { DataSource } from 'typeorm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { WebSocket as WsClient } from 'ws';
import { compiledDatabaseArtifacts } from './compiled-database.js';
import { loadEnvironment } from '../src/config/environment.js';
import { createDatabaseOptions } from '../src/database/database.options.js';
import { setupApp } from '../src/setup-app.js';
import { AppExpressAdapter } from '../src/common/http/app-express.adapter.js';
import { PasswordService } from '../src/auth/password.service.js';
import { RateLimiter } from '../src/common/rate-limit/rate-limiter.js';
import { GameServerService } from '../src/game-bridge/game-server.service.js';
import type { GameServer } from '../src/game-bridge/entities/game-server.entity.js';
import { DiscordIdentityProvider } from '../src/player-auth/discord-identity.provider.js';
import { AgentSessionRegistry } from '../src/game-agent/agent-session.registry.js';
import { FakeDiscordProvider } from './support/fake-discord-provider.js';
import { decodeJwt } from 'jose';
import {
  connectionKey,
  RealtimeConnectionRegistry,
} from '../src/realtime/realtime-connection.registry.js';
import { FakeAgent } from './support/fake-agent.js';

// Abuse controls and fail-closed boundaries of 12.1, with tight limits.
// supertest and the sockets connect from 127.0.0.1, which this suite trusts
// as a proxy, so each scenario picks its own client IP via X-Forwarded-For.
const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;
const ALLOWED = 'https://admin.example.test';
const ENV = {
  TRUST_PROXY: 'loopback',
  CORS_ORIGINS: ALLOWED,
  SWAGGER_ENABLED: 'false',
  AUTH_REFRESH_REUSE_GRACE_MS: '300',
  STAFF_LOGIN_RATE_LIMIT_WINDOW: '2s',
  STAFF_LOGIN_RATE_LIMIT_PER_IP: '6',
  STAFF_LOGIN_RATE_LIMIT_PER_USERNAME: '3',
  STAFF_LOGIN_MAX_CONCURRENT: '2',
  STAFF_REFRESH_RATE_LIMIT_PER_IP: '20',
  STAFF_REFRESH_RATE_LIMIT_PER_SESSION: '8',
  REALTIME_AUTH_TIMEOUT_MS: '1500',
  REALTIME_CONNECT_RATE_LIMIT_PER_MINUTE: '5',
  REALTIME_MAX_CONNECTIONS_PER_IDENTITY: '2',
  REALTIME_MAX_PENDING_CONNECTIONS: '3',
  AGENT_AUTH_TIMEOUT_MS: '1500',
  AGENT_CONNECT_RATE_LIMIT_PER_MINUTE: '5',
  AGENT_AUTH_FAILURE_LIMIT_PER_MINUTE: '2',
  AGENT_MAX_PENDING_CONNECTIONS: '3',
  PLAYER_AUTH_RATE_LIMIT_PER_MINUTE: '1000',
  PLAYER_CHARACTER_QUERY_RATE_LIMIT_PER_MINUTE: '2',
  PLAYER_MARKET_MUTATION_RATE_LIMIT_PER_MINUTE: '2',
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let ipSeq = 10;
const nextIp = () => `198.51.100.${ipSeq++}`;
type Opened =
  | { kind: 'open'; ws: WsClient; messages: Record<string, unknown>[] }
  | { kind: 'refused'; status: number; retryAfter?: string };

describeDatabase('Security hardening and abuse controls (12.1)', () => {
  let admin: DataSource, database: DataSource, app: INestApplication<App>;
  let server: GameServer, url: string;
  const password = 'Security-Suite-Password-42';
  const discord = new FakeDiscordProvider();
  const schema = `security_test_${randomUUID().replaceAll('-', '')}`;
  const sockets: WsClient[] = [];
  const agents: FakeAgent[] = [];
  const http = () => request(app.getHttpServer());
  const login = (username: string, secret = password, ip = nextIp()) =>
    http()
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ username, password: secret });
  const staffRefresh = (token: string, ip = '203.0.113.200') =>
    http()
      .post('/api/v1/auth/refresh')
      .set('X-Forwarded-For', ip)
      .send({ refreshToken: token });
  const staffUser = async (username: string, role = 'COORDINATOR') => {
    await database.query(
      'INSERT INTO staff_users(username, display_name, password_hash, role_name) VALUES ($1, $1, $2, $3)',
      [username, await new PasswordService().hash(password), role],
    );
  };
  const playerLogin = async (subject = randomUUID()) => {
    const code = randomUUID();
    discord.codes.set(code, { subject, displayName: 'P' });
    return (
      await http()
        .post('/api/v1/player/auth/discord/exchange')
        .send({ authorizationCode: code, redirectUri: 'http://127.0.0.1/cb' })
        .expect(200)
    ).body as {
      accessToken: string;
      refreshToken: string;
      player: { id: string };
    };
  };
  const open = (
    path: string,
    headers: Record<string, string> = {},
  ): Promise<Opened> =>
    new Promise((resolve) => {
      const ws = new WsClient(`${url}${path}`, { headers });
      sockets.push(ws);
      const messages: Record<string, unknown>[] = [];
      ws.on('message', (raw) => messages.push(JSON.parse(String(raw))));
      ws.on('open', () => resolve({ kind: 'open', ws, messages }));
      ws.on('unexpected-response', (_req, res) =>
        resolve({
          kind: 'refused',
          status: res.statusCode ?? 0,
          retryAfter: res.headers['retry-after'] as string | undefined,
        }),
      );
      ws.on('error', () => undefined);
    });
  const closed = (ws: WsClient) =>
    new Promise<{ code: number; reason: string }>((resolve) =>
      ws.readyState === WsClient.CLOSED
        ? resolve({ code: 0, reason: '' })
        : ws.on('close', (code, reason) =>
            resolve({ code, reason: String(reason) }),
          ),
    );
  const until = async <T>(check: () => T | undefined, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = check();
      if (value) return value;
      if (Date.now() > deadline) throw new Error('Timed out');
      await pause(20);
    }
  };
  const realtime = async (
    surface: 'PLAYER' | 'STAFF',
    token: string,
    ip = nextIp(),
  ) => {
    const opened = await open('/api/v1/realtime', { 'X-Forwarded-For': ip });
    if (opened.kind !== 'open') throw new Error(`refused ${opened.status}`);
    opened.ws.send(JSON.stringify({ type: 'AUTH', surface, token }));
    return opened;
  };
  const auditRows = (action: string) =>
    database.query(
      'SELECT actor_type, actor_staff_id, actor_player_id, resource_type, resource_id, status_code, ip_address FROM audit_logs WHERE action = $1',
      [action],
    );

  beforeAll(async () => {
    Object.assign(process.env, ENV);
    const options = createDatabaseOptions(loadEnvironment());
    if (options.type !== 'postgres') throw new Error('PostgreSQL required');
    admin = new DataSource(options);
    await admin.initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    database = new DataSource({
      ...options,
      schema,
      ...(await compiledDatabaseArtifacts()),
      extra: { ...options.extra, options: `-c search_path=${schema},public` },
    });
    await database.initialize();
    expect(await database.runMigrations()).toHaveLength(26);
    const { AppModule } = await import('../src/app.module.js');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DataSource)
      .useValue(database)
      .overrideProvider(DiscordIdentityProvider)
      .useValue(discord)
      .compile();
    app = module.createNestApplication(new AppExpressAdapter());
    app.useLogger(false);
    setupApp(app);
    await app.listen(0, '127.0.0.1');
    const address = (
      app.getHttpServer() as unknown as Server
    ).address() as AddressInfo;
    url = `ws://127.0.0.1:${address.port}`;
    await staffUser('coordinator');
  }, 60000);
  beforeEach(async () => {
    app.get(RateLimiter).reset();
    server = await app
      .get(GameServerService)
      .register({ code: randomUUID(), name: 'Security' });
  });
  afterEach(async () => {
    for (const ws of sockets.splice(0))
      if (ws.readyState === WsClient.OPEN) ws.close();
    for (const agent of agents.splice(0)) await agent.close();
    for (let i = 0; i < 100 && app.get(AgentSessionRegistry).count(); i++)
      await pause(10);
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    for (const name of Object.keys(ENV)) delete process.env[name];
    await app?.close();
    if (database?.isInitialized) await database.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  it('throttles Staff login per username and per IP before Argon2, with a generic 429', async () => {
    const hashing = app.get(PasswordService);
    const verify = jest.spyOn(hashing, 'verify');
    const missing = jest.spyOn(hashing, 'verifyMissing');
    const ip = nextIp();
    // Existing account, wrong password: 3 attempts per username.
    for (let i = 0; i < 3; i++)
      expect(
        (await login('coordinator', 'wrong-password', ip).expect(401)).body
          .message,
      ).toBe('Invalid credentials');
    const limited = await login('coordinator', 'wrong-password', ip).expect(
      429,
    );
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.body).toMatchObject({
      statusCode: 429,
      message: 'Too many requests',
    });
    // Even the right password is refused while throttled: nothing leaks.
    const right = await login('coordinator', password, ip).expect(429);
    expect(right.body.message).toBe(limited.body.message);
    // Unknown accounts behave identically (same status and body).
    const unknown = 'nobody-here';
    expect((await login(unknown, 'x', ip).expect(401)).body.message).toBe(
      'Invalid credentials',
    );
    // 6 attempts counted for this IP: its bucket now refuses any username.
    await login('someone-else', 'x', ip).expect(429);
    // Argon2 ran once per admitted attempt only (3 + 1), never after a 429
    // (verifyMissing verifies against the cached dummy hash).
    expect(verify).toHaveBeenCalledTimes(4);
    expect(missing).toHaveBeenCalledTimes(1);
    // The account stays protected from other IPs by its username bucket.
    await login('coordinator', 'wrong-password', nextIp()).expect(429);
    const fresh = nextIp();
    await login(unknown, 'x', fresh).expect(401);
    // After the window the legitimate login works and resets its bucket.
    await pause(2100);
    await login('coordinator', password, fresh).expect(200);
    for (let i = 0; i < 3; i++)
      await login('coordinator', 'wrong-password', nextIp()).expect(401);
  });

  it('bounds concurrent Argon2 work: excess logins get 429, never 500', async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) => login(`user-${i}`, 'x', nextIp())),
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.every((s) => s === 401 || s === 429)).toBe(true);
    expect(statuses).toContain(429);
    expect(statuses).toContain(401);
    await pause(50);
    await login('coordinator', password, nextIp()).expect(200);
  });

  it('records the client IP from a trusted proxy chain, never the spoofed prefix', async () => {
    const response = await http()
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', '6.6.6.6, 198.51.100.250')
      .send({ username: 'coordinator', password })
      .expect(200);
    const [session] = await database.query(
      'SELECT ip_address FROM staff_sessions WHERE staff_user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [response.body.staff.id],
    );
    expect(session.ip_address).toBe('198.51.100.250');
    const [audit] = await database.query(
      "SELECT ip_address FROM audit_logs WHERE action = 'AUTH_LOGIN' ORDER BY created_at DESC LIMIT 1",
    );
    expect(audit.ip_address).toBe('198.51.100.250');
  });

  it('rotates Staff refresh tokens, tolerates a concurrent loser and revokes the session on replay', async () => {
    const first = (await login('coordinator').expect(200)).body;
    const other = (await login('coordinator').expect(200)).body;
    const second = (await staffRefresh(first.refreshToken).expect(200)).body;
    // Presented again right after rotation: a stale concurrent refresh.
    expect(
      (await staffRefresh(first.refreshToken).expect(401)).body.message,
    ).toBe('Invalid or expired session');
    const third = (await staffRefresh(second.refreshToken).expect(200)).body;
    expect(await auditRows('AUTH_REFRESH_REUSE_DETECTED')).toEqual([]);
    // Replayed after the grace window: reuse. This session only is revoked.
    await pause(400);
    const replay = await staffRefresh(first.refreshToken).expect(401);
    expect(replay.body.message).toBe('Invalid or expired session');
    await staffRefresh(third.refreshToken).expect(401);
    await http()
      .get('/api/v1/auth/me')
      .auth(third.accessToken, { type: 'bearer' })
      .expect(401);
    await http()
      .get('/api/v1/auth/me')
      .auth(other.accessToken, { type: 'bearer' })
      .expect(200);
    await staffRefresh(other.refreshToken).expect(200);
    const audits = await auditRows('AUTH_REFRESH_REUSE_DETECTED');
    expect(audits).toEqual([
      expect.objectContaining({
        actor_type: 'STAFF',
        actor_staff_id: first.staff.id,
        resource_type: 'STAFF_SESSION',
        status_code: 401,
        ip_address: '203.0.113.200',
      }),
    ]);
    // A revoked session stays revoked; no second Audit row.
    await staffRefresh(second.refreshToken).expect(401);
    expect(await auditRows('AUTH_REFRESH_REUSE_DETECTED')).toHaveLength(1);
    const [row] = await database.query(
      'SELECT refresh_token_hash, revoked_at FROM staff_sessions WHERE id = $1',
      [audits[0].resource_id],
    );
    expect(row.revoked_at).not.toBeNull();
    expect(row.refresh_token_hash).toMatch(/^[0-9a-f]{64}$/);
    for (const token of [first, second, third])
      expect(row.refresh_token_hash).not.toContain(token.refreshToken);
  });

  it('lets exactly one of two concurrent Staff refreshes rotate, without revoking the family', async () => {
    const session = (await login('coordinator').expect(200)).body;
    const before = (await auditRows('AUTH_REFRESH_REUSE_DETECTED')).length;
    const raced = await Promise.all([
      staffRefresh(session.refreshToken),
      staffRefresh(session.refreshToken),
    ]);
    expect(raced.map((r) => r.status).sort()).toEqual([200, 401]);
    const winner = raced.find((r) => r.status === 200)!.body;
    // One digest per session (no second active refresh), still usable.
    await staffRefresh(winner.refreshToken).expect(200);
    await http()
      .get('/api/v1/auth/me')
      .auth(winner.accessToken, { type: 'bearer' })
      .expect(200);
    expect(await auditRows('AUTH_REFRESH_REUSE_DETECTED')).toHaveLength(before);
  });

  it('throttles Staff refresh per IP and per session', async () => {
    const ip = nextIp();
    for (let i = 0; i < 20; i++)
      await staffRefresh('not-a-token', ip).expect(i < 20 ? 401 : 429);
    const limited = await staffRefresh('not-a-token', ip).expect(429);
    expect(limited.headers['retry-after']).toBeDefined();
    let current = (await login('coordinator').expect(200)).body.refreshToken;
    for (let i = 0; i < 8; i++)
      current = (await staffRefresh(current, nextIp()).expect(200)).body
        .refreshToken;
    await staffRefresh(current, nextIp()).expect(429);
  });

  it('detects Player refresh reuse the same way and audits it as the Player', async () => {
    const subject = randomUUID();
    const first = await playerLogin(subject);
    const other = await playerLogin(subject);
    const refresh = (token: string) =>
      http().post('/api/v1/player/auth/refresh').send({ refreshToken: token });
    const second = (await refresh(first.refreshToken).expect(200)).body;
    await refresh(first.refreshToken).expect(401);
    const raced = await Promise.all([
      refresh(second.refreshToken),
      refresh(second.refreshToken),
    ]);
    expect(raced.map((r) => r.status).sort()).toEqual([200, 401]);
    const winner = raced.find((r) => r.status === 200)!.body;
    expect(await auditRows('PLAYER_AUTH_REFRESH_REUSE_DETECTED')).toEqual([]);
    await pause(400);
    await refresh(second.refreshToken).expect(401);
    await refresh(winner.refreshToken).expect(401);
    await http()
      .get('/api/v1/player/me')
      .auth(winner.accessToken, { type: 'bearer' })
      .expect(401);
    await http()
      .get('/api/v1/player/me')
      .auth(other.accessToken, { type: 'bearer' })
      .expect(200);
    expect(await auditRows('PLAYER_AUTH_REFRESH_REUSE_DETECTED')).toEqual([
      expect.objectContaining({
        actor_type: 'PLAYER',
        actor_player_id: first.player.id,
        actor_staff_id: null,
        resource_type: 'PLAYER_SESSION',
        status_code: 401,
      }),
    ]);
    const [row] = await database.query(
      'SELECT refresh_token_hash FROM player_sessions WHERE revoked_at IS NOT NULL AND player_id = $1',
      [first.player.id],
    );
    expect(row.refresh_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.refresh_token_hash).not.toContain(winner.refreshToken);
  });

  describe('Player session ↔ realtime lifecycle', () => {
    const SETTINGS = 'PLAYER_SETTINGS_UPDATED';
    // The event is published only when a value really changes.
    const touchSettings = async (token: string) => {
      const current = (
        await http()
          .get('/api/v1/player/settings')
          .auth(token, { type: 'bearer' })
          .expect(200)
      ).body.locale;
      await http()
        .patch('/api/v1/player/settings')
        .auth(token, { type: 'bearer' })
        .send({ locale: current === 'en-US' ? 'pt-BR' : 'en-US' })
        .expect(200);
    };
    const authenticated = (socket: Awaited<ReturnType<typeof realtime>>) =>
      until(() => socket.messages.find((m) => m.type === 'AUTHENTICATED'));
    const settingsEvents = (socket: Awaited<ReturnType<typeof realtime>>) =>
      socket.messages.filter((m) => m.type === SETTINGS);
    const sid = (token: string) => decodeJwt(token).sid as string;
    const registry = () => app.get(RealtimeConnectionRegistry);
    const logout = (token: string) =>
      http()
        .post('/api/v1/player/auth/logout')
        .auth(token, { type: 'bearer' })
        .expect(204);

    it('logout closes only that session’s sockets; the other session keeps receiving', async () => {
      const subject = randomUUID();
      const a = await playerLogin(subject);
      const b = await playerLogin(subject);
      const onA = await realtime('PLAYER', a.accessToken);
      const onB = await realtime('PLAYER', b.accessToken);
      for (const socket of [onA, onB]) await authenticated(socket);
      await touchSettings(b.accessToken);
      for (const socket of [onA, onB])
        await until(() => settingsEvents(socket).length === 1 || undefined);
      await logout(a.accessToken);
      expect(await closed(onA.ws)).toEqual({
        code: 4001,
        reason: 'SESSION_REVOKED',
      });
      expect(registry().sessionCount(sid(a.accessToken))).toBe(0);
      expect(registry().count(connectionKey('PLAYER', a.player.id))).toBe(1);
      // A later Player event reaches B only.
      await touchSettings(b.accessToken);
      await until(() => settingsEvents(onB).length === 2 || undefined);
      await pause(100);
      expect(settingsEvents(onA)).toHaveLength(1);
      expect(onB.ws.readyState).toBe(WsClient.OPEN);
      // The revoked session can no longer authenticate a new socket.
      const again = await realtime('PLAYER', a.accessToken);
      expect((await closed(again.ws)).code).toBe(4001);
    });

    it('refresh reuse closes the revoked session’s sockets and no other session', async () => {
      const subject = randomUUID();
      const a = await playerLogin(subject);
      const b = await playerLogin(subject);
      const onA = await realtime('PLAYER', a.accessToken);
      const onB = await realtime('PLAYER', b.accessToken);
      await authenticated(onA);
      await authenticated(onB);
      const refresh = (token: string) =>
        http()
          .post('/api/v1/player/auth/refresh')
          .send({ refreshToken: token });
      await refresh(a.refreshToken).expect(200);
      // Stale within the grace window: nothing closes.
      await refresh(a.refreshToken).expect(401);
      await pause(100);
      expect(onA.ws.readyState).toBe(WsClient.OPEN);
      await pause(350);
      await refresh(a.refreshToken).expect(401);
      expect(await closed(onA.ws)).toEqual({
        code: 4001,
        reason: 'SESSION_REVOKED',
      });
      await touchSettings(b.accessToken);
      await until(() => settingsEvents(onB).length === 1 || undefined);
      await pause(100);
      expect(settingsEvents(onA)).toEqual([]);
      expect(onB.ws.readyState).toBe(WsClient.OPEN);
      expect(registry().sessionCount(sid(a.accessToken))).toBe(0);
      expect(registry().sessionCount(sid(b.accessToken))).toBe(1);
    });

    it('survives logout racing a client close and an AUTH in flight, with no leak or later delivery', async () => {
      const subject = randomUUID();
      const a = await playerLogin(subject);
      const onA = await realtime('PLAYER', a.accessToken);
      await authenticated(onA);
      // Logout and the client's own close at the same time.
      await Promise.all([
        logout(a.accessToken),
        closed(onA.ws),
        onA.ws.close(),
      ]);
      expect(registry().sessionCount(sid(a.accessToken))).toBe(0);
      // AUTH sent while the logout commits: the socket never stays open.
      const b = await playerLogin(subject);
      const inFlight = await realtime('PLAYER', b.accessToken);
      await logout(b.accessToken);
      const outcome = await closed(inFlight.ws);
      expect(outcome.code).toBe(4001);
      expect(['SESSION_REVOKED', 'UNAUTHORIZED']).toContain(outcome.reason);
      expect(registry().sessionCount(sid(b.accessToken))).toBe(0);
      const c = await playerLogin(subject);
      const onC = await realtime('PLAYER', c.accessToken);
      await authenticated(onC);
      await touchSettings(c.accessToken);
      await until(() => settingsEvents(onC).length === 1 || undefined);
      expect(settingsEvents(inFlight)).toEqual([]);
      expect(registry().count(connectionKey('PLAYER', a.player.id))).toBe(1);
    });
  });

  it('sends API security headers, restricts CORS to the allowlist and hides Swagger when disabled', async () => {
    const health = await http().get('/api/v1/health').expect(200);
    expect(health.headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none';frame-ancestors 'none'",
    });
    expect(health.headers['x-powered-by']).toBeUndefined();
    expect(health.headers['strict-transport-security']).toBeUndefined();
    const allowed = await http()
      .options('/api/v1/auth/login')
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type');
    expect(allowed.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(allowed.headers['access-control-allow-credentials']).toBeUndefined();
    const denied = await http()
      .options('/api/v1/auth/login')
      .set('Origin', 'https://evil.example.test')
      .set('Access-Control-Request-Method', 'POST');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    // Non-browser clients (no Origin) are unaffected.
    await http().get('/api/v1/vip-store/offers').expect(200);
    await http().get('/docs').expect(404);
    await http().get('/docs-json').expect(404);
  });

  it('keeps the HTTP body limit explicit at 100 kB', async () => {
    await http()
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send(
        JSON.stringify({
          username: 'coordinator',
          password: 'x'.repeat(200 * 1024),
        }),
      )
      .expect(413);
  });

  it('checks the realtime Origin, caps connections per identity and throttles connect/AUTH floods', async () => {
    const staff = (await login('coordinator').expect(200)).body.accessToken;
    // A foreign browser Origin is refused before the upgrade.
    expect(
      await open('/api/v1/realtime', {
        Origin: 'https://evil.example.test',
        'X-Forwarded-For': nextIp(),
      }),
    ).toMatchObject({ kind: 'refused', status: 403 });
    // The allowed Origin and a native client (no Origin) are accepted.
    const browser = await open('/api/v1/realtime', {
      Origin: ALLOWED,
      'X-Forwarded-For': nextIp(),
    });
    expect(browser.kind).toBe('open');
    // Two sockets per identity; the third is refused, the others stay.
    const a = await realtime('STAFF', staff);
    const b = await realtime('STAFF', staff);
    for (const s of [a, b])
      await until(() => s.messages.find((m) => m.type === 'AUTHENTICATED'));
    const c = await realtime('STAFF', staff);
    expect(await closed(c.ws)).toEqual({
      code: 4004,
      reason: 'CONNECTION_LIMIT',
    });
    expect([a.ws.readyState, b.ws.readyState]).toEqual([
      WsClient.OPEN,
      WsClient.OPEN,
    ]);
    // Bad-token flood from one IP: each socket is closed 4001, then the IP
    // is throttled (5 attempts per minute).
    const flooder = nextIp();
    for (let i = 0; i < 5; i++) {
      const s = await realtime('PLAYER', 'not-a-token', flooder);
      expect((await closed(s.ws)).code).toBe(4001);
    }
    expect(
      await open('/api/v1/realtime', { 'X-Forwarded-For': flooder }),
    ).toMatchObject({ kind: 'refused', status: 429 });
    // A legitimate Player elsewhere still connects.
    const player = await playerLogin();
    const ok = await realtime('PLAYER', player.accessToken);
    await until(() => ok.messages.find((m) => m.type === 'AUTHENTICATED'));
  });

  it('caps unauthenticated realtime sockets', async () => {
    const idle = [];
    for (let i = 0; i < 3; i++) {
      const s = await open('/api/v1/realtime', { 'X-Forwarded-For': nextIp() });
      expect(s.kind).toBe('open');
      idle.push(s);
    }
    expect(
      await open('/api/v1/realtime', { 'X-Forwarded-For': nextIp() }),
    ).toMatchObject({ kind: 'refused', status: 503 });
    for (const s of idle) if (s.kind === 'open') s.ws.close();
    await pause(100);
    expect(
      (await open('/api/v1/realtime', { 'X-Forwarded-For': nextIp() })).kind,
    ).toBe('open');
  });

  it('limits Agent HELLO abuse by IP and pending sockets while a real Agent still authenticates', async () => {
    const coordinator = (await login('coordinator').expect(200)).body
      .accessToken;
    const key = (
      await http()
        .post(`/api/v1/admin/game-servers/${server.id}/agent-credentials`)
        .auth(coordinator, { type: 'bearer' })
        .expect(201)
    ).body as { credentialId: string; credentialSecret: string };
    const hello = (secret: string) =>
      JSON.stringify({
        protocolVersion: '1',
        type: 'HELLO',
        messageId: randomUUID(),
        gameServerId: server.id,
        occurredAt: new Date().toISOString(),
        payload: {
          credentialId: key.credentialId,
          credentialSecret: secret,
          agentVersion: '1.0.0',
          capabilities: [],
          gameProcessState: 'RUNNING',
          skseReady: true,
        },
      });
    // Two failed HELLOs from one IP, then that IP cools down.
    const attacker = nextIp();
    for (let i = 0; i < 2; i++) {
      const s = await open('/api/v1/agent', { 'X-Forwarded-For': attacker });
      if (s.kind !== 'open') throw new Error('refused');
      s.ws.send(hello('A'.repeat(43)));
      expect((await closed(s.ws)).code).toBe(4001);
    }
    expect(
      await open('/api/v1/agent', { 'X-Forwarded-For': attacker }),
    ).toMatchObject({ kind: 'refused', status: 429 });
    // Connection attempts per IP are bounded even without HELLO.
    const noisy = nextIp();
    for (let i = 0; i < 5; i++) {
      const s = await open('/api/v1/agent', { 'X-Forwarded-For': noisy });
      if (s.kind === 'open') s.ws.close();
    }
    expect(
      await open('/api/v1/agent', { 'X-Forwarded-For': noisy }),
    ).toMatchObject({ kind: 'refused', status: 429 });
    await pause(100);
    // At most 3 sockets may wait for HELLO.
    const waiting = [];
    for (let i = 0; i < 3; i++)
      waiting.push(
        await open('/api/v1/agent', { 'X-Forwarded-For': nextIp() }),
      );
    expect(
      await open('/api/v1/agent', { 'X-Forwarded-For': nextIp() }),
    ).toMatchObject({ kind: 'refused', status: 503 });
    for (const s of waiting) if (s.kind === 'open') s.ws.close();
    await pause(100);
    // The legitimate Agent (its own IP, real credential) is unaffected.
    const agent = new FakeAgent(url, server.id);
    agents.push(agent);
    await agent.hello(key, ['GAME_COMMAND_V1']);
    expect(agent.connectionId).toBeDefined();
  });

  it('limits Player mutations per authenticated player, not per IP', async () => {
    const a = await playerLogin();
    const b = await playerLogin();
    const query = (token: string) =>
      http()
        .post(
          `/api/v1/player/game-servers/${server.id}/characters/unknown/profile-query`,
        )
        .auth(token, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({});
    await query(a.accessToken).expect(404);
    await query(a.accessToken).expect(404);
    const limited = await query(a.accessToken).expect(429);
    expect(limited.headers['retry-after']).toBeDefined();
    await query(b.accessToken).expect(404);
    const listing = (token: string) =>
      http()
        .post('/api/v1/player/marketplace/listings')
        .auth(token, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .send({});
    await listing(a.accessToken).expect(400);
    await listing(a.accessToken).expect(400);
    await listing(a.accessToken).expect(429);
    await listing(b.accessToken).expect(400);
  });

  it('keeps public, Player and delegated Staff routes working under fail-closed RBAC', async () => {
    const coordinator = (await login('coordinator').expect(200)).body
      .accessToken;
    await http().get('/api/v1/health').expect(200);
    await http().get('/api/v1/vip-store/offers').expect(200);
    const player = await playerLogin();
    await http()
      .get('/api/v1/player/me')
      .auth(player.accessToken, { type: 'bearer' })
      .expect(200);
    // Delegated to the service: still 404 for an unknown id, not 403.
    for (const path of [
      'character-operations',
      'moderation-operations',
      'world-operations',
      'server-control-operations',
    ])
      await http()
        .get(`/api/v1/${path}/${randomUUID()}`)
        .auth(coordinator, { type: 'bearer' })
        .expect(404);
    await http()
      .get(`/api/v1/game-servers/${server.id}/control/operations`)
      .auth(coordinator, { type: 'bearer' })
      .expect(200);
  });
});
