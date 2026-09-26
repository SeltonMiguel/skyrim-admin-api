import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { AuditAction, AuditResource } from '../audit/audit.types.js';
import type { AuthenticatedStaff } from '../auth/auth.types.js';
import type { AgentWorkKind } from '../game-agent/agent-domain-event.contracts.js';
import { AgentSessionRegistry } from '../game-agent/agent-session.registry.js';
import { AgentWorkNotifier } from '../game-agent/agent-work.notifier.js';
import { CommandStatus } from '../game-bridge/command-state.js';
import type { PlayerMarketplaceItemRelease } from '../player-marketplace/entities/player-marketplace-item-release.entity.js';
import {
  ListingStatus,
  PurchaseStatus,
  ReleaseResolution,
  ReleaseStatus,
} from '../player-marketplace/player-marketplace.contracts.js';
import { TradeStatus } from '../player-trades/player-trade.contracts.js';
import type { ServerControlOperation } from '../server-control/entities/server-control-operation.entity.js';
import {
  SERVER_CONTROL_POLICY,
  ServerControlStatus,
} from '../server-control/server-control.contracts.js';
import type { ServerControlResolution } from '../server-control/server-control.contracts.js';
import type { PlayerVipEntitlement } from '../vip-entitlements/entities/player-vip-entitlement.entity.js';
import type { VipRewardDeliveryAttempt } from '../vip-entitlements/entities/vip-reward-delivery-attempt.entity.js';
import type { VipRewardDelivery } from '../vip-entitlements/entities/vip-reward-delivery.entity.js';
import {
  DeliveryResolution,
  DeliveryStatus,
  MAX_DELIVERY_ATTEMPTS,
  PRE_EFFECT_COMMAND_ERRORS,
  rewardCommand,
} from '../vip-entitlements/vip-delivery.contracts.js';
import { EntitlementStatus } from '../vip-entitlements/vip-entitlement.contracts.js';
import { OperatorActionKind, OperatorDomain } from './operations.contracts.js';
import { OperatorActionService } from './operator-action.service.js';

const lock = { mode: 'pessimistic_write' } as const;
const notFound = (what: string) => new NotFoundException(`${what} not found`);
// How a VIP delivery attempt ended, from its own GameCommand.
export type DeliveryEvidence =
  'PRE_EFFECT_FAILURE' | 'NO_COMMAND' | 'POSSIBLY_EXECUTED';

// Proof that a delivery's failed attempt never reached an Agent: its
// command is FAILED with a code only ever set while PENDING (never
// dispatched). Anything else may have run in game.
export function deliveryEvidence(
  delivery: Pick<VipRewardDelivery, 'status' | 'gameCommandId'>,
  command: { status: string; error_code: string | null } | undefined,
): DeliveryEvidence {
  if (!delivery.gameCommandId) return 'NO_COMMAND';
  return delivery.status === DeliveryStatus.FAILED &&
    command?.status === CommandStatus.FAILED &&
    (PRE_EFFECT_COMMAND_ERRORS as readonly string[]).includes(
      command.error_code ?? '',
    )
    ? 'PRE_EFFECT_FAILURE'
    : 'POSSIBLY_EXECUTED';
}

// Operator recovery of the Host Agent pipelines (12.4). Nothing here
// re-sends a physical or economic effect whose execution cannot be
// disproven: Server Control UNCERTAIN is only resolved (never retried),
// gameplay work is only offered again under its own workId, a FAILED
// release is acknowledged or resolved, and a VIP reward gets a new
// attempt only after a proven pre-effect failure or an operator
// confirmation that it was not delivered.
@Injectable()
export class RecoveryService {
  constructor(
    private readonly actions: OperatorActionService,
    private readonly notifier: AgentWorkNotifier,
    private readonly sessions: AgentSessionRegistry,
  ) {}

