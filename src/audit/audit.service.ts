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
import type {
  AuditEvent,
  AuditEventActor,
  AuditResult,
} from './audit.types.js';
import {
  actor as validActor,
  ActorType,
  staffActor,
} from '../actors/actor.contracts.js';
import type { Actor } from '../actors/actor.contracts.js';
import { sanitizeMetadata } from './metadata-sanitizer.js';

// Untyped staff snapshots (existing callers, StaffUser entities) become STAFF.
// Only the allowlisted identity fields are copied; never the source object.
export function auditActor(value?: AuditEventActor): Actor | undefined {
  if (!value) return undefined;
  return 'type' in value ? validActor(value) : staffActor(value);
}
function actorColumns(value?: Actor) {
  return {
    actorType: value?.type ?? null,
    actorStaffId: value?.type === ActorType.STAFF ? value.id : null,
    actorUsername: value?.type === ActorType.STAFF ? value.username : null,
    actorDisplayName:
      value?.type === ActorType.STAFF ? value.displayName : null,
    actorRole: value?.type === ActorType.STAFF ? value.roleName : null,
    actorPlayerId: value?.type === ActorType.PLAYER ? value.playerId : null,
    actorSystemSource: value?.type === ActorType.SYSTEM ? value.source : null,
  };
}

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
    // Invalid actor is a programming error, not an Audit outage.
    const actor = actorColumns(auditActor(event.actor));
    try {
      await manager.getRepository<AuditLog>('AuditLog').insert({
        id: randomUUID(),
        ...actor,
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
  // recordFailure may be a predicate to leave specific refusals unaudited.
  async execute<T>(
    event: AuditEvent,
    operation: (manager: EntityManager) => Promise<AuditResult<T>>,
    recordFailure: boolean | ((error: unknown) => boolean) = true,
  ): Promise<T> {
    const snapshot: AuditEvent = { ...event, actor: auditActor(event.actor) };
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
      const failure =
        typeof recordFailure === 'function'
          ? recordFailure(error)
          : recordFailure;
      if (failure && snapshot.actor) {
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
