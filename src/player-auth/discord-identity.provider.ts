import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ApplicationConfig } from '../config/environment.js';
import {
  IdentityProvider,
  MAX_PLAYER_DISPLAY_NAME_LENGTH,
  providerSubject,
} from '../player-accounts/player-account.contracts.js';
import { PlayerIdentityProvider } from './identity-provider.js';
import type {
  AuthorizationCodeGrant,
  ExternalIdentity,
} from './identity-provider.js';

export const DISCORD_API = 'https://discord.com/api/v10';
export const DISCORD_TIMEOUT_MS = 5000;
export const PROVIDER_FETCH = Symbol('PROVIDER_FETCH');
export type ProviderFetch = typeof fetch;

// Discord OAuth2 authorization-code exchange with the server-side client
// secret and the `identify` scope. The Discord access token is used once to
// read the user id and discarded; nothing from Discord is persisted except
// the opaque user id (as providerSubject) and a display name.
@Injectable()
export class DiscordIdentityProvider extends PlayerIdentityProvider {
  readonly provider = IdentityProvider.DISCORD;
  private readonly config: ApplicationConfig['playerAuth']['discord'];
  constructor(
    config: ConfigService<{ application: ApplicationConfig }, true>,
    @Inject(PROVIDER_FETCH) private readonly http: ProviderFetch,
  ) {
    super();
    this.config = config.get('application', { infer: true }).playerAuth.discord;
  }
  async exchange(grant: AuthorizationCodeGrant): Promise<ExternalIdentity> {
    const config = this.config;
    if (!config)
      throw new ServiceUnavailableException('Player login unavailable');
    // Exact-match allowlist: a code is only redeemed for a registered redirect.
    if (!config.redirectUris.includes(grant.redirectUri)) throw rejected();
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: grant.authorizationCode,
      redirect_uri: grant.redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    });
    if (grant.codeVerifier) form.set('code_verifier', grant.codeVerifier);
    const token = await this.call(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const accessToken = (token as { access_token?: unknown }).access_token;
    const tokenType = (token as { token_type?: unknown }).token_type;
    if (
      typeof accessToken !== 'string' ||
      !accessToken ||
      (typeof tokenType === 'string' && tokenType.toLowerCase() !== 'bearer')
    )
      throw unavailable();
    const user = (await this.call(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })) as { id?: unknown; global_name?: unknown; username?: unknown };
    if (typeof user.id !== 'string' || !/^\d{1,32}$/.test(user.id))
      throw unavailable();
    return {
      provider: IdentityProvider.DISCORD,
      providerSubject: providerSubject(user.id),
      displayName:
        displayName(user.global_name) ?? displayName(user.username) ?? 'Player',
    };
  }
  // 4xx means the grant was rejected; anything else is an outage. Response
  // bodies are never logged, returned or attached to errors.
  private async call(url: string, init: RequestInit): Promise<object> {
    let response: Response;
    try {
      response = await this.http(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
      });
    } catch {
      throw unavailable();
    }
    if (response.status >= 400 && response.status < 500) throw rejected();
    if (!response.ok) throw unavailable();
    try {
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object') throw new Error();
      return body;
    } catch {
      throw unavailable();
    }
  }
}
function displayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Provider names are untrusted: drop controls/lone surrogates, then bound by
  // UTF-16 length without splitting a code point.
  const clean = value
    .replace(
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
      '',
    )
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, '')
    .trim();
  let bounded = '';
  for (const char of clean) {
    if (bounded.length + char.length > MAX_PLAYER_DISPLAY_NAME_LENGTH) break;
    bounded += char;
  }
  return bounded.trim() || undefined;
}
const rejected = () =>
  new UnauthorizedException('Discord authorization rejected');
const unavailable = () =>
  new ServiceUnavailableException('Identity provider unavailable');
