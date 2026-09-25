import { Injectable, OnModuleInit } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { SecurityLog } from '../common/security/security-log.js';
import { PermissionGuard } from './permission.guard.js';
import {
  PERMISSIONS_IN_SERVICE,
  REQUIRED_PERMISSIONS,
} from './require-permissions.decorator.js';

// Every route handler guarded by PermissionGuard must carry permission
// metadata or the explicit in-service delegation; otherwise the application
// refuses to start (12.1). The guard also denies at runtime, so a missed
// route is never silently open to any Staff account.
export function unguardedStaffRoutes(
  controllers: readonly (new (...args: never[]) => unknown)[],
  reflector = new Reflector(),
  scanner = new MetadataScanner(),
): string[] {
  const missing: string[] = [];
  for (const controller of controllers) {
    const prototype = controller.prototype as Record<string, unknown>;
    const classGuards: unknown[] =
      reflector.get(GUARDS_METADATA, controller) ?? [];
    for (const name of scanner.getAllMethodNames(prototype)) {
      const handler = prototype[name] as () => unknown;
      if (reflector.get(PATH_METADATA, handler) === undefined) continue;
      const guards = [
        ...classGuards,
        ...((reflector.get(GUARDS_METADATA, handler) as unknown[]) ?? []),
      ];
      if (!guards.includes(PermissionGuard)) continue;
      const required = reflector.getAllAndMerge<unknown[]>(
        REQUIRED_PERMISSIONS,
        [controller, handler],
      );
      const delegated = reflector.getAllAndOverride<boolean>(
        PERMISSIONS_IN_SERVICE,
        [controller, handler],
      );
      if (!required?.length && !delegated)
        missing.push(`${controller.name}.${name}`);
    }
  }
  return missing;
}

@Injectable()
export class PermissionMetadataValidator implements OnModuleInit {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly security: SecurityLog,
  ) {}
  onModuleInit(): void {
    const controllers = this.discovery
      .getControllers()
      .map((wrapper) => wrapper.metatype)
      .filter(Boolean) as (new (...args: never[]) => unknown)[];
    const missing = unguardedStaffRoutes(controllers);
    if (!missing.length) return;
    this.security.error('staff_route_without_permission', {
      count: missing.length,
      first: missing[0],
    });
    throw new Error(
      `Staff routes without permission metadata: ${missing.join(', ')}`,
    );
  }
}
