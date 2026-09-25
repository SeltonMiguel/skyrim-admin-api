import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Host Agent credential (11.1): one GameServer, a backend-generated random
// secret shown once, and only its SHA-256 stored. SHA-256 is deliberate: the
// secret has 256 bits of entropy and is never a human password, so a slow
// KDF adds nothing (same reasoning as player refresh tokens).
export enum AgentCredentialStatus {
  ACTIVE = 'ACTIVE',
  REVOKED = 'REVOKED',
}
// Two ACTIVE credentials allow rotation without downtime: create B, switch
// the Agent to B, revoke A.
export const MAX_ACTIVE_AGENT_CREDENTIALS = 2;
export const AGENT_SECRET_BYTES = 32;

export function generateAgentSecret(): string {
  return randomBytes(AGENT_SECRET_BYTES).toString('base64url');
}
export function agentSecretHash(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}
// Constant-time over the fixed-length digests; the stored hash is never
// compared against plaintext or looked up by secret.
export function agentSecretMatches(
  secret: string,
  storedHash: string,
): boolean {
  const actual = Buffer.from(agentSecretHash(secret), 'hex');
  const expected = Buffer.from(storedHash, 'hex');
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}
