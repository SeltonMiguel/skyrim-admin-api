import { ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COMMAND_TYPES } from '../game-bridge/command-contract.js';
import { AuditAction as A } from '../audit/audit.types.js';
import { Permission as P } from '../rbac/permissions.js';
import { ROLE_PERMISSIONS } from '../rbac/role-permissions.js';
import { RoleName as R } from '../rbac/roles.js';
import type { AuthenticatedStaff } from '../auth/auth.types.js';
import {
  isServerControlType,
  SERVER_CONTROL_ERRORS,
  SERVER_CONTROL_POLICY,
  SERVER_CONTROL_TYPES,
  ServerControlStatus as S,
} from './server-control.contracts.js';
import {
  DisconnectedServerControlGateway,
  ServerControlGateway,
} from './server-control-gateway.js';
import { ServerControlModule } from './server-control.module.js';
import { ServerControlService } from './server-control.service.js';
import { ServerControlOperation } from './entities/server-control-operation.entity.js';
import {
  serverControlDetail,
  serverControlReference,
} from './server-control.presenter.js';

const staff = (role: R): AuthenticatedStaff =>
  ({
    user: { id: randomUUID(), username: 'u', displayName: 'U', roleName: role },
    permissions: [...ROLE_PERMISSIONS[role]],
  }) as unknown as AuthenticatedStaff;

describe('Server Control contracts', () => {
  it('defines exactly three fixed operations outside the GameCommand catalog', () => {
    expect(SERVER_CONTROL_TYPES).toEqual([
      'SERVER_START',
      'SERVER_PAUSE',
      'SERVER_RESTART',
    ]);
    for (const type of SERVER_CONTROL_TYPES)
      expect(COMMAND_TYPES).not.toContain(type);
    for (const forbidden of [
      'SERVER_EXECUTE',
      'RAW_SERVER_COMMAND',
      'SHELL_COMMAND',
      'SERVER_STOP',
    ])
      expect(isServerControlType(forbidden)).toBe(false);
    expect(Object.values(S)).toEqual([
      'PENDING',
      'DISPATCHED',
      'SUCCEEDED',
      'FAILED',
    ]);
    expect(Object.keys(SERVER_CONTROL_ERRORS)).toEqual([
      'AGENT_UNAVAILABLE',
      'AGENT_REJECTED',
      'SERVER_DISABLED',
    ]);
  });
  it('maps each operation to its own existing permission and Audit action', () => {
    expect(SERVER_CONTROL_POLICY).toEqual({
      SERVER_START: {
        permission: P.SERVER_START,
        auditAction: A.SERVER_START_REQUESTED,
        path: 'start',
      },
      SERVER_PAUSE: {
        permission: P.SERVER_PAUSE,
        auditAction: A.SERVER_PAUSE_REQUESTED,
        path: 'pause',
      },
      SERVER_RESTART: {
        permission: P.SERVER_RESTART,
        auditAction: A.SERVER_RESTART_REQUESTED,
        path: 'restart',
      },
    });
    for (const role of Object.values(R))
      for (const type of SERVER_CONTROL_TYPES)
        expect(
          ROLE_PERMISSIONS[role].includes(
            SERVER_CONTROL_POLICY[type].permission,
          ),
        ).toBe(role === R.COORDINATOR || role === R.DEV);
  });
  it('wires the Disconnected gateway by default, which never accepts', async () => {
    const providers = Reflect.getMetadata(
      'providers',
      ServerControlModule,
    ) as unknown[];
    expect(providers).toContainEqual({
      provide: ServerControlGateway,
      useClass: DisconnectedServerControlGateway,
    });
    await expect(
      new DisconnectedServerControlGateway().send(),
    ).resolves.toEqual({ accepted: false, reason: 'UNAVAILABLE' });
  });
  it('presents an allowlist without Idempotency-Key or internal claim', () => {
    const operation = Object.assign(new ServerControlOperation(), {
      id: randomUUID(),
      gameServerId: randomUUID(),
      type: 'SERVER_RESTART',
      status: S.FAILED,
      idempotencyKey: 'secret-key',
      correlationId: randomUUID(),
      requestId: 'r',
      requestedByStaffId: randomUUID(),
      dispatchClaimedAt: new Date(),
      dispatchedAt: null,
      completedAt: new Date(),
      errorCode: 'AGENT_UNAVAILABLE',
      createdAt: new Date(),
    });
    const detail = serverControlDetail(operation);
    expect(Object.keys(serverControlReference(operation))).toEqual([
      'operationId',
      'gameServerId',
      'type',
      'status',
      'correlationId',
      'requestId',
      'createdAt',
    ]);
    expect(detail.errorMessage).toBe(SERVER_CONTROL_ERRORS.AGENT_UNAVAILABLE);
    expect(JSON.stringify(detail)).not.toMatch(/secret-key|claim|idempotency/i);
  });
  it('rejects requests and detail before touching the database without the grant', async () => {
    const untouched = new Proxy(
      {},
      {
        get: () => {
          throw new Error('database touched');
        },
      },
    );
    const service = new ServerControlService(
      untouched as never,
      untouched as never,
      untouched as never,
      untouched as never,
      untouched as never,
      untouched as never,
    );
    for (const role of [R.GENERAL_CHIEF, R.ADMIN, R.MODERATOR, R.SUPPORT]) {
      for (const type of SERVER_CONTROL_TYPES)
        await expect(
          service.request(randomUUID(), type, 'k', staff(role)),
        ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.get(randomUUID(), staff(role)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
  });
  it('contains no shell, process, container or Electron execution path', () => {
    const files = globSync(
      fileURLToPath(new URL('./**/*.ts', import.meta.url)),
    ).filter((file) => !file.endsWith('.spec.ts'));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files)
      expect(readFileSync(file, 'utf8')).not.toMatch(
        /child_process|electron|\bexecSync?\(|\bspawn\(|\beval\(|dockerode|systemctl|kubectl/i,
      );
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as Record<string, Record<string, string>>;
    for (const section of ['dependencies', 'devDependencies'])
      expect(Object.keys(manifest[section])).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/electron/i)]),
      );
  });
});
