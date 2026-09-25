import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ApplicationConfig } from '../config/environment.js';
import { IdentityProvider } from '../player-accounts/player-account.contracts.js';
import {
  DISCORD_API,
  DiscordIdentityProvider,
} from './discord-identity.provider.js';
import type { ProviderFetch } from './discord-identity.provider.js';
import { PlayerIdentityProvider } from './identity-provider.js';
import { PlayerAuthRateLimiter } from './player-auth-rate-limit.js';
import { MemoryRateLimiter } from '../common/rate-limit/rate-limiter.js';

const redirectUri = 'http://127.0.0.1:53682/callback';
const discord = {
  clientId: 'client-id',
  clientSecret: 'server-side-secret',
  redirectUris: [redirectUri],
};
const config = (playerAuth: Partial<ApplicationConfig['playerAuth']>) =>
  ({
    get: () => ({
      playerAuth: { rateLimitPerMinute: 3, discord, ...playerAuth },
    }),
  }) as unknown as ConfigService<{ application: ApplicationConfig }, true>;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
function provider(
  responses: (Response | Error)[],
  settings: Partial<ApplicationConfig['playerAuth']> = {},
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const http = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next || next instanceof Error) throw next ?? new Error('no response');
    return next;
  }) as unknown as ProviderFetch;
  return {
    discord: new DiscordIdentityProvider(config(settings), http),
    calls,
  };
}
const grant = { authorizationCode: 'code-123', redirectUri };
const token = () =>
  json(200, {
    access_token: 'discord-access',
    token_type: 'Bearer',
    refresh_token: 'discord-refresh',
  });

describe('Discord identity provider', () => {
  it('redeems the code server-side and returns only provider, subject and display name', async () => {
    const f = provider([
      token(),
      json(200, {
        id: '80351110224678912',
        username: 'nelly',
        global_name: '  Nelly \u0000 ',
        email: 'private@example.test',
        avatar: 'hash',
      }),
    ]);
    const identity = await f.discord.exchange({
      ...grant,
      codeVerifier: 'v'.repeat(43),
    });
    expect(identity).toEqual({
      provider: IdentityProvider.DISCORD,
      providerSubject: '80351110224678912',
      displayName: 'Nelly',
    });
    expect(f.discord).toBeInstanceOf(PlayerIdentityProvider);
    const [exchange, me] = f.calls;
    expect(exchange.url).toBe(`${DISCORD_API}/oauth2/token`);
    expect(Object.fromEntries(exchange.init.body as URLSearchParams)).toEqual({
      grant_type: 'authorization_code',
      code: 'code-123',
      redirect_uri: redirectUri,
      client_id: 'client-id',
      client_secret: 'server-side-secret',
      code_verifier: 'v'.repeat(43),
    });
    expect(exchange.init.redirect).toBe('error');
    expect(me.url).toBe(`${DISCORD_API}/users/@me`);
    expect(me.init.headers).toEqual({ Authorization: 'Bearer discord-access' });
  });
  it('falls back to username and bounds untrusted names', async () => {
    const f = provider([
      token(),
      json(200, { id: '1', global_name: null, username: 'x'.repeat(80) }),
      token(),
      json(200, { id: '2', global_name: '\u0001', username: '' }),
      token(),
      json(200, { id: '3', global_name: `${'a'.repeat(63)}😀` }),
    ]);
    expect((await f.discord.exchange(grant)).displayName).toBe('x'.repeat(64));
    expect((await f.discord.exchange(grant)).displayName).toBe('Player');
    expect((await f.discord.exchange(grant)).displayName).toBe('a'.repeat(63));
  });
  it('rejects unregistered redirect URIs before contacting Discord and is 503 when unconfigured', async () => {
    const f = provider([]);
    await expect(
      f.discord.exchange({ ...grant, redirectUri: 'https://evil.test/cb' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(f.calls).toHaveLength(0);
    const off = provider([], { discord: null });
    await expect(off.discord.exchange(grant)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
  it.each([
    [
      'rejected grant',
      [json(400, { error: 'invalid_grant', raw: 'raw-provider-body' })],
      UnauthorizedException,
    ],
    [
      'rejected profile',
      [token(), json(401, { message: 'raw-provider-body' })],
      UnauthorizedException,
    ],
    [
      'provider outage',
      [json(502, { raw: 'raw-provider-body' })],
      ServiceUnavailableException,
    ],
    [
      'network failure',
      [new Error('raw-provider-body')],
      ServiceUnavailableException,
    ],
    [
      'malformed token',
      [json(200, { raw: 'raw-provider-body' })],
      ServiceUnavailableException,
    ],
    [
      'non-bearer token',
      [json(200, { access_token: 'x', token_type: 'mac' })],
      ServiceUnavailableException,
    ],
    [
      'invalid user id',
      [token(), json(200, { id: 'raw-provider-body' })],
      ServiceUnavailableException,
    ],
    [
      'non-JSON body',
      [token(), new Response('raw-provider-body', { status: 200 })],
      ServiceUnavailableException,
    ],
  ] as const)(
    'maps %s to a safe error without the raw response',
    async (_name, responses, type) => {
      const f = provider([...responses]);
      const error = await f.discord.exchange(grant).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(type);
      expect(
        JSON.stringify((error as UnauthorizedException).getResponse()),
      ).not.toMatch(/raw-provider-body|discord-access|server-side-secret/);
    },
  );
});

describe('Player auth rate limiter', () => {
  it('limits per key within a fixed window and resets afterwards', () => {
    const limiter = new PlayerAuthRateLimiter(
      new MemoryRateLimiter(),
      config({}),
    );
    expect(limiter.limit).toBe(3);
    for (let i = 0; i < 3; i++) expect(limiter.consume('a', 1000)).toBeNull();
    expect(limiter.consume('a', 1000)).toBe(60);
    expect(limiter.consume('a', 31000)).toBe(30);
    expect(limiter.consume('b', 1000)).toBeNull();
    expect(limiter.consume('a', 61000)).toBeNull();
    limiter.reset();
    expect(limiter.consume('a', 61001)).toBeNull();
  });
});

describe('Player auth boundaries', () => {
  it('does not depend on staff auth, sessions, RBAC or Electron', () => {
    const files = globSync(
      fileURLToPath(new URL('./**/*.ts', import.meta.url)),
    ).filter((file) => !file.endsWith('.spec.ts'));
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      for (const module of imports)
        expect(module).not.toMatch(/\.\.\/(auth|staff|rbac)\/|electron/i);
      expect(source).not.toMatch(/\bLogger\b|console\./);
    }
  });
});
