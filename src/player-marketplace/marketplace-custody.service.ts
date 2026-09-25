import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { QueryFailedError } from 'typeorm';
import { AuditAction } from '../audit/audit.types.js';
import type { AgentEventHook } from '../actors/agent-event.contracts.js';
import { systemActor, SystemSource } from '../actors/actor.contracts.js';
import { externalId } from '../game-bridge/command-validation.js';
import type { PlayerMarketplaceItemRelease } from './entities/player-marketplace-item-release.entity.js';
import type { PlayerMarketplaceCustodyEvent } from './entities/player-marketplace-custody-event.entity.js';
import { PlayerMarketplaceService } from './player-marketplace.service.js';
import {
  CustodyOutcome,
  ListingStatus,
  ReleaseReason,
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
// PENDING_CUSTODY listing. Late acquired custody of CANCELLED/FAILED
// listings creates a persistent return obligation without reactivating them.
@Injectable()
export class MarketplaceCustodyService {
  constructor(private readonly market: PlayerMarketplaceService) {}
  // gameServerId is the authenticated Agent session's server (Etapa 11.4):
  // an entity of another server is SERVER_MISMATCH and nothing changes.
  // Item, quantity, parties and price are read from the listing; the Agent
  // only names the work and the outcome. onAccepted runs in this
  // transaction before an accepted outcome commits.
  async confirmFromAgent(
    input: {
      gameServerId: string;
      listingId: string;
      custodyEventId: string;
      outcome: CustodyOutcome;
    },
    onAccepted?: AgentEventHook,
    retried = false,
  ): Promise<CustodyResult> {
    let eventId: string;
    try {
      eventId = externalId(input.custodyEventId);
    } catch {
      return reject('INVALID_INPUT');
    }
    if (
      !isUUID(input.gameServerId) ||
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
        if (listing.gameServerId !== input.gameServerId)
          return reject('SERVER_MISMATCH');
        const custody = manager.getRepository<PlayerMarketplaceCustodyEvent>(
          'PlayerMarketplaceCustodyEvent',
        );
        const existing = await custody.findOneBy({
          gameServerId: listing.gameServerId,
          custodyEventId: eventId,
        });
        if (
          existing &&
          (existing.listingId !== listing.id ||
            existing.outcome !== input.outcome)
        )
          return reject('EVENT_CONFLICT');
        if (
          input.outcome === CustodyOutcome.CUSTODIED &&
          (listing.status === ListingStatus.CANCELLED ||
            listing.status === ListingStatus.FAILED)
        ) {
          const releases = manager.getRepository<PlayerMarketplaceItemRelease>(
            'PlayerMarketplaceItemRelease',
          );
          const release = await releases.findOneBy({ listingId: listing.id });
          if (!release) {
            // Listing lock serializes equivalent eventIds; the UNIQUE listing
            // constraint also protects the obligation independently of receipts.
            await this.market.createRelease(
              manager,
              listing,
              listing.status === ListingStatus.CANCELLED
                ? ReleaseReason.CANCELLED
                : ReleaseReason.PURCHASE_FAILED,
            );
            await this.market.record(
              manager,
              agent,
              AuditAction.PLAYER_MARKETPLACE_LISTING_CUSTODIED,
              listing,
              { custodyEventId: eventId, lateCustody: true },
            );
          }
          // Preserve existing append-only custody history (including FAILED).
          // For a cancelled pending listing, record the acquired custody too.
          if (!(await custody.findOneBy({ listingId: listing.id })))
            await custody.insert({
              gameServerId: listing.gameServerId,
              custodyEventId: eventId,
              listingId: listing.id,
              outcome: input.outcome,
            });
          await onAccepted?.(manager);
          return {
            outcome: release ? 'ALREADY_APPLIED' : 'APPLIED',
            status: listing.status,
          };
        }
        if (existing) {
          await onAccepted?.(manager);
          return {
            outcome: 'ALREADY_APPLIED',
            status: finalStatus(input.outcome),
          };
        }
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
        await onAccepted?.(manager);
        return { outcome: 'APPLIED', status };
      });
    } catch (error) {
      // A concurrent confirmation won the unique event key: read it back.
      if (
        !retried &&
        error instanceof QueryFailedError &&
        (error.driverError as { code?: string }).code === '23505'
      )
        return this.confirmFromAgent(input, onAccepted, true);
      throw error;
    }
  }
}
