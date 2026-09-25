import { AuditService } from '../audit/audit.service.js';
import {
  AuditAction,
  AuditOutcome,
  AuditResource,
} from '../audit/audit.types.js';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';
import { StaffUser, StaffStatus } from '../staff/entities/staff-user.entity.js';
import { StaffSession } from './entities/staff-session.entity.js';
import { RolePermission } from '../rbac/entities/role-permission.entity.js';
import { publicStaff } from '../staff/staff.presenter.js';
import type { LoginDto } from './dto/auth.dto.js';
import type { AuthenticatedStaff } from './auth.types.js';
import type { ApplicationConfig } from '../config/environment.js';
import { SecurityLog } from '../common/security/security-log.js';
import { StaffAuthThrottle } from './staff-auth-throttle.js';

@Injectable()
export class AuthService {
  constructor(
    private readonly database: DataSource,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly throttle: StaffAuthThrottle,
    private readonly security: SecurityLog,
    config: ConfigService<{ application: ApplicationConfig }, true>,
  ) {
    this.reuseGraceMs = config.get('application', {
      infer: true,
    }).security.refreshReuseGraceMs;
  }
  private readonly reuseGraceMs: number;

  async login(
    dto: LoginDto,
    metadata: { ipAddress?: string; userAgent?: string } = {},
  ) {
    // Throttled before any database or Argon2 work (12.1).
    const release = this.throttle.beginLogin(metadata.ipAddress, dto.username);
    try {
      const result = await this.authenticateLogin(dto, metadata);
      this.throttle.loginSucceeded(dto.username);
      return result;
    } finally {
      release();
    }
  }
  private async authenticateLogin(
    dto: LoginDto,
    metadata: { ipAddress?: string; userAgent?: string },
  ) {
    const user = await this.database
      .getRepository<StaffUser>('StaffUser')
      .createQueryBuilder('staff')
      .addSelect('staff.passwordHash')
      .where('staff.username = :username', { username: dto.username })
      .getOne();
    if (!user) {
      await this.passwords.verifyMissing(dto.password);
      throw this.invalidCredentials();
    }
    const valid = await this.passwords.verify(user.passwordHash, dto.password);
    if (!valid || user.status !== StaffStatus.ACTIVE)
      throw this.invalidCredentials();
    return this.audit.execute(
      {
        actor: user,
        action: AuditAction.AUTH_LOGIN,
        resourceType: AuditResource.STAFF_SESSION,
        statusCode: 200,
      },
      async (manager) => {
        const current = await this.lockUser(manager, user.id);
        if (!current || current.status !== StaffStatus.ACTIVE)
          throw this.invalidCredentials();
        const sessionId = randomUUID();
        const pair = await this.tokens.issue(current.id, sessionId);
        await manager.getRepository<StaffSession>('StaffSession').insert({
          id: sessionId,
          staffUserId: current.id,
          refreshTokenHash: this.tokens.hash(pair.refreshToken),
          expiresAt: pair.refreshExpiresAt,
          ipAddress: metadata.ipAddress?.slice(0, 64) ?? null,
          userAgent: metadata.userAgent?.slice(0, 512) ?? null,
        });
        current.lastLoginAt = new Date();
        await manager.getRepository<StaffUser>('StaffUser').save(current);
        return {
          value: { ...pair, staff: publicStaff(current) },
          actor: current,
          resourceId: sessionId,
        };
      },
      false,
    );
  }

