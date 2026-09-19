import type { StaffUser } from './entities/staff-user.entity.js';
import type { StaffPublicDto } from './dto/staff.dto.js';

export function publicStaff(user: StaffUser): StaffPublicDto {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.roleName,
    status: user.status,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
