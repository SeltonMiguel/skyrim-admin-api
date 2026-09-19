import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PasswordService } from '../auth/password.service.js';
import { RoleName } from '../rbac/roles.js';
import { Role } from '../rbac/entities/role.entity.js';
import { StaffStatus, StaffUser } from './entities/staff-user.entity.js';
import { CreateStaffDto } from './dto/staff.dto.js';
import { lockCoordinatorChanges, staffConflict } from './staff.service.js';
import type { ApplicationConfig } from '../config/environment.js';

@Injectable()
export class BootstrapCoordinatorService {
  constructor(
    private readonly database: DataSource,
    private readonly passwords: PasswordService,
  ) {}
  async run(
    credentials: ApplicationConfig['bootstrap'],
  ): Promise<'created' | 'already-exists'> {
    try {
      return await this.database.transaction(async (manager) => {
        await lockCoordinatorChanges(manager);
        const repository = manager.getRepository<StaffUser>('StaffUser');
        // An existing disabled coordinator is not silently replaced or reactivated.
        if (await repository.existsBy({ roleName: RoleName.COORDINATOR }))
          return 'already-exists';
        const dto = plainToInstance(CreateStaffDto, {
          ...credentials,
          role: RoleName.COORDINATOR,
        });
        if ((await validate(dto)).length)
          throw new BadRequestException(
            'Set valid BOOTSTRAP_COORDINATOR_USERNAME, BOOTSTRAP_COORDINATOR_DISPLAY_NAME and BOOTSTRAP_COORDINATOR_PASSWORD (12–128 characters)',
          );
        if (
          !(await manager
            .getRepository<Role>('Role')
            .existsBy({ name: RoleName.COORDINATOR }))
        )
          throw new BadRequestException(
            'Run migrations before staff:bootstrap',
          );
        await repository.insert({
          username: dto.username,
          displayName: dto.displayName,
          passwordHash: await this.passwords.hash(dto.password),
          roleName: RoleName.COORDINATOR,
          status: StaffStatus.ACTIVE,
        });
        return 'created';
      });
    } catch (error) {
      staffConflict(error);
    }
  }
}
