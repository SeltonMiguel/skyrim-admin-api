import { Injectable, UnauthorizedException } from '@nestjs/common';
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

@Injectable()
export class AuthService {
  constructor(
    private readonly database: DataSource,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
  ) {}

  async login(
    dto: LoginDto,
    metadata: { ipAddress?: string; userAgent?: string } = {},
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
    return this.database.transaction(async (manager) => {
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
      return { ...pair, staff: publicStaff(current) };
    });
  }

  async refresh(token: string) {
    const claims = await this.tokens.verify(token, 'refresh');
    return this.database.transaction(async (manager) => {
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
      if (
        !this.sessionIsActive(session) ||
        !this.tokens.matches(token, session.refreshTokenHash)
      )
        throw this.invalidSession();
      const pair = await this.tokens.issue(
        user.id,
        session.id,
        session.expiresAt,
      );
      session.refreshTokenHash = this.tokens.hash(pair.refreshToken);
      session.lastUsedAt = new Date();
      await sessions.save(session);
      return { ...pair, staff: publicStaff(user) };
    });
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
    await this.database.transaction(async (manager) => {
      await this.lockUser(manager, auth.user.id);
      await manager
        .getRepository<StaffSession>('StaffSession')
        .update(
          {
            id: auth.sessionId,
            staffUserId: auth.user.id,
            revokedAt: IsNull(),
          },
          { revokedAt: new Date() },
        );
    });
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
