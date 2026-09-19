import type { Request } from 'express';
import type { StaffUser } from '../staff/entities/staff-user.entity.js';
import type { Permission } from '../rbac/permissions.js';

export interface AuthenticatedStaff {
  user: StaffUser;
  sessionId: string;
  permissions: Permission[];
}
export interface AuthRequest extends Request {
  auth?: AuthenticatedStaff;
}
