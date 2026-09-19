import {
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { RequestContext } from '../common/request-context/request-context.service.js';
import { AuditLog } from './entities/audit-log.entity.js';
import { AuditOutcome } from './audit.types.js';
import type { AuditEvent, AuditResult } from './audit.types.js';
import { sanitizeMetadata } from './metadata-sanitizer.js';

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  constructor(
    private readonly database: DataSource,
    private readonly context: RequestContext,
  ) {}

  async record(
    event: AuditEvent & { outcome: AuditOutcome },
    manager: EntityManager = this.database.manager,
  ): Promise<void> {
    const http = this.context.http;
    try {
      await manager.getRepository<AuditLog>('AuditLog').insert({
        id: randomUUID(),
        actorStaffId: event.actor?.id ?? null,
        actorUsername: event.actor?.username ?? null,
        actorDisplayName: event.actor?.displayName ?? null,
        actorRole: event.actor?.roleName ?? null,
        action: event.action,
        outcome: event.outcome,
        resourceType: event.resourceType ?? null,
        resourceId: event.resourceId ?? null,
        requestId: this.context.requestId ?? null,
        method: http?.method.slice(0, 16) ?? null,
        path: http?.path.split('?')[0].slice(0, 2048) ?? null,
        statusCode: event.statusCode ?? null,
        ipAddress: http?.ipAddress?.slice(0, 64) ?? null,
        userAgent: http?.userAgent?.slice(0, 512) ?? null,
        metadata: sanitizeMetadata(event.metadata),
      });
    } catch {
      this.logger.error(
        `Audit persistence unavailable [requestId=${this.context.requestId ?? 'none'}]`,
      );
      throw new ServiceUnavailableException('Audit persistence unavailable');
    }
  }

  // Reusable audited operation: SUCCESS commits with the mutation, FAILURE is
  // appended only after rollback, using a fresh transaction/connection.
  async execute<T>(
    event: AuditEvent,
    operation: (manager: EntityManager) => Promise<AuditResult<T>>,
    recordFailure = true,
  ): Promise<T> {
    const snapshot: AuditEvent = {
      ...event,
      actor: event.actor
        ? {
            id: event.actor.id,
            username: event.actor.username,
            displayName: event.actor.displayName,
            roleName: event.actor.roleName,
          }
        : undefined,
    };
    try {
      return await this.database.transaction(async (manager) => {
        const result = await operation(manager);
        await this.record(
          {
            ...snapshot,
            actor: result.actor ?? snapshot.actor,
            resourceId: result.resourceId ?? snapshot.resourceId,
            metadata: result.metadata ?? snapshot.metadata,
            outcome: AuditOutcome.SUCCESS,
          },
          manager,
        );
        return result.value;
      });
    } catch (error) {
      if (recordFailure && snapshot.actor) {
        // No error messages, SQL, DTOs or exception objects enter metadata.
        await this.record({
          ...snapshot,
          outcome: AuditOutcome.FAILURE,
          statusCode: error instanceof HttpException ? error.getStatus() : 500,
        });
      }
      throw error;
    }
  }
}
