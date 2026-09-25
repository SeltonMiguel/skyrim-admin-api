import type { IdentityProvider } from '../player-accounts/player-account.contracts.js';

export interface AuthorizationCodeGrant {
  authorizationCode: string;
  redirectUri: string;
  codeVerifier?: string;
}
// The only data a provider may hand to the domain. Raw provider responses,
// access tokens and refresh tokens never leave the adapter.
export interface ExternalIdentity {
  provider: IdentityProvider;
  providerSubject: string;
  displayName: string;
}
// One adapter per provider. Implementations perform the server-side code
// exchange with their own credentials and must throw only
// UnauthorizedException (rejected grant) or ServiceUnavailableException.
export abstract class PlayerIdentityProvider {
  abstract readonly provider: IdentityProvider;
  abstract exchange(grant: AuthorizationCodeGrant): Promise<ExternalIdentity>;
}
