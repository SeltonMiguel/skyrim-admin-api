import 'reflect-metadata';
import { Controller, Get, UseGuards } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PermissionGuard } from './permission.guard.js';
import {
  PermissionMetadataValidator,
  unguardedStaffRoutes,
} from './permission-metadata.validator.js';
import { SecurityLog } from '../common/security/security-log.js';
import {
  PermissionsCheckedInService,
  RequirePermissions,
} from './require-permissions.decorator.js';
import { Permission as P } from './permissions.js';

@UseGuards(PermissionGuard)
@Controller('forgotten')
class Forgotten {
  @Get() open() {}
  @Get('declared') @RequirePermissions(P.AUDIT_READ) declared() {}
  @Get('delegated') @PermissionsCheckedInService() delegated() {}
}
const context = (handler: () => void, permissions: P[] = [P.AUDIT_READ]) =>
  ({
    getClass: () => Forgotten,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => ({ auth: { permissions } }) }),
  }) as unknown as ExecutionContext;

describe('Staff RBAC fail-closed (12.1)', () => {
  const guard = new PermissionGuard(new Reflector());
  it('denies a handler without permission metadata at runtime', () => {
    expect(() =>
      guard.canActivate(context(Forgotten.prototype.open, Object.values(P))),
    ).toThrow(ForbiddenException);
    expect(guard.canActivate(context(Forgotten.prototype.declared))).toBe(true);
    expect(guard.canActivate(context(Forgotten.prototype.delegated, []))).toBe(
      true,
    );
  });
  it('finds routes without metadata structurally and refuses to start', () => {
    expect(unguardedStaffRoutes([Forgotten])).toEqual(['Forgotten.open']);
    const validator = new PermissionMetadataValidator(
      { getControllers: () => [{ metatype: Forgotten }] } as never,
      new SecurityLog(),
    );
    expect(() => validator.onModuleInit()).toThrow(
      'Staff routes without permission metadata: Forgotten.open',
    );
  });
  it('has no Staff route without permission metadata in the application', async () => {
    const files = globSync(
      fileURLToPath(new URL('../**/*controller*.ts', import.meta.url)),
    ).filter((file) => !file.endsWith('.spec.ts'));
    const controllers: (new (...args: never[]) => unknown)[] = [];
    for (const file of files)
      for (const value of Object.values(
        (await import(file)) as Record<string, unknown>,
      ))
        if (typeof value === 'function') controllers.push(value as never);
    expect(controllers.length).toBeGreaterThan(20);
    expect(unguardedStaffRoutes(controllers)).toEqual([]);
  });
});
