import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { idempotencyKey } from '../actor-operations/actor-command.service.js';
import { staffActor } from '../actors/actor.contracts.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuditAction, AuditResource } from '../audit/audit.types.js';
import type { AuthenticatedStaff } from '../auth/auth.types.js';
import { RateLimiter } from '../common/rate-limit/rate-limiter.js';
import { TooManyRequestsException } from '../common/rate-limit/too-many-requests.exception.js';
import { RequestContext } from '../common/request-context/request-context.service.js';
import type { ApplicationConfig } from '../config/environment.js';
import { canonicalJson } from '../game-bridge/canonical-json.js';
import { Metrics } from '../observability/metrics.js';
import { RealtimeEventBus } from '../realtime-events/realtime-event-bus.js';
import type { OperatorAction } from './entities/operator-action.entity.js';
import {
  DOMAIN_PERMISSION,
  metricAction,
  metricDomain,
} from './operations.contracts.js';
import type {
  OperatorActionKind,
  OperatorDomain,
} from './operations.contracts.js';

export type OperatorResult = Record<string, string | number | boolean | null>;
export interface OperatorRequest {
  domain: OperatorDomain;
  action: OperatorActionKind;
  resourceId: string;
  reason: string;
  // Everything else that defines the request (part of the fingerprint).
  params?: Record<string, string | number | boolean | null>;
  audit: { action: AuditAction; resourceType: AuditResource };
}
export interface OperatorWork<R extends OperatorResult> {
  outcome: string;
  result: R;
  // Audit resource id when it is not the request resource (e.g. the
  // ledger transaction of an adjustment).
  auditResourceId?: string;
  // Extra Audit metadata: identifiers and enums only, never payloads.
  metadata?: Record<string, string | number | boolean | null>;
  // Runs after the commit only (realtime, Agent push hints).
  after?: () => void;
}
export type OperatorResponse<R extends OperatorResult> = R & {
  operatorActionId: string;
  domain: OperatorDomain;
  action: OperatorActionKind;
  resourceId: string;
  outcome: string;
  replayed: boolean;
};
const KEY_CONSTRAINT = 'operator_actions_idempotency_key';
class Replay extends Error {}

