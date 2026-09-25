import type { LedgerRejection } from '../economy/economy.contracts.js';

// Player Marketplace (10.14): a seller character lists one GAME_ITEM line
// for GOLD; a buyer character pays GOLD on the backend ledger. The item is
// only ever held and moved by the Agent (Etapa 11): a listing becomes
// ACTIVE only after the Agent confirms durable, reversible custody.
export enum ListingStatus {
  PENDING_CUSTODY = 'PENDING_CUSTODY',
  ACTIVE = 'ACTIVE',
  RESERVED = 'RESERVED',
  SOLD = 'SOLD',
  CANCELLED = 'CANCELLED',
  FAILED = 'FAILED',
}
export const TERMINAL_LISTING_STATUSES = [
  ListingStatus.SOLD,
  ListingStatus.CANCELLED,
  ListingStatus.FAILED,
] as const;
export enum PurchaseStatus {
  AWAITING_GAME_CONFIRMATION = 'AWAITING_GAME_CONFIRMATION',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}
export enum MarketEscrowStatus {
  RESERVED = 'RESERVED',
  RELEASED = 'RELEASED',
  SETTLED = 'SETTLED',
}
export enum MarketRequestOperation {
  CREATE = 'CREATE',
  CANCEL = 'CANCEL',
  PURCHASE = 'PURCHASE',
}
export enum CustodyOutcome {
  CUSTODIED = 'CUSTODIED',
  FAILED = 'FAILED',
}
export enum MarketSettlementOutcome {
  SETTLED = 'SETTLED',
  FAILED = 'FAILED',
}
// Provisional limits, also PostgreSQL CHECKs. No free listings; the price
// ceiling is the ledger's per-character balance ceiling.
export const MAX_LISTING_QUANTITY = 10_000;
export const MIN_LISTING_PRICE = 1;
export const MAX_LISTING_PRICE = 1_000_000_000_000;
export const MARKET_REFERENCE_TYPE = 'PLAYER_MARKETPLACE';

type Rejected<R extends string> = {
  outcome: 'REJECTED';
  reason: R;
};
export type CustodyResult =
  | {
      outcome: 'APPLIED' | 'ALREADY_APPLIED';
      status: ListingStatus.ACTIVE | ListingStatus.FAILED;
    }
  | Rejected<
      | 'INVALID_INPUT'
      | 'LISTING_NOT_FOUND'
      | 'LISTING_NOT_PENDING'
      | 'EVENT_CONFLICT'
    >;
export type MarketSettlementResult =
  | {
      outcome: 'APPLIED' | 'ALREADY_APPLIED';
      status: PurchaseStatus.COMPLETED | PurchaseStatus.FAILED;
    }
  | (Rejected<
      | 'INVALID_INPUT'
      | 'PURCHASE_NOT_FOUND'
      | 'PURCHASE_NOT_AWAITING'
      | 'EVENT_CONFLICT'
      | 'LEDGER_REJECTED'
    > & {
      // Internal detail for LEDGER_REJECTED (e.g. BALANCE_LIMIT).
      ledgerReason?: LedgerRejection;
    });
