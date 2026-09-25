import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { AgentEventHook } from '../actors/agent-event.contracts.js';
import { systemActor, SystemSource } from '../actors/actor.contracts.js';
import { AuditAction } from '../audit/audit.types.js';
import type { PlayerMarketplaceItemRelease } from './entities/player-marketplace-item-release.entity.js';
import { PlayerMarketplaceService } from './player-marketplace.service.js';
import {
  ReleaseOutcome,
  ReleaseStatus,
} from './player-marketplace.contracts.js';
import type { ReleaseResult } from './player-marketplace.contracts.js';

const reject = (
  reason: Extract<ReleaseResult, { outcome: 'REJECTED' }>['reason'],
): ReleaseResult => ({ outcome: 'REJECTED', reason });
const finalStatus = (outcome: ReleaseOutcome) =>
  outcome === ReleaseOutcome.RELEASED
    ? ReleaseStatus.COMPLETED
    : ReleaseStatus.FAILED;

// Trusted internal contract for the Agent (Etapa 11.4): the custodied item
// of an ended listing went back to the seller (RELEASED), or definitely
// cannot (FAILED, for operator follow-up). Idempotent per releaseEventId.
// The Agent names only the release; seller, item and quantity are the
// listing's. Nothing economic changes here: GOLD was already settled or
// refunded by the transition that created the release.
@Injectable()
export class MarketplaceReleaseService {
  constructor(private readonly market: PlayerMarketplaceService) {}
  async confirmFromAgent(
    input: {
      gameServerId: string;
      releaseId: string;
      releaseEventId: string;
      outcome: ReleaseOutcome;
    },
    onAccepted?: AgentEventHook,
  ): Promise<ReleaseResult> {
    if (
      !isUUID(input.gameServerId) ||
      !isUUID(input.releaseId) ||
      !isUUID(input.releaseEventId) ||
      !Object.values(ReleaseOutcome).includes(input.outcome)
    )
      return reject('INVALID_INPUT');
    return this.market.mutate(async (manager) => {
      const releases = manager.getRepository<PlayerMarketplaceItemRelease>(
        'PlayerMarketplaceItemRelease',
      );
      const found = await releases.findOneBy({ id: input.releaseId });
      if (!found) return reject('RELEASE_NOT_FOUND');
      if (found.gameServerId !== input.gameServerId)
        return reject('SERVER_MISMATCH');
      // Same lock order as the Player API: listing row first.
      const listing = await this.market.lockListing(manager, found.listingId);
      const release = await releases.findOneOrFail({
        where: { id: found.id },
        lock: { mode: 'pessimistic_write' },
      });
      const status = finalStatus(input.outcome);
      if (release.status !== ReleaseStatus.PENDING) {
        if (
          release.releaseEventId !== input.releaseEventId ||
          release.status !== status
        )
          return release.releaseEventId === input.releaseEventId
            ? reject('EVENT_CONFLICT')
            : reject('RELEASE_NOT_PENDING');
        await onAccepted?.(manager);
        return { outcome: 'ALREADY_APPLIED', status };
      }
      await releases.update(release.id, {
        status,
        releaseEventId: input.releaseEventId,
        completedAt: new Date(),
        errorCode: status === ReleaseStatus.FAILED ? 'RELEASE_FAILED' : null,
      });
      // Same policy as custody/settlement: the Agent-confirmed physical
      // transition is audited once, as SYSTEM:AGENT.
      await this.market.record(
        manager,
        systemActor(SystemSource.AGENT),
        status === ReleaseStatus.COMPLETED
          ? AuditAction.PLAYER_MARKETPLACE_ITEM_RELEASED
          : AuditAction.PLAYER_MARKETPLACE_ITEM_RELEASE_FAILED,
        listing,
        {
          releaseId: release.id,
          releaseReason: release.reason,
          releaseEventId: input.releaseEventId,
        },
      );
      await onAccepted?.(manager);
      return { outcome: 'APPLIED', status };
    });
  }
}
