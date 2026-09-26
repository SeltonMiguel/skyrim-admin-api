import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REALTIME_EVENT_TYPES } from '../realtime-events/realtime-event-bus.js';
import { SystemAccountKey } from '../economy/economy.contracts.js';
import { AuditAction } from '../audit/audit.types.js';
import {
  CustodyOutcome,
  ListingStatus,
  MAX_LISTING_PRICE,
  MAX_LISTING_QUANTITY,
  MarketEscrowStatus,
  MarketRequestOperation,
  MarketSettlementOutcome,
  MIN_LISTING_PRICE,
  PurchaseStatus,
  TERMINAL_LISTING_STATUSES,
} from './player-marketplace.contracts.js';

describe('Marketplace contracts', () => {
  it('has closed listing, purchase and escrow lifecycles', () => {
    expect(Object.values(ListingStatus)).toEqual([
      'PENDING_CUSTODY',
      'ACTIVE',
      'RESERVED',
      'SOLD',
      'CANCELLED',
      'FAILED',
    ]);
    expect(TERMINAL_LISTING_STATUSES).toEqual(['SOLD', 'CANCELLED', 'FAILED']);
    expect(Object.values(PurchaseStatus)).toEqual([
      'AWAITING_GAME_CONFIRMATION',
      'COMPLETED',
      'FAILED',
    ]);
    expect(Object.values(MarketEscrowStatus)).toEqual([
      'RESERVED',
      'RELEASED',
      'SETTLED',
    ]);
    expect(Object.values(CustodyOutcome)).toEqual(['CUSTODIED', 'FAILED']);
    expect(Object.values(MarketSettlementOutcome)).toEqual([
      'SETTLED',
      'FAILED',
    ]);
    expect(Object.values(MarketRequestOperation)).toEqual([
      'CREATE',
      'CANCEL',
      'PURCHASE',
    ]);
  });
  it('keeps limits centralized with no free listings', () => {
    expect(MAX_LISTING_QUANTITY).toBe(10_000);
    expect(MIN_LISTING_PRICE).toBe(1);
    expect(MAX_LISTING_PRICE).toBe(1_000_000_000_000);
    expect(Object.values(SystemAccountKey)).toContain('MARKET_ESCROW');
  });
  it('publishes typed marketplace events and audit actions', () => {
    expect(
      REALTIME_EVENT_TYPES.filter((t) => t.startsWith('MARKETPLACE_')),
    ).toEqual([
      'MARKETPLACE_LISTING_ACTIVE',
      'MARKETPLACE_LISTING_CANCELLED',
      'MARKETPLACE_LISTING_RESERVED',
      'MARKETPLACE_LISTING_SOLD',
      'MARKETPLACE_LISTING_FAILED',
      'MARKETPLACE_PURCHASE_FAILED',
    ]);
    expect(
      Object.values(AuditAction).filter((a) =>
        a.startsWith('PLAYER_MARKETPLACE_'),
      ),
    ).toEqual([
      'PLAYER_MARKETPLACE_LISTING_CREATED',
      'PLAYER_MARKETPLACE_LISTING_CANCELLED',
      'PLAYER_MARKETPLACE_PURCHASE_CREATED',
      'PLAYER_MARKETPLACE_LISTING_CUSTODIED',
      'PLAYER_MARKETPLACE_LISTING_CUSTODY_FAILED',
      'PLAYER_MARKETPLACE_PURCHASE_SETTLED',
      'PLAYER_MARKETPLACE_PURCHASE_FAILED',
      'PLAYER_MARKETPLACE_ITEM_RELEASED',
      'PLAYER_MARKETPLACE_ITEM_RELEASE_FAILED',
      // 12.4 operator recovery of a FAILED release.
      'PLAYER_MARKETPLACE_RELEASE_ACKNOWLEDGED',
      'PLAYER_MARKETPLACE_RELEASE_RESOLVED',
    ]);
  });
});

describe('Marketplace boundaries', () => {
  const sources = globSync(fileURLToPath(new URL('./**/*.ts', import.meta.url)))
    .filter((file) => !file.endsWith('.spec.ts'))
    .map((file) => [file, readFileSync(file, 'utf8')] as const);
  it('never settles through game commands, staff item mutations or trades', () => {
    for (const [, source] of sources) {
      for (const [, module] of source.matchAll(/from '([^']+)'/g))
        expect(module).not.toMatch(
          /game-command|character-management|player-character-operations|administrative-operations|player-trades|\/realtime\/|^ws$/,
        );
      expect(source).not.toMatch(
        /CHARACTER_ITEM_GIVE|CHARACTER_INVENTORY_REMOVE_ITEM|GameCommand/,
      );
    }
  });
  it('exposes custody and settlement only as internal services', () => {
    const controller = sources.find(([file]) =>
      file.endsWith('player-marketplace.controller.ts'),
    )![1];
    expect(controller).not.toMatch(
      /confirmFromAgent|CustodyService|SettlementService|EscrowService/,
    );
  });
  it('stores no client item name or description as authority', () => {
    const listing = sources.find(([file]) =>
      file.endsWith('player-marketplace-listing.entity.ts'),
    )![1];
    expect(listing).not.toMatch(/name:\s*'item_name'|description'|metadata/);
  });
});
