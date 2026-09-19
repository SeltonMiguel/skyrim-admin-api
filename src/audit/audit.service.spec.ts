import {
  ConflictException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { jest } from '@jest/globals';
import type { DataSource, EntityManager } from 'typeorm';
import { RequestContext } from '../common/request-context/request-context.service.js';
import { RoleName } from '../rbac/roles.js';
import { AuditService } from './audit.service.js';
import { AuditAction, AuditOutcome, AuditResource } from './audit.types.js';
import type { AuditActor, AuditEvent } from './audit.types.js';

function fixture() {
  const order: string[] = [];
  const insert = jest
    .fn<(entry: unknown) => Promise<void>>()
    .mockImplementation(async () => {
      order.push('append-outside');
    });
  const transactionInsert = jest
    .fn<(entry: unknown) => Promise<void>>()
    .mockImplementation(async () => {
      order.push('append-inside');
    });
  const manager = {
    getRepository: () => ({ insert }),
  } as unknown as EntityManager;
  const transactionManager = {
    getRepository: () => ({ insert: transactionInsert }),
  } as unknown as EntityManager;
  const database = {
    manager,
    transaction: async (
      operation: (manager: EntityManager) => Promise<unknown>,
    ) => {
      order.push('begin');
      try {
        const result = await operation(transactionManager);
        order.push('commit');
        return result;
      } catch (error) {
        order.push('rollback');
        throw error;
      }
    },
  } as unknown as DataSource;
  const context = new RequestContext();
  const audit = new AuditService(database, context);
  const actor: AuditActor = {
    id: 'actor',
    username: 'coordinator',
    displayName: 'Coordinator',
    roleName: RoleName.COORDINATOR,
  };
  const event: AuditEvent = {
    actor,
    action: AuditAction.STAFF_ROLE_CHANGE,
    resourceType: AuditResource.STAFF_USER,
    resourceId: 'target',
    statusCode: 200,
  };
  return {
    audit,
    context,
    actor,
    event,
    order,
    insert,
    transactionInsert,
    transactionManager,
  };
}

describe('AuditService', () => {
  it('appends a sanitized entry with an actor snapshot and the existing HTTP context', async () => {
    const f = fixture();
    await new Promise<void>((resolve, reject) =>
      f.context.run(
        'request-42',
        () => {
          void f.audit
            .record({
              ...f.event,
              actor: { ...f.actor, passwordHash: 'private' } as AuditActor,
              outcome: AuditOutcome.SUCCESS,
              metadata: {
                previousRole: 'SUPPORT',
                newRole: 'MODERATOR',
                password: 'private',
              },
            })
            .then(resolve, reject);
        },
        {
          method: 'PATCH',
          path: '/api/v1/staff/target/role?accessToken=private',
          ipAddress: '127.0.0.1',
          userAgent: 'test-agent',
        },
      ),
    );
    expect(f.insert).toHaveBeenCalledTimes(1);
    expect(f.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.any(String),
        actorStaffId: 'actor',
        actorUsername: 'coordinator',
        actorDisplayName: 'Coordinator',
        actorRole: 'COORDINATOR',
        requestId: 'request-42',
        method: 'PATCH',
        path: '/api/v1/staff/target/role',
        ipAddress: '127.0.0.1',
        userAgent: 'test-agent',
        metadata: { previousRole: 'SUPPORT', newRole: 'MODERATOR' },
      }),
    );
    expect(JSON.stringify(f.insert.mock.calls)).not.toContain('private');
  });
  it('uses null HTTP fields for CLI events and exposes no mutation methods', async () => {
    const f = fixture();
    await f.audit.record({
      action: AuditAction.COORDINATOR_BOOTSTRAP,
      outcome: AuditOutcome.SUCCESS,
    });
    expect(f.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        actorStaffId: null,
        requestId: null,
        method: null,
        path: null,
        statusCode: null,
        ipAddress: null,
        userAgent: null,
        metadata: null,
      }),
    );
    expect(f.audit).not.toHaveProperty('update');
    expect(f.audit).not.toHaveProperty('delete');
  });
  it('commits SUCCESS with the mutation and captures actor identity before changes', async () => {
    const f = fixture();
    const result = await f.audit.execute(f.event, async (manager) => {
      expect(manager).toBe(f.transactionManager);
      f.actor.displayName = 'Changed';
      f.actor.roleName = RoleName.SUPPORT;
      return {
        value: { public: true },
        metadata: { previousRole: 'SUPPORT', newRole: 'ADMIN' },
      };
    });
    expect(result).toEqual({ public: true });
    expect(f.order).toEqual(['begin', 'append-inside', 'commit']);
    expect(f.transactionInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'SUCCESS',
        actorDisplayName: 'Coordinator',
        actorRole: 'COORDINATOR',
      }),
    );
    expect(f.insert).not.toHaveBeenCalled();
  });
  it('writes FAILURE after rollback, preserves the original status and omits error details', async () => {
    const f = fixture();
    const error = new ConflictException('private SQL or password');
    await expect(
      f.audit.execute(f.event, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(f.order).toEqual(['begin', 'rollback', 'append-outside']);
    expect(f.insert).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'FAILURE', statusCode: 409 }),
    );
    expect(JSON.stringify(f.insert.mock.calls)).not.toContain('private');
  });
  it('rolls back on SUCCESS audit failure and records a separate FAILURE', async () => {
    const f = fixture();
    const log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    try {
      f.transactionInsert.mockRejectedValueOnce(
        new Error('private database failure'),
      );
      await expect(
        f.audit.execute(f.event, async () => ({ value: 'done' })),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(f.order).toEqual(['begin', 'rollback', 'append-outside']);
      expect(f.insert).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'FAILURE', statusCode: 503 }),
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain('private');
    } finally {
      log.mockRestore();
    }
  });
  it('reports 503 when even FAILURE cannot be persisted', async () => {
    const f = fixture();
    const log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    try {
      f.insert.mockRejectedValueOnce(new Error('private'));
      await expect(
        f.audit.execute(f.event, async () => {
          throw new ConflictException();
        }),
      ).rejects.toThrow('Audit persistence unavailable');
      expect(f.order).toEqual(['begin', 'rollback']);
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
  it('does not audit failed logins when failure recording is disabled', async () => {
    const f = fixture();
    await expect(
      f.audit.execute(
        { ...f.event, action: AuditAction.AUTH_LOGIN },
        async () => {
          throw new Error('failed');
        },
        false,
      ),
    ).rejects.toThrow('failed');
    expect(f.insert).not.toHaveBeenCalled();
  });
});
