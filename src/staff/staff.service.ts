import { AuditService } from '../audit/audit.service.js';
import { AuditAction, AuditResource } from '../audit/audit.types.js';
import type { AuditActor } from '../audit/audit.types.js';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, IsNull, QueryFailedError } from 'typeorm';
import { StaffStatus, StaffUser } from './entities/staff-user.entity.js';
import { RoleName } from '../rbac/roles.js';
import { Role } from '../rbac/entities/role.entity.js';
import { StaffSession } from '../auth/entities/staff-session.entity.js';
import { PasswordService } from '../auth/password.service.js';
import { publicStaff } from './staff.presenter.js';
import type { CreateStaffDto, UpdateStaffDto } from './dto/staff.dto.js';

// Shared with bootstrap. Serializes changes to the active coordinator invariant.
export async function lockCoordinatorChanges(
  manager: EntityManager,
): Promise<void> {
  await manager.query('SELECT pg_advisory_xact_lock(1789810000)');
}
export function staffConflict(error: unknown): never {
  if (
    error instanceof QueryFailedError &&
    (error.driverError as { code?: string }).code === '23505'
  ) {
    throw new ConflictException('Username already exists');
  }
  throw error;
}

@Injectable()
export class StaffService {
  constructor(
    private readonly database: DataSource,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    return (
      await this.database
        .getRepository<StaffUser>('StaffUser')
        .find({ order: { createdAt: 'ASC', id: 'ASC' } })
    ).map(publicStaff);
  }
  async get(id: string) {
    return publicStaff(await this.find(this.database.manager, id));
  }

  async create(dto: CreateStaffDto, actor: AuditActor) {
    return this.audit.execute(
      {
        actor,
        action: AuditAction.STAFF_CREATE,
        resourceType: AuditResource.STAFF_USER,
        statusCode: 201,
      },
      async (manager) => {
        try {
          const role = await manager
            .getRepository<Role>('Role')
            .findOneBy({ name: dto.role });
          if (!role)
            throw new BadRequestException('Role unavailable; run migrations');
          const passwordHash = await this.passwords.hash(dto.password);
          const repository = manager.getRepository<StaffUser>('StaffUser');
          const user = await repository.save(
            repository.create({
              username: dto.username,
              displayName: dto.displayName,
              passwordHash,
              roleName: dto.role,
              status: StaffStatus.ACTIVE,
              lastLoginAt: null,
            }),
          );
          return { value: publicStaff(user), resourceId: user.id };
        } catch (error) {
          staffConflict(error);
        }
      },
    );
  }

  async update(id: string, dto: UpdateStaffDto, actor: AuditActor) {
    return this.audit.execute(
      {
        actor,
        action: AuditAction.STAFF_UPDATE,
        resourceType: AuditResource.STAFF_USER,
        resourceId: id,
        statusCode: 200,
      },
      async (manager) => {
        try {
          const user = await this.find(manager, id, true);
          const changedFields: string[] = [];
          if (dto.username !== undefined) {
            user.username = dto.username;
            changedFields.push('username');
          }
          if (dto.displayName !== undefined) {
            user.displayName = dto.displayName;
            changedFields.push('displayName');
          }
          return {
            value: publicStaff(
              await manager.getRepository<StaffUser>('StaffUser').save(user),
            ),
            metadata: { changedFields },
          };
        } catch (error) {
          staffConflict(error);
        }
      },
    );
  }

  async updateRole(id: string, role: RoleName, actor: AuditActor) {
    return this.audit.execute(
      {
        actor,
        action: AuditAction.STAFF_ROLE_CHANGE,
        resourceType: AuditResource.STAFF_USER,
        resourceId: id,
        statusCode: 200,
        metadata: { newRole: role },
      },
      async (manager) => {
        await lockCoordinatorChanges(manager);
        const user = await this.find(manager, id, true);
        if (
          !(await manager.getRepository<Role>('Role').existsBy({ name: role }))
        )
          throw new BadRequestException('Role unavailable');
        if (role !== RoleName.COORDINATOR)
          await this.protectLastCoordinator(manager, user);
        const previousRole = user.roleName;
        user.roleName = role;
        return {
          value: publicStaff(
            await manager.getRepository<StaffUser>('StaffUser').save(user),
          ),
          metadata: { previousRole, newRole: role },
        };
      },
    );
  }

  async updateStatus(id: string, status: StaffStatus, actor: AuditActor) {
    return this.audit.execute(
      {
        actor,
        action: AuditAction.STAFF_STATUS_CHANGE,
        resourceType: AuditResource.STAFF_USER,
        resourceId: id,
        statusCode: 200,
        metadata: { newStatus: status },
      },
      async (manager) => {
        await lockCoordinatorChanges(manager);
        const user = await this.find(manager, id, true);
        if (status === StaffStatus.DISABLED) {
          await this.protectLastCoordinator(manager, user);
          await manager
            .getRepository<StaffSession>('StaffSession')
            .update(
              { staffUserId: id, revokedAt: IsNull() },
              { revokedAt: new Date() },
            );
        }
        const previousStatus = user.status;
        user.status = status;
        return {
          value: publicStaff(
            await manager.getRepository<StaffUser>('StaffUser').save(user),
          ),
          metadata: { previousStatus, newStatus: status },
        };
      },
    );
  }

  private async find(manager: EntityManager, id: string, lock = false) {
    const user = await manager.getRepository<StaffUser>('StaffUser').findOne({
      where: { id },
      ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
    if (!user) throw new NotFoundException('Staff user not found');
    return user;
  }

  private async protectLastCoordinator(
    manager: EntityManager,
    user: StaffUser,
  ): Promise<void> {
    if (
      user.roleName !== RoleName.COORDINATOR ||
      user.status !== StaffStatus.ACTIVE
    )
      return;
    const count = await manager
      .getRepository<StaffUser>('StaffUser')
      .countBy({ roleName: RoleName.COORDINATOR, status: StaffStatus.ACTIVE });
    if (count <= 1)
      throw new ConflictException('Cannot remove the last active coordinator');
  }
}
