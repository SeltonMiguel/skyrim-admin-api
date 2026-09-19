import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthRequest } from '../auth/auth.types.js';
import { REQUIRED_PERMISSIONS } from './require-permissions.decorator.js';
import type { Permission } from './permissions.js';

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const auth = context.switchToHttp().getRequest<AuthRequest>().auth;
    if (!auth) throw new UnauthorizedException();
    const required =
      this.reflector.getAllAndMerge<Permission[]>(REQUIRED_PERMISSIONS, [
        context.getClass(),
        context.getHandler(),
      ]) ?? [];
    if (!required.every((permission) => auth.permissions.includes(permission)))
      throw new ForbiddenException('Missing required permissions');
    return true;
  }
}