  // Server Control UNCERTAIN -> operator resolution (separate record).
  resolveServerControl(
    auth: AuthenticatedStaff,
    key: unknown,
    operationId: string,
    resolution: ServerControlResolution,
    reason: string,
  ) {
    return this.actions.run(
      auth,
      key,
      {
        domain: OperatorDomain.SERVER_CONTROL,
        action:
          resolution === 'RESOLVED_SUCCEEDED'
            ? OperatorActionKind.RESOLVE_SUCCEEDED
            : OperatorActionKind.RESOLVE_FAILED,
        resourceId: operationId,
        reason,
        params: { resolution },
        audit: {
          action: AuditAction.SERVER_CONTROL_UNCERTAIN_RESOLVED,
          resourceType: AuditResource.SERVER_CONTROL,
        },
      },
      async (manager) => {
        const repository = manager.getRepository<ServerControlOperation>(
          'ServerControlOperation',
        );
        const operation = await repository.findOne({
          where: { id: operationId },
          lock,
        });
        if (!operation) throw notFound('Server control operation');
        // Also the permission its type requires to be read.
        if (
          !auth.permissions.includes(
            SERVER_CONTROL_POLICY[operation.type].permission,
          )
        )
          throw new ForbiddenException('Missing required permissions');
        if (operation.status !== ServerControlStatus.UNCERTAIN)
          throw new ConflictException('Only UNCERTAIN operations are resolved');
        if (operation.resolution)
          throw new ConflictException('Operation already resolved');
        const resolvedAt = new Date();
        await repository.update(
          { id: operation.id, status: ServerControlStatus.UNCERTAIN },
          {
            resolution,
            resolvedByStaffId: auth.user.id,
            resolvedAt,
            resolutionReason: reason,
          },
        );
        return {
          outcome: resolution,
          result: {
            gameServerId: operation.gameServerId,
            type: operation.type,
            status: operation.status,
            errorCode: operation.errorCode,
            resolution,
            resolvedAt: resolvedAt.toISOString(),
          },
          metadata: {
            gameServerId: operation.gameServerId,
            type: operation.type,
            errorCode: operation.errorCode,
          },
        };
      },
    );
  }

  // REQUEUE_SAME_WORK: the work stays exactly as it is (same entity, same
  // workId, same terms); the push hint forgets it so the Agent is told
  // again. No trade, purchase, settlement, release or GOLD is created.
  private requeue(
    auth: AuthenticatedStaff,
    key: unknown,
    input: {
      domain: OperatorDomain;
      kind: AgentWorkKind;
      workId: string;
      reason: string;
      current: (
        manager: EntityManager,
      ) => Promise<{ gameServerId: string; status: string } | null>;
      waiting: string;
      what: string;
    },
  ) {
    return this.actions.run(
      auth,
      key,
      {
        domain: input.domain,
        action: OperatorActionKind.REQUEUE_SAME_WORK,
        resourceId: input.workId,
        reason: input.reason,
        params: { kind: input.kind },
        audit: {
          action: AuditAction.AGENT_WORK_REQUEUED,
          resourceType:
            input.kind === 'TRADE_SETTLEMENT'
              ? AuditResource.PLAYER_TRADE
              : input.kind === 'MARKETPLACE_CUSTODY'
                ? AuditResource.PLAYER_MARKETPLACE
                : input.kind === 'MARKETPLACE_SETTLEMENT'
                  ? AuditResource.PLAYER_MARKETPLACE_PURCHASE
                  : AuditResource.PLAYER_MARKETPLACE_RELEASE,
        },
      },
      async (manager) => {
        const work = await input.current(manager);
        if (!work) throw notFound(input.what);
        if (work.status !== input.waiting)
          throw new ConflictException(
            `${input.what} is not waiting for the Agent`,
          );
        const agentConnected = this.sessions.isConnected(work.gameServerId);
        return {
          outcome: 'REQUEUED',
          result: {
            kind: input.kind,
            workId: input.workId,
            gameServerId: work.gameServerId,
            status: work.status,
            agentConnected,
          },
          metadata: { gameServerId: work.gameServerId, agentConnected },
          after: () => void this.notifier.forget(input.kind, input.workId),
        };
      },
    );
  }
  requeueTrade(
    auth: AuthenticatedStaff,
    key: unknown,
    tradeId: string,
    reason: string,
  ) {
    return this.requeue(auth, key, {
      domain: OperatorDomain.PLAYER_TRADE,
      kind: 'TRADE_SETTLEMENT',
      workId: tradeId,
      reason,
      waiting: TradeStatus.AWAITING_GAME_CONFIRMATION,
      what: 'Trade',
      current: (manager) =>
        this.row(
          manager,
          'SELECT game_server_id, status FROM player_trades WHERE id = $1',
          tradeId,
        ),
    });
  }
  requeueCustody(
    auth: AuthenticatedStaff,
    key: unknown,
    listingId: string,
    reason: string,
  ) {
    return this.requeue(auth, key, {
      domain: OperatorDomain.MARKETPLACE_CUSTODY,
      kind: 'MARKETPLACE_CUSTODY',
      workId: listingId,
      reason,
      waiting: ListingStatus.PENDING_CUSTODY,
      what: 'Listing',
      current: (manager) =>
        this.row(
          manager,
          'SELECT game_server_id, status FROM player_marketplace_listings WHERE id = $1',
          listingId,
        ),
    });
  }
  requeueSettlement(
    auth: AuthenticatedStaff,
    key: unknown,
    purchaseId: string,
    reason: string,
  ) {
    return this.requeue(auth, key, {
      domain: OperatorDomain.MARKETPLACE_SETTLEMENT,
      kind: 'MARKETPLACE_SETTLEMENT',
      workId: purchaseId,
      reason,
      waiting: PurchaseStatus.AWAITING_GAME_CONFIRMATION,
      what: 'Purchase',
      current: (manager) =>
        this.row(
          manager,
          `SELECT l.game_server_id, p.status FROM player_marketplace_purchases p
           JOIN player_marketplace_listings l ON l.id = p.listing_id WHERE p.id = $1`,
          purchaseId,
        ),
    });
  }
  requeueRelease(
    auth: AuthenticatedStaff,
    key: unknown,
    releaseId: string,
    reason: string,
  ) {
    return this.requeue(auth, key, {
      domain: OperatorDomain.MARKETPLACE_RELEASE,
      kind: 'MARKETPLACE_RELEASE',
      workId: releaseId,
      reason,
      waiting: ReleaseStatus.PENDING,
      what: 'Release',
      current: (manager) =>
        this.row(
          manager,
          'SELECT game_server_id, status FROM player_marketplace_item_releases WHERE id = $1',
          releaseId,
        ),
    });
  }
  private async row(manager: EntityManager, sql: string, id: string) {
    const [row] = (await manager.query(sql, [id])) as {
      game_server_id: string;
      status: string;
    }[];
    return row
      ? { gameServerId: row.game_server_id, status: row.status }
      : null;
  }

