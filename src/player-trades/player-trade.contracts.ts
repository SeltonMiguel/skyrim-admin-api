import type { LedgerRejection } from '../economy/economy.contracts.js';

// Player trades (10.13) between two character identities of one server.
// GOLD is backend ledger money; GAME_ITEM lines are declarations whose
// physical settlement belongs to the Agent (Etapa 11).
export enum TradeStatus {
  NEGOTIATING = 'NEGOTIATING',
  AWAITING_GAME_CONFIRMATION = 'AWAITING_GAME_CONFIRMATION',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  FAILED = 'FAILED',
}
export const TERMINAL_TRADE_STATUSES = [
  TradeStatus.COMPLETED,
  TradeStatus.CANCELLED,
  TradeStatus.FAILED,
] as const;
export enum TradeSide {
  INITIATOR = 'INITIATOR',
  TARGET = 'TARGET',
}
export enum TradeAssetType {
  LEDGER_CURRENCY = 'LEDGER_CURRENCY',
  GAME_ITEM = 'GAME_ITEM',
}
export enum EscrowStatus {
  RESERVED = 'RESERVED',
  RELEASED = 'RELEASED',
  SETTLED = 'SETTLED',
}
export enum TradeRequestOperation {
  CREATE = 'CREATE',
  OFFER = 'OFFER',
  ACCEPT = 'ACCEPT',
  CANCEL = 'CANCEL',
}
export enum SettlementOutcome {
  SETTLED = 'SETTLED',
  FAILED = 'FAILED',
}
// Provisional limits; changing them needs no migration except the CHECKs
// on gold (ledger ceiling) and quantity.
export const MAX_TRADE_ITEM_LINES = 20;
export const MAX_TRADE_ITEM_QUANTITY = 10_000;
export const TRADE_REFERENCE_TYPE = 'PLAYER_TRADE';

export interface TradeItemInput {
  itemId: string;
  quantity: number;
}
export interface TradeOfferInput {
  gold: number;
  items: TradeItemInput[];
}
export type SettlementResult =
  | {
      outcome: 'APPLIED' | 'ALREADY_APPLIED';
      status: TradeStatus.COMPLETED | TradeStatus.FAILED;
    }
  | {
      outcome: 'REJECTED';
      reason:
        | 'INVALID_INPUT'
        | 'TRADE_NOT_FOUND'
        | 'TRADE_NOT_AWAITING'
        | 'EVENT_CONFLICT'
        // The trade belongs to another GameServer than the Agent session.
        | 'SERVER_MISMATCH'
        | 'LEDGER_REJECTED';
      // Internal detail for LEDGER_REJECTED (e.g. BALANCE_LIMIT).
      ledgerReason?: LedgerRejection;
    };
export type { LedgerRejection };
export const otherSide = (side: TradeSide) =>
  side === TradeSide.INITIATOR ? TradeSide.TARGET : TradeSide.INITIATOR;
