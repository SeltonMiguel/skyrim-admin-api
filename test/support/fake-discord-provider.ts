import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { IdentityProvider } from '../../src/player-accounts/player-account.contracts.js';
import { PlayerIdentityProvider } from '../../src/player-auth/identity-provider.js';
import type {
  AuthorizationCodeGrant,
  ExternalIdentity,
} from '../../src/player-auth/identity-provider.js';

// Stands in for Discord: authorization codes map to identities; no network.
export class FakeDiscordProvider extends PlayerIdentityProvider {
  readonly provider = IdentityProvider.DISCORD;
  codes = new Map<string, { subject: string; displayName: string }>();
  grants: AuthorizationCodeGrant[] = [];
  outage = false;
  async exchange(grant: AuthorizationCodeGrant): Promise<ExternalIdentity> {
    this.grants.push({ ...grant });
    if (this.outage)
      throw new ServiceUnavailableException('Identity provider unavailable');
    const identity = this.codes.get(grant.authorizationCode);
    if (!identity)
      throw new UnauthorizedException('Discord authorization rejected');
    return {
      provider: IdentityProvider.DISCORD,
      providerSubject: identity.subject,
      displayName: identity.displayName,
    };
  }
}