  // A FAILED release (the Agent could not return the item): never retried.
  // ACKNOWLEDGE records that an operator took it (no state change);
  // RESOLVE records what was found in game, apart from the Agent outcome.
  private async lockedFailedRelease(manager: EntityManager, id: string) {
    const release = await manager
      .getRepository<PlayerMarketplaceItemRelease>(
        'PlayerMarketplaceItemRelease',
      )
      .findOne({ where: { id }, lock });
    if (!release) throw notFound('Release');
    if (release.status !== ReleaseStatus.FAILED)
      throw new ConflictException('Only FAILED releases need an operator');
    if (release.resolution)
      throw new ConflictException('Release already resolved');
    return release;
  }
  acknowledgeRelease(
    auth: AuthenticatedStaff,
    key: unknown,
    releaseId: string,
    reason: string,
  ) {
    return this.actions.run(
      auth,
      key,
      {
        domain: OperatorDomain.MARKETPLACE_RELEASE,
        action: OperatorActionKind.ACKNOWLEDGE,
        resourceId: releaseId,
        reason,
        audit: {
          action: AuditAction.PLAYER_MARKETPLACE_RELEASE_ACKNOWLEDGED,
          resourceType: AuditResource.PLAYER_MARKETPLACE_RELEASE,
        },
      },
      async (manager) => {
        const release = await this.lockedFailedRelease(manager, releaseId);
        return {
          outcome: 'ACKNOWLEDGED',
          result: {
            listingId: release.listingId,
            gameServerId: release.gameServerId,
            status: release.status,
          },
          metadata: {
            listingId: release.listingId,
            gameServerId: release.gameServerId,
          },
        };
      },
    );
  }
  resolveRelease(
    auth: AuthenticatedStaff,
    key: unknown,
    releaseId: string,
    resolution: ReleaseResolution,
    reason: string,
  ) {
    return this.actions.run(
      auth,
      key,
      {
        domain: OperatorDomain.MARKETPLACE_RELEASE,
        action:
          resolution === ReleaseResolution.RESOLVED_SUCCEEDED
            ? OperatorActionKind.RESOLVE_SUCCEEDED
            : OperatorActionKind.RESOLVE_FAILED,
        resourceId: releaseId,
        reason,
        params: { resolution },
        audit: {
          action: AuditAction.PLAYER_MARKETPLACE_RELEASE_RESOLVED,
          resourceType: AuditResource.PLAYER_MARKETPLACE_RELEASE,
        },
      },
      async (manager) => {
        const release = await this.lockedFailedRelease(manager, releaseId);
        const resolvedAt = new Date();
        await manager
          .getRepository<PlayerMarketplaceItemRelease>(
            'PlayerMarketplaceItemRelease',
          )
          .update(
            { id: release.id, status: ReleaseStatus.FAILED },
            {
              resolution,
              resolvedByStaffId: auth.user.id,
              resolvedAt,
              resolutionReason: reason,
            },
          );
        return {
          outcome: resolution,
          result: {
            listingId: release.listingId,
            gameServerId: release.gameServerId,
            status: release.status,
            resolution,
            resolvedAt: resolvedAt.toISOString(),
          },
          metadata: {
            listingId: release.listingId,
            gameServerId: release.gameServerId,
          },
        };
      },
    );
  }

