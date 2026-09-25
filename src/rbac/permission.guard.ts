import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthRequest } from '../auth/auth.types.js';
import {
  PERMISSIONS_IN_SERVICE,
  REQUIRED_PERMISSIONS,
} from './require-permissions.decorator.js';
import type { Permission } from './permissions.js';

// Fail-closed (12.1): a handler behind this guard must declare its
// permissions (@RequirePermissions) or explicitly delegate the check to its
// service (@PermissionsCheckedInService). Missing metadata is denied here
// and also refused at startup by PermissionMetadataValidator.
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const auth = context.switchToHttp().getRequest<AuthRequest>().auth;
    if (!auth) throw new UnauthorizedException();
    const targets = [context.getClass(), context.getHandler()];
    const required =
      this.reflector.getAllAndMerge<Permission[]>(
        REQUIRED_PERMISSIONS,
        targets,
      ) ?? [];
    if (!required.length) {
      if (
        this.reflector.getAllAndOverride<boolean>(
          PERMISSIONS_IN_SERVICE,
          targets,
        )
      )
        return true;
      throw new ForbiddenException('Missing required permissions');
    }
    if (!required.every((permission) => auth.permissions.includes(permission)))
      throw new ForbiddenException('Missing required permissions');
    return true;
  }
}
