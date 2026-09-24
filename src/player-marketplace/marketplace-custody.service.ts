import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { QueryFailedError } from 'typeorm';
import { AuditAction } from '../audit/audit.types.js';
import { systemActor, SystemSource } from '../actors/actor.contracts.js';
import { externalId } from '../game-bridge/command-validation.js';
import type { PlayerMarketplaceCustodyEvent } from './entities/player-marketplace-custody-event.entity.js';
import { PlayerMarketplaceService } from './player-marketplace.service.js';
import {
  CustodyOutcome,
  ListingStatus,
} from './player-marketplace.contracts.js';
import type { CustodyResult } from './player-marketplace.contracts.js';

const reject = (
  reason: Extract<CustodyResult, { outcome: 'REJECTED' }>['reason'],
): CustodyResult => ({ outcome: 'REJECTED', reason });
const finalStatus = (outcome: CustodyOutcome) =>
  outcome === CustodyOutcome.CUSTODIED
    ? ListingStatus.ACTIVE
    : ListingStatus.FAILED;

// Trusted internal contract for the Agent transport (Etapa 11); there is no
// HTTP route. Idempotent per custodyEventId.
//
// CUSTODIED means the Agent validated item + quantity, withdrew/reserved the
// item durably, can keep it in custody, can return it to the seller if the
// listing is cancelled and can deliver it to a buyer in a retryable way.
// Only then does the listing become ACTIVE (purchasable). FAILED ends a
// PENDING_CUSTODY listing. A listing that is no longer PENDING_CUSTODY
// (e.g. cancelled meanwhile) is refused: the Agent must return the item.
@Injectable()
export class MarketplaceCustodyService {
  constructor(private readonly market: PlayerMarketplaceService) {}
  async confirmFromAgent(
    input: {
      listingId: string;
      custodyEventId: string;
      outcome: CustodyOutcome;
    },
    retried = false,
  ): Promise<CustodyResult> {
    let eventId: string;
    try {
      eventId = externalId(input.custodyEventId);
    } catch {
      return reject('INVALID_INPUT');
    }
    if (
      !isUUID(input.listingId) ||
      !Object.values(CustodyOutcome).includes(input.outcome)
    )
      return reject('INVALID_INPUT');
    const agent = systemActor(SystemSource.AGENT);
    try {
      return await this.market.mutate(async (manager, events) => {
        // Same lock order as the Player API: listing row first.
        const listing = await this.market.listings(manager).findOne({
          where: { id: input.listingId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!listing) return reject('LISTING_NOT_FOUND');
        const custody = manager.getRepository<PlayerMarketplaceCustodyEvent>(
          'PlayerMarketplaceCustodyEvent',
        );
        const existing = await custody.findOneBy({
          gameServerId: listing.gameServerId,
          custodyEventId: eventId,
        });
        if (existing)
          return existing.listingId === listing.id &&
            existing.outcome === input.outcome
            ? { outcome: 'ALREADY_APPLIED', status: finalStatus(input.outcome) }
            : reject('EVENT_CONFLICT');
        if (listing.status !== ListingStatus.PENDING_CUSTODY)
          return reject('LISTING_NOT_PENDING');
        const status = finalStatus(input.outcome);
        await custody.insert({
          gameServerId: listing.gameServerId,
          custodyEventId: eventId,
          listingId: listing.id,
          outcome: input.outcome,
        });
        await this.market.listings(manager).update(listing.id, {
          status,
          custodyEventId: eventId,
          ...(status === ListingStatus.FAILED ? { failedAt: new Date() } : {}),
        });
        const saved = await this.market
          .listings(manager)
          .findOneByOrFail({ id: listing.id });
        await this.market.record(
          manager,
          agent,
          status === ListingStatus.ACTIVE
            ? AuditAction.PLAYER_MARKETPLACE_LISTING_CUSTODIED
            : AuditAction.PLAYER_MARKETPLACE_LISTING_CUSTODY_FAILED,
          saved,
          { custodyEventId: eventId },
        );
        events.push({
          type:
            status === ListingStatus.ACTIVE
              ? 'MARKETPLACE_LISTING_ACTIVE'
              : 'MARKETPLACE_LISTING_FAILED',
          data: this.market.data(saved),
          playerIds: await this.market.playersOf(manager, saved.gameServerId, [
            saved.sellerCharacterId,
          ]),
        });
        return { outcome: 'APPLIED', status };
      });
    } catch (error) {
      // A concurrent confirmation won the unique event key: read it back.
      if (
        !retried &&
        error instanceof QueryFailedError &&
        (error.driverError as { code?: string }).code === '23505'
      )
        return this.confirmFromAgent(input, true);
      throw error;
    }
  }
}