// The common recovery action model (12.4). One operator intervention =
// Staff actor from the session, bounded reason, Idempotency-Key, one
// transaction holding the effect, the operator_actions row and the Audit
// (SUCCESS), an explicit result, and after-commit hooks. A replay of the
// same request returns the stored result without touching the domain; the
// same key with another request is a 409. A refused action rolls back and
// is audited as FAILURE (with its status code, never its message).
@Injectable()
export class OperatorActionService {
  private readonly logger = new Logger(OperatorActionService.name);
  private readonly perMinute: number;
  constructor(
    private readonly database: DataSource,
    private readonly audit: AuditService,
    private readonly context: RequestContext,
    private readonly limiter: RateLimiter,
    private readonly events: RealtimeEventBus,
    config: ConfigService<{ application: ApplicationConfig }, true>,
    @Optional() private readonly metrics?: Metrics,
  ) {
    this.perMinute = config.get('application', {
      infer: true,
    }).operations.actionsPerMinute;
  }
  private repository(manager: EntityManager = this.database.manager) {
    return manager.getRepository<OperatorAction>('OperatorAction');
  }
  async run<R extends OperatorResult>(
    auth: AuthenticatedStaff,
    key: unknown,
    request: OperatorRequest,
    work: (
      manager: EntityManager,
      actionId: string,
    ) => Promise<OperatorWork<R>>,
  ): Promise<OperatorResponse<R>> {
    // Defense in depth: the controller already required the permission.
    if (!auth.permissions.includes(DOMAIN_PERMISSION[request.domain]))
      throw new ForbiddenException('Missing required permissions');
    const idempotency = idempotencyKey(key);
    const labels = {
      domain: metricDomain(request.domain),
      action: metricAction(request.action),
    };
    const decision = this.limiter.consume('operator-action', auth.user.id, {
      limit: this.perMinute,
      windowMs: 60_000,
    });
    if (!decision.allowed) {
      this.metrics?.operatorActions.inc({ ...labels, outcome: 'rate_limited' });
      throw new TooManyRequestsException(decision.retryAfterSeconds);
    }
    const fingerprint = createHash('sha256')
      .update(
        canonicalJson(
          {
            domain: request.domain,
            action: request.action,
            resourceId: request.resourceId,
            reason: request.reason,
            params: request.params ?? {},
          },
          16384,
        ),
      )
      .digest('hex');
    const replay = await this.replay(auth.user.id, idempotency, fingerprint);
    if (replay) {
      this.metrics?.operatorActions.inc({ ...labels, outcome: 'replayed' });
      return replay as OperatorResponse<R>;
    }
    const actor = staffActor(auth.user);
    const actionId = randomUUID();
    let after: (() => void) | undefined;
    let response: OperatorResponse<R>;
    try {
      response = await this.audit.execute(
        {
          actor,
          action: request.audit.action,
          resourceType: request.audit.resourceType,
          resourceId: request.resourceId,
          metadata: {
            domain: request.domain,
            operatorAction: request.action,
            reason: request.reason,
            ...request.params,
          },
          statusCode: 200,
        },
        async (manager) => {
          // The action row comes first: a concurrent request with the same
          // key waits on its unique index, then replays; it never reaches
          // the domain and never sees a half-applied state.
          const inserted = await this.repository(manager)
            .createQueryBuilder()
            .insert()
            .values({
              id: actionId,
              staffId: auth.user.id,
              idempotencyKey: idempotency,
              requestFingerprint: fingerprint,
              domain: request.domain,
              action: request.action,
              resourceId: request.resourceId,
              reason: request.reason,
              outcome: 'IN_PROGRESS',
              result: {},
              requestId: this.context.requestId ?? null,
            })
            .onConflict(`ON CONSTRAINT ${KEY_CONSTRAINT} DO NOTHING`)
            .returning(['id'])
            .execute();
          if (!(inserted.raw as unknown[]).length) throw new Replay();
          const done = await work(manager, actionId);
          const body: OperatorResponse<R> = {
            ...done.result,
            operatorActionId: actionId,
            domain: request.domain,
            action: request.action,
            resourceId: request.resourceId,
            outcome: done.outcome,
            replayed: false,
          };
          await manager.query(
            'UPDATE operator_actions SET outcome = $2, result = $3 WHERE id = $1',
            [actionId, done.outcome, JSON.stringify(body)],
          );
          after = done.after;
          return {
            value: body,
            resourceId: done.auditResourceId ?? request.resourceId,
            metadata: {
              domain: request.domain,
              operatorAction: request.action,
              operatorActionId: actionId,
              outcome: done.outcome,
              reason: request.reason,
              ...request.params,
              ...done.metadata,
            },
          };
        },
        (error) => !(error instanceof Replay),
      );
    } catch (error) {
      if (error instanceof Replay) {
        const stored = await this.replay(
          auth.user.id,
          idempotency,
          fingerprint,
        );
        if (stored) {
          this.metrics?.operatorActions.inc({ ...labels, outcome: 'replayed' });
          return stored as OperatorResponse<R>;
        }
      }
      this.metrics?.operatorActions.inc({ ...labels, outcome: 'rejected' });
      throw error;
    }
    this.metrics?.operatorActions.inc({ ...labels, outcome: 'applied' });
    try {
      after?.();
    } catch {
      this.logger.error(
        `Operator action after-commit hook failed [operatorActionId=${actionId}]`,
      );
    }
    this.events.publish(
      'STAFF_OPERATIONS_UPDATED',
      {
        operatorActionId: actionId,
        domain: request.domain,
        action: request.action,
        resourceId: request.resourceId,
        outcome: response.outcome,
      },
      { staffPermission: DOMAIN_PERMISSION[request.domain] },
    );
    return response;
  }
  private async replay(
    staffId: string,
    key: string,
    fingerprint: string,
  ): Promise<Record<string, unknown> | null> {
    const stored = await this.repository().findOneBy({
      staffId,
      idempotencyKey: key,
    });
    if (!stored) return null;
    if (stored.requestFingerprint !== fingerprint)
      throw new ConflictException(
        'Idempotency-Key already used for another operator request',
      );
    return { ...stored.result, replayed: true };
  }
}