  // Rotation with reuse detection (12.1). A refresh token that is validly
  // signed for this session but is not its current one was issued by us and
  // already rotated away: within the grace window after the last rotation it
  // is a concurrent refresh that lost the race (401, session kept); after it,
  // it is a replay and the session (only this one) is revoked and audited.
  async refresh(token: string, ipAddress?: string) {
    this.throttle.refreshAttempt(ipAddress);
    const claims = await this.tokens.verify(token, 'refresh');
    this.throttle.refreshSession(ipAddress, claims.sid);
    const outcome = await this.database.transaction(async (manager) => {
      // All writers lock user before session, including disable and logout.
      const user = await this.lockUser(manager, claims.sub);
      if (!user || user.status !== StaffStatus.ACTIVE)
        throw this.invalidSession();
      const sessions = manager.getRepository<StaffSession>('StaffSession');
      const session = await sessions
        .createQueryBuilder('session')
        .addSelect('session.refreshTokenHash')
        .where('session.id = :sid AND session.staffUserId = :sub', claims)
        .setLock('pessimistic_write')
        .getOne();
      if (!this.sessionIsActive(session)) throw this.invalidSession();
      if (!this.tokens.matches(token, session.refreshTokenHash)) {
        const now = Date.now();
        if (
          session.lastUsedAt &&
          now - session.lastUsedAt.getTime() <= this.reuseGraceMs
        )
          return { kind: 'STALE' as const, sessionId: session.id };
        session.revokedAt = new Date(now);
        await sessions.save(session);
        await this.audit.record(
          {
            actor: user,
            action: AuditAction.AUTH_REFRESH_REUSE_DETECTED,
            resourceType: AuditResource.STAFF_SESSION,
            resourceId: session.id,
            outcome: AuditOutcome.SUCCESS,
            statusCode: 401,
          },
          manager,
        );
        return { kind: 'REUSED' as const, sessionId: session.id };
      }
      const pair = await this.tokens.issue(
        user.id,
        session.id,
        session.expiresAt,
      );
      session.refreshTokenHash = this.tokens.hash(pair.refreshToken);
      // Same clock as the reuse grace check above.
      session.lastUsedAt = new Date(Date.now());
      await sessions.save(session);
      return {
        kind: 'ROTATED' as const,
        value: { ...pair, staff: publicStaff(user) },
      };
    });
    if (outcome.kind === 'ROTATED') return outcome.value;
    this.security.warn(
      outcome.kind === 'REUSED'
        ? 'staff_refresh_reuse_revoked'
        : 'staff_refresh_stale',
      { sessionId: outcome.sessionId, ip: ipAddress ?? 'unknown' },
    );
    throw this.invalidSession();
  }

  async authenticate(token: string): Promise<AuthenticatedStaff> {
    const { sub, sid } = await this.tokens.verify(token, 'access');
    const session = await this.database
      .getRepository<StaffSession>('StaffSession')
      .findOne({
        where: { id: sid, staffUserId: sub },
        relations: { staffUser: true },
      });
    if (
      !this.sessionIsActive(session) ||
      session.staffUser.status !== StaffStatus.ACTIVE
    )
      throw this.invalidSession();
    const grants = await this.database
      .getRepository<RolePermission>('RolePermission')
      .findBy({ roleName: session.staffUser.roleName });
    return {
      user: session.staffUser,
      sessionId: sid,
      permissions: grants.map((grant) => grant.permissionName),
    };
  }

  async logout(auth: AuthenticatedStaff): Promise<void> {
    await this.audit.execute(
      {
        actor: auth.user,
        action: AuditAction.AUTH_LOGOUT,
        resourceType: AuditResource.STAFF_SESSION,
        resourceId: auth.sessionId,
        statusCode: 204,
      },
      async (manager) => {
        await this.lockUser(manager, auth.user.id);
        await manager.getRepository<StaffSession>('StaffSession').update(
          {
            id: auth.sessionId,
            staffUserId: auth.user.id,
            revokedAt: IsNull(),
          },
          { revokedAt: new Date() },
        );
        return { value: undefined };
      },
    );
  }

  private lockUser(manager: EntityManager, id: string) {
    return manager
      .getRepository<StaffUser>('StaffUser')
      .findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
  }
  private sessionIsActive(
    session: StaffSession | null,
  ): session is StaffSession {
    return (
      !!session &&
      !session.revokedAt &&
      session.expiresAt.getTime() > Date.now()
    );
  }
  private invalidCredentials() {
    return new UnauthorizedException('Invalid credentials');
  }
  private invalidSession() {
    return new UnauthorizedException('Invalid or expired session');
  }
}