  // Same lock order as the delivery worker and the revoke: entitlement
  // row first, then the delivery.
  private async lockedDelivery(manager: EntityManager, id: string) {
    const found = await manager
      .getRepository<VipRewardDelivery>('VipRewardDelivery')
      .findOneBy({ id });
    if (!found) throw notFound('VIP delivery');
    const entitlement = await manager
      .getRepository<PlayerVipEntitlement>('PlayerVipEntitlement')
      .findOneOrFail({ where: { id: found.entitlementId }, lock });
    const delivery = await manager
      .getRepository<VipRewardDelivery>('VipRewardDelivery')
      .findOneOrFail({ where: { id }, lock });
    if (
      delivery.status !== DeliveryStatus.FAILED &&
      delivery.status !== DeliveryStatus.UNCERTAIN
    )
      throw new ConflictException(
        'Only FAILED or UNCERTAIN deliveries need an operator',
      );
    const [command] = delivery.gameCommandId
      ? ((await manager.query(
          `SELECT c.status, r.error_code FROM game_commands c
           LEFT JOIN game_command_results r ON r.game_command_id = c.id
           WHERE c.id = $1`,
          [delivery.gameCommandId],
        )) as { status: string; error_code: string | null }[])
      : [];
    return {
      entitlement,
      delivery,
      command,
      evidence: deliveryEvidence(delivery, command),
    };
  }
  // RETRY_SAFE: a new attempt (new command, new idempotency key) only when
  // the previous one is terminal and provably did not give the reward.
  retryDelivery(
    auth: AuthenticatedStaff,
    key: unknown,
    deliveryId: string,
    reason: string,
  ) {
    return this.actions.run(
      auth,
      key,
      {
        domain: OperatorDomain.VIP_DELIVERY,
        action: OperatorActionKind.RETRY_SAFE,
        resourceId: deliveryId,
        reason,
        audit: {
          action: AuditAction.VIP_DELIVERY_RETRIED,
          resourceType: AuditResource.VIP_REWARD_DELIVERY,
        },
      },
      async (manager) => {
        const { entitlement, delivery, command, evidence } =
          await this.lockedDelivery(manager, deliveryId);
        if (delivery.resolution === DeliveryResolution.CONFIRMED_DELIVERED)
          throw new ConflictException('Delivery confirmed as delivered');
        const safe =
          evidence === 'PRE_EFFECT_FAILURE' ||
          delivery.resolution === DeliveryResolution.CONFIRMED_NOT_DELIVERED;
        if (!safe)
          throw new ConflictException(
            'The previous attempt may have run in game; resolve it first',
          );
        if (!rewardCommand(delivery.reward, delivery.characterExternalId))
          throw new ConflictException('Reward has no typed command');
        // Never two live commands: the previous one must be terminal.
        if (
          command &&
          ![
            CommandStatus.SUCCEEDED,
            CommandStatus.FAILED,
            CommandStatus.TIMEOUT,
          ].includes(command.status as CommandStatus)
        )
          throw new ConflictException('The previous command is still open');
        if (delivery.attempt >= MAX_DELIVERY_ATTEMPTS)
          throw new ConflictException('Delivery attempts exhausted');
        const now = new Date();
        if (
          entitlement.status !== EntitlementStatus.ACTIVE ||
          (entitlement.expiresAt !== null && entitlement.expiresAt <= now)
        )
          throw new ConflictException('Entitlement no longer effective');
        await manager
          .getRepository<VipRewardDeliveryAttempt>('VipRewardDeliveryAttempt')
          .insert({
            deliveryId: delivery.id,
            attempt: delivery.attempt,
            gameCommandId: delivery.gameCommandId,
            status: delivery.status,
            errorCode: delivery.errorCode!,
            completedAt: delivery.completedAt!,
            resolution: delivery.resolution,
            resolvedByStaffId: delivery.resolvedByStaffId,
            resolvedAt: delivery.resolvedAt,
            resolutionReason: delivery.resolutionReason,
            retriedByStaffId: auth.user.id,
            retryReason: reason,
          });
        const attempt = delivery.attempt + 1;
        const updated = await manager
          .getRepository<VipRewardDelivery>('VipRewardDelivery')
          .update(
            { id: delivery.id, status: delivery.status },
            {
              status: DeliveryStatus.PENDING,
              gameCommandId: null,
              errorCode: null,
              completedAt: null,
              resolution: null,
              resolvedByStaffId: null,
              resolvedAt: null,
              resolutionReason: null,
              attempt,
            },
          );
        if (updated.affected !== 1)
          throw new ConflictException('Delivery changed concurrently');
        return {
          outcome: 'RETRY_SCHEDULED',
          result: {
            entitlementId: delivery.entitlementId,
            gameServerId: delivery.gameServerId,
            previousStatus: delivery.status,
            previousErrorCode: delivery.errorCode,
            previousGameCommandId: delivery.gameCommandId,
            evidence,
            status: DeliveryStatus.PENDING,
            attempt,
          },
          metadata: {
            entitlementId: delivery.entitlementId,
            gameServerId: delivery.gameServerId,
            previousStatus: delivery.status,
            previousErrorCode: delivery.errorCode,
            previousGameCommandId: delivery.gameCommandId,
            evidence,
            attempt,
          },
        };
      },
    );
  }
  resolveDelivery(
    auth: AuthenticatedStaff,
    key: unknown,
    deliveryId: string,
    resolution: DeliveryResolution,
    reason: string,
  ) {
    return this.actions.run(
      auth,
      key,
      {
        domain: OperatorDomain.VIP_DELIVERY,
        action:
          resolution === DeliveryResolution.CONFIRMED_DELIVERED
            ? OperatorActionKind.RESOLVE_SUCCEEDED
            : OperatorActionKind.RESOLVE_FAILED,
        resourceId: deliveryId,
        reason,
        params: { resolution },
        audit: {
          action: AuditAction.VIP_DELIVERY_RESOLVED,
          resourceType: AuditResource.VIP_REWARD_DELIVERY,
        },
      },
      async (manager) => {
        const { delivery, evidence } = await this.lockedDelivery(
          manager,
          deliveryId,
        );
        if (delivery.resolution)
          throw new ConflictException('Delivery already resolved');
        // A proven non-delivery cannot be "confirmed delivered".
        if (
          resolution === DeliveryResolution.CONFIRMED_DELIVERED &&
          evidence !== 'POSSIBLY_EXECUTED'
        )
          throw new ConflictException(
            'This attempt provably did not run in game',
          );
        const resolvedAt = new Date();
        await manager
          .getRepository<VipRewardDelivery>('VipRewardDelivery')
          .update(
            { id: delivery.id, status: delivery.status },
            {
              resolution,
              resolvedByStaffId: auth.user.id,
              resolvedAt,
              resolutionReason: reason,
            },
          );
        return {
          outcome: resolution,
          result: {
            entitlementId: delivery.entitlementId,
            gameServerId: delivery.gameServerId,
            status: delivery.status,
            errorCode: delivery.errorCode,
            attempt: delivery.attempt,
            evidence,
            resolution,
            resolvedAt: resolvedAt.toISOString(),
          },
          metadata: {
            entitlementId: delivery.entitlementId,
            gameServerId: delivery.gameServerId,
            status: delivery.status,
            errorCode: delivery.errorCode,
            attempt: delivery.attempt,
            evidence,
          },
        };
      },
    );
  }
}
