import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import type { AgentEventHook } from '../actors/agent-event.contracts.js';
import { canonicalJson } from '../game-bridge/canonical-json.js';
import { MarketplaceCustodyService } from '../player-marketplace/marketplace-custody.service.js';
import { MarketplaceReleaseService } from '../player-marketplace/marketplace-release.service.js';
import { MarketplaceSettlementService } from '../player-marketplace/marketplace-settlement.service.js';
import {
  CustodyOutcome,
  MarketSettlementOutcome,
  ReleaseOutcome,
} from '../player-marketplace/player-marketplace.contracts.js';
import { CharacterLinkService } from '../player-characters/character-link.service.js';
import { SettlementOutcome } from '../player-trades/player-trade.contracts.js';
import { TradeSettlementService } from '../player-trades/trade-settlement.service.js';
import { ProfessionExperienceService } from '../professions/profession-experience.service.js';
import { ReceiptStatus } from './agent-domain-event.contracts.js';
import type { AgentEventKind } from './agent-domain-event.contracts.js';
import type { AgentDomainEventReceipt } from './entities/agent-domain-event-receipt.entity.js';
import type { DomainEventPayload } from './agent-protocol.contracts.js';

type Work<O extends string> = { workId: string; outcome: O };
type DataOf = {
  CHARACTER_OWNERSHIP_PROOF: { challenge: string; characterExternalId: string };
  PROFESSION_EXPERIENCE: { characterExternalId: string; amount: number };
  TRADE_SETTLEMENT: Work<'SETTLED' | 'FAILED'>;
  MARKETPLACE_CUSTODY: Work<'CUSTODIED' | 'FAILED'>;
  MARKETPLACE_SETTLEMENT: Work<'SETTLED' | 'FAILED'>;
  MARKETPLACE_RELEASE: Work<'RELEASED' | 'FAILED'>;
};
// What a domain entry point answered, reduced to the protocol's needs. No
// owner identity, balance or ledger detail leaves this service.
type Verdict =
  | { accepted: true; already: boolean; status: string }
  | { accepted: false; reason: string };
export type DomainEventOutcome =
  | { type: 'ACK'; duplicate: boolean; status: string | null }
  | { type: 'REJECTED'; reason: string; retryable: boolean; duplicate: boolean }
  | { type: 'CONFLICT' }
  | { type: 'SERVER_MISMATCH' };
type Handler = (
  event: DomainEventPayload,
  gameServerId: string,
  hook: AgentEventHook,
) => Promise<Verdict>;
// Refusals that may succeed later with the same eventId: not persisted.
const RETRYABLE = new Set(['LEDGER_REJECTED', 'SERVER_UNAVAILABLE']);
class ReceiptRace extends Error {}
const verdict = (result: {
  outcome: string;
  reason?: string;
  status?: string;
}): Verdict =>
  result.outcome === 'REJECTED'
    ? { accepted: false, reason: result.reason! }
    : {
        accepted: true,
        already: result.outcome.startsWith('ALREADY_'),
        status: result.status ?? result.outcome,
      };

