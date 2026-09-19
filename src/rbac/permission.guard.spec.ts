import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionGuard } from './permission.guard.js';
import {
  RequirePermissions,
  REQUIRED_PERMISSIONS,
} from './require-permissions.decorator.js';
import { Permission as P } from './permissions.js';

@RequirePermissions(P.STAFF_READ)
class Controller {
  @RequirePermissions(P.STAFF_WRITE)
  update() {}
}
const context = (permissions?: P[]) =>
  ({
    getClass: () => Controller,
    getHandler: () => Controller.prototype.update,
    switchToHttp: () => ({
      getRequest: () => ({ auth: permissions ? { permissions } : undefined }),
    }),
  }) as unknown as ExecutionContext;

describe('RequirePermissions / PermissionGuard', () => {
  const guard = new PermissionGuard(new Reflector());
  it('records method and class metadata', () => {
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, Controller)).toEqual([
      P.STAFF_READ,
    ]);
    expect(
      Reflect.getMetadata(REQUIRED_PERMISSIONS, Controller.prototype.update),
    ).toEqual([P.STAFF_WRITE]);
  });
  it('accepts all required permissions', () => {
    expect(guard.canActivate(context([P.STAFF_READ, P.STAFF_WRITE]))).toBe(
      true,
    );
  });
  it.each([[], [P.STAFF_READ], [P.STAFF_WRITE]])(
    'rejects incomplete grants %j with 403',
    (...permissions) => {
      expect(() => guard.canActivate(context(permissions as P[]))).toThrow(
        ForbiddenException,
      );
    },
  );
  it('requires authentication even when used alone', () => {
    expect(() => guard.canActivate(context())).toThrow(UnauthorizedException);
  });
});
