import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { isUUID } from 'class-validator';
import type { ApplicationConfig } from '../config/environment.js';

export const PLAYER_TOKEN_ISSUER = 'skyrim-player-api';
export const playerAudience = (kind: 'access' | 'refresh') =>
  `skyrim-player-${kind}`;
export interface PlayerTokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresAt: Date;
}

// Mirrors the staff TokenService primitives with player-only secrets,
// issuer and audiences, so tokens are never interchangeable.
@Injectable()
export class PlayerTokenService {
  private readonly config: ApplicationConfig['playerAuth'];
  constructor(config: ConfigService<{ application: ApplicationConfig }, true>) {
    this.config = config.get('application', { infer: true }).playerAuth;
  }
  private key(kind: 'access' | 'refresh') {
    return new TextEncoder().encode(
      kind === 'access' ? this.config.accessSecret : this.config.refreshSecret,
    );
  }
  // Absolute session expiry: refresh never extends past sessionExpiresAt.
  async issue(
    playerId: string,
    sessionId: string,
    sessionExpiresAt?: Date,
  ): Promise<PlayerTokenPair> {
    const now = Math.floor(Date.now() / 1000);
    const refreshExpiration = Math.min(
      now + this.config.refreshTtl,
      sessionExpiresAt
        ? Math.floor(sessionExpiresAt.getTime() / 1000)
        : Infinity,
    );
    if (refreshExpiration <= now)
      throw new UnauthorizedException('Invalid or expired session');
    const sign = (kind: 'access' | 'refresh') =>
      new SignJWT({ sid: sessionId, kind })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(playerId)
        .setIssuer(PLAYER_TOKEN_ISSUER)
        .setAudience(playerAudience(kind))
        .setJti(randomUUID())
        .setIssuedAt(now)
        .setExpirationTime(
          kind === 'access' ? now + this.config.accessTtl : refreshExpiration,
        )
        .sign(this.key(kind));
    const [accessToken, refreshToken] = await Promise.all([
      sign('access'),
      sign('refresh'),
    ]);
    return {
      accessToken,
      refreshToken,
      expiresIn: this.config.accessTtl,
      refreshExpiresAt: new Date(refreshExpiration * 1000),
    };
  }
  async verify(
    token: string,
    kind: 'access' | 'refresh',
  ): Promise<{ playerId: string; sessionId: string }> {
    try {
      const { payload } = await jwtVerify(token, this.key(kind), {
        algorithms: ['HS256'],
        typ: 'JWT',
        issuer: PLAYER_TOKEN_ISSUER,
        audience: playerAudience(kind),
        requiredClaims: ['sub', 'sid', 'exp', 'iat', 'jti', 'kind'],
      });
      if (
        payload.kind !== kind ||
        typeof payload.sub !== 'string' ||
        !isUUID(payload.sub) ||
        typeof payload.sid !== 'string' ||
        !isUUID(payload.sid)
      )
        throw new Error('Invalid claims');
      return { playerId: payload.sub, sessionId: payload.sid };
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
  matches(token: string, hash: string): boolean {
    const actual = Buffer.from(this.hash(token), 'hex');
    const expected = Buffer.from(hash, 'hex');
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }
}
