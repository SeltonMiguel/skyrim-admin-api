import { SetMetadata } from '@nestjs/common';
import type { Permission } from './permissions.js';

export const REQUIRED_PERMISSIONS = 'required-permissions';
export const PERMISSIONS_IN_SERVICE = 'permissions-checked-in-service';
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);
// Explicit opt-out of the route-level check (12.1), for handlers whose
// permission depends on the stored resource (e.g. the type of an operation)
// and is enforced by the service before any data is returned. Never implied
// by the absence of metadata: PermissionGuard denies such handlers.
export const PermissionsCheckedInService = () =>
  SetMetadata(PERMISSIONS_IN_SERVICE, true);
