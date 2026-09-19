import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { isUUID } from 'class-validator';
import type { ApplicationConfig } from '../config/environment.js';

export interface TokenClaims {
  sub: string;
  sid: string;
}
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresAt: Date;
}

@Injectable()
export class TokenService {
  private readonly config: ApplicationConfig['jwt'];
  constructor(config: ConfigService) {
    this.config = config.getOrThrow<ApplicationConfig>('application').jwt;
  }

  async issue(
    sub: string,
    sid: string,
    sessionExpiresAt?: Date,
  ): Promise<TokenPair> {
    const now = Math.floor(Date.now() / 1000);
    const refreshExpiration = Math.min(
      now + this.config.refreshTtl,
      sessionExpiresAt
        ? Math.floor(sessionExpiresAt.getTime() / 1000)
        : Infinity,
    );
    if (refreshExpiration <= now)
      throw new UnauthorizedException('Invalid or expired session');
    const refreshExpiresAt = new Date(refreshExpiration * 1000);
    const sign = (kind: 'access' | 'refresh') =>
      new SignJWT({ sid, kind })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(sub)
        .setIssuer('skyrim-admin-api')
        .setAudience(`skyrim-admin-${kind}`)
        .setJti(randomUUID())
        .setIssuedAt(now)
        .setExpirationTime(
          kind === 'access' ? now + this.config.accessTtl : refreshExpiration,
        )
        .sign(
          new TextEncoder().encode(
            kind === 'access'
              ? this.config.accessSecret
              : this.config.refreshSecret,
          ),
        );
    const [accessToken, refreshToken] = await Promise.all([
      sign('access'),
      sign('refresh'),
    ]);
    return {
      accessToken,
      refreshToken,
      expiresIn: this.config.accessTtl,
      refreshExpiresAt,
    };
  }

  async verify(
    token: string,
    kind: 'access' | 'refresh',
  ): Promise<TokenClaims> {
    try {
      const { payload } = await jwtVerify(
        token,
        new TextEncoder().encode(
          kind === 'access'
            ? this.config.accessSecret
            : this.config.refreshSecret,
        ),
        {
          algorithms: ['HS256'],
          typ: 'JWT',
          issuer: 'skyrim-admin-api',
          audience: `skyrim-admin-${kind}`,
          requiredClaims: ['sub', 'sid', 'exp', 'iat', 'jti', 'kind'],
        },
      );
      if (
        payload.kind !== kind ||
        typeof payload.sub !== 'string' ||
        !isUUID(payload.sub) ||
        typeof payload.sid !== 'string' ||
        !isUUID(payload.sid)
      )
        throw new Error('Invalid claims');
      return { sub: payload.sub, sid: payload.sid };
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