// Typed DOMAIN_EVENT pipeline (Etapa 11.4). A closed table maps each kind to
// its existing domain entry point; adding a kind is an explicit code change.
// gameServerId is always the authenticated session's. Delivery dedup is
// uniform: (session server, eventId) in agent_domain_event_receipts, with a
// SHA-256 of the canonical {kind, data}. The receipt of an accepted event is
// written by the domain's own transaction (AgentEventHook), so a committed
// effect always has its receipt and a retry after any crash or restart is a
// duplicate, never a second effect. Final refusals are persisted too (the
// same eventId keeps the same answer); retryable ones are not.
@Injectable()
export class AgentDomainEventService {
  private readonly logger = new Logger(AgentDomainEventService.name);
  private readonly handlers: Readonly<Record<AgentEventKind, Handler>>;
  constructor(
    private readonly database: DataSource,
    links: CharacterLinkService,
    professions: ProfessionExperienceService,
    trades: TradeSettlementService,
    custody: MarketplaceCustodyService,
    settlement: MarketplaceSettlementService,
    release: MarketplaceReleaseService,
  ) {
    // The payload was validated for its kind by domainEventPayload().
    const data = <K extends AgentEventKind>(
      event: DomainEventPayload,
      kind: K,
    ) => (kind === event.kind ? event.data : null) as unknown as DataOf[K];
    this.handlers = {
      // The backend resolves the challenge, its player and link; the Agent
      // only proves what the player typed and who is logged in.
      CHARACTER_OWNERSHIP_PROOF: async (event, gameServerId, hook) =>
        verdict(
          await links.confirmFromAgent(
            { gameServerId, ...data(event, 'CHARACTER_OWNERSHIP_PROOF') },
            hook,
          ),
        ),
      // eventId is the profession's external event identity.
      PROFESSION_EXPERIENCE: async (event, gameServerId, hook) => {
        const result = await professions.grantFromAgent(
          {
            gameServerId,
            eventId: event.eventId,
            ...data(event, 'PROFESSION_EXPERIENCE'),
          },
          hook,
        );
        return verdict(
          result.outcome === 'REJECTED'
            ? result
            : { outcome: result.outcome, status: 'APPLIED' },
        );
      },
      TRADE_SETTLEMENT: async (event, gameServerId, hook) => {
        const { workId, outcome } = data(event, 'TRADE_SETTLEMENT');
        return verdict(
          await trades.confirmFromAgent(
            {
              gameServerId,
              tradeId: workId,
              settlementEventId: event.eventId,
              outcome: outcome as SettlementOutcome,
            },
            hook,
          ),
        );
      },
      MARKETPLACE_CUSTODY: async (event, gameServerId, hook) => {
        const { workId, outcome } = data(event, 'MARKETPLACE_CUSTODY');
        return verdict(
          await custody.confirmFromAgent(
            {
              gameServerId,
              listingId: workId,
              custodyEventId: event.eventId,
              outcome: outcome as CustodyOutcome,
            },
            hook,
          ),
        );
      },
      MARKETPLACE_SETTLEMENT: async (event, gameServerId, hook) => {
        const { workId, outcome } = data(event, 'MARKETPLACE_SETTLEMENT');
        return verdict(
          await settlement.confirmFromAgent(
            {
              gameServerId,
              purchaseId: workId,
              settlementEventId: event.eventId,
              outcome: outcome as MarketSettlementOutcome,
            },
            hook,
          ),
        );
      },
      MARKETPLACE_RELEASE: async (event, gameServerId, hook) => {
        const { workId, outcome } = data(event, 'MARKETPLACE_RELEASE');
        return verdict(
          await release.confirmFromAgent(
            {
              gameServerId,
              releaseId: workId,
              releaseEventId: event.eventId,
              outcome: outcome as ReleaseOutcome,
            },
            hook,
          ),
        );
      },
    };
  }
  private receipts(manager: EntityManager = this.database.manager) {
    return manager.getRepository<AgentDomainEventReceipt>(
      'AgentDomainEventReceipt',
    );
  }
  async handle(
    gameServerId: string,
    event: DomainEventPayload,
  ): Promise<DomainEventOutcome> {
    const hash = createHash('sha256')
      .update(canonicalJson({ kind: event.kind, data: event.data }, 16384))
      .digest('hex');
    const known = await this.known(gameServerId, event, hash);
    if (known) return known;
    const insert = (
      manager: EntityManager,
      status: ReceiptStatus,
      reason: string | null,
    ) =>
      manager.query(
        `INSERT INTO agent_domain_event_receipts(game_server_id, event_id, kind, content_hash, status, reason)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING event_id`,
        [gameServerId, event.eventId, event.kind, hash, status, reason],
      ) as Promise<unknown[]>;
    let result: Verdict;
    try {
      result = await this.handlers[event.kind](
        event,
        gameServerId,
        async (manager) => {
          // A concurrent delivery of the same eventId committed first: roll
          // this one back and answer from its receipt.
          if (!(await insert(manager, ReceiptStatus.APPLIED, null)).length)
            throw new ReceiptRace();
        },
      );
    } catch (error) {
      if (!(error instanceof ReceiptRace)) throw error;
      return (await this.known(gameServerId, event, hash))!;
    }
    if (result.accepted)
      return { type: 'ACK', duplicate: result.already, status: result.status };
    if (result.reason === 'SERVER_MISMATCH') return { type: 'SERVER_MISMATCH' };
    if (result.reason === 'EVENT_CONFLICT') return { type: 'CONFLICT' };
    if (RETRYABLE.has(result.reason))
      return {
        type: 'REJECTED',
        reason: result.reason,
        retryable: true,
        duplicate: false,
      };
    if (
      !(
        await insert(
          this.database.manager,
          ReceiptStatus.REJECTED,
          result.reason,
        )
      ).length
    )
      return (await this.known(gameServerId, event, hash))!;
    return {
      type: 'REJECTED',
      reason: result.reason,
      retryable: false,
      duplicate: false,
    };
  }
  private async known(
    gameServerId: string,
    event: DomainEventPayload,
    hash: string,
  ): Promise<DomainEventOutcome | null> {
    const receipt = await this.receipts().findOneBy({
      gameServerId,
      eventId: event.eventId,
    });
    if (!receipt) return null;
    if (receipt.kind !== event.kind || receipt.contentHash !== hash)
      return { type: 'CONFLICT' };
    return receipt.status === ReceiptStatus.APPLIED
      ? { type: 'ACK', duplicate: true, status: null }
      : {
          type: 'REJECTED',
          reason: receipt.reason!,
          retryable: false,
          duplicate: true,
        };
  }
}
