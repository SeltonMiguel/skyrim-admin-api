// Backend-owned economy (10.12). The ledger is the source of truth; Skyrim
// gold is never read or synced. Amounts are integer units of the currency.
export enum Currency {
  GOLD = 'GOLD',
}
export enum EconomyOwnerType {
  CHARACTER = 'CHARACTER',
  SYSTEM = 'SYSTEM',
}
// Closed; Trade/Marketplace (10.13/10.14) may add escrow keys with a migration.
export enum SystemAccountKey {
  MINT = 'MINT',
  BURN = 'BURN',
}
export enum EconomyTransactionType {
  SYSTEM_CREDIT = 'SYSTEM_CREDIT',
  SYSTEM_DEBIT = 'SYSTEM_DEBIT',
  TRANSFER = 'TRANSFER',
}
export enum EntryDirection {
  CREDIT = 'CREDIT',
  DEBIT = 'DEBIT',
}
// Limits are also PostgreSQL CHECKs and stay within Number.MAX_SAFE_INTEGER.
export const MAX_CHARACTER_BALANCE = 1_000_000_000_000;
export const MAX_TRANSACTION_AMOUNT = MAX_CHARACTER_BALANCE;
export const MAX_SYSTEM_BALANCE_MAGNITUDE = 9_000_000_000_000_000;
export const REFERENCE_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;

export type AccountRef =
  | { ownerType: EconomyOwnerType.CHARACTER; characterExternalId: string }
  | { ownerType: EconomyOwnerType.SYSTEM; systemKey: SystemAccountKey };
export interface LedgerReference {
  type: string;
  id: string;
}
export type LedgerRejection =
  | 'INVALID_INPUT'
  | 'INSUFFICIENT_FUNDS'
  | 'BALANCE_LIMIT'
  | 'SYSTEM_LIMIT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'PLAYER_UNAVAILABLE';
export type LedgerResult =
  | {
      outcome: 'POSTED' | 'ALREADY_POSTED';
      transactionId: string;
    }
  | { outcome: 'REJECTED'; reason: LedgerRejection };
// Character balance after the call (current balance for a replay).
export type EconomyMutationResult =
  | {
      outcome: 'POSTED' | 'ALREADY_POSTED';
      transactionId: string;
      balance: number;
    }
  | { outcome: 'REJECTED'; reason: LedgerRejection };

export const accountKey = (ref: AccountRef) =>
  ref.ownerType === EconomyOwnerType.CHARACTER
    ? `CHARACTER:${ref.characterExternalId}`
    : `SYSTEM:${ref.systemKey}`;
// PostgreSQL bigint arrives as a string; every value fits a safe integer.
export const bigintColumn = {
  to: (value: number) => value,
  from: (value: string | number) => Number(value),
};
