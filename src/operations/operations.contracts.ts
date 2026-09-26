import { Permission as P } from '../rbac/permissions.js';

// Operational recovery (12.4). Every operator intervention has a domain, an
// action kind from this closed set, a bounded reason and an Idempotency-Key,
// runs in one transaction with its Audit, and returns an explicit result.
// There is no generic "retry" and nothing here re-sends an effect whose
// execution cannot be disproven.
export enum OperatorDomain {
  SERVER_CONTROL = 'SERVER_CONTROL',
  PLAYER_TRADE = 'PLAYER_TRADE',
  MARKETPLACE_CUSTODY = 'MARKETPLACE_CUSTODY',
  MARKETPLACE_SETTLEMENT = 'MARKETPLACE_SETTLEMENT',
  MARKETPLACE_RELEASE = 'MARKETPLACE_RELEASE',
  VIP_DELIVERY = 'VIP_DELIVERY',
  PLAYER_ACCOUNT = 'PLAYER_ACCOUNT',
  PLAYER_ECONOMY = 'PLAYER_ECONOMY',
  PLAYER_CHAT = 'PLAYER_CHAT',
}
// RETRY_SAFE: a new attempt of an effect proven not to have happened.
// REQUEUE_SAME_WORK: offer the same work (same workId) to the Agent again;
//   the Agent journal makes a repeat harmless; nothing new is created.
// ACKNOWLEDGE: audited "seen", no state change.
// RESOLVE_SUCCEEDED / RESOLVE_FAILED: operator conclusion recorded apart
//   from the original outcome, which is never overwritten.
// CANCEL: reserved; no domain offers it in 12.4 (see docs).
// SET_STATUS / ADJUST / HIDE: account status, ledger adjustment, chat hide.
export enum OperatorActionKind {
  RETRY_SAFE = 'RETRY_SAFE',
  REQUEUE_SAME_WORK = 'REQUEUE_SAME_WORK',
  ACKNOWLEDGE = 'ACKNOWLEDGE',
  RESOLVE_SUCCEEDED = 'RESOLVE_SUCCEEDED',
  RESOLVE_FAILED = 'RESOLVE_FAILED',
  CANCEL = 'CANCEL',
  SET_STATUS = 'SET_STATUS',
  ADJUST = 'ADJUST',
  HIDE = 'HIDE',
}
// Permission required by each domain's queue and actions.
export const DOMAIN_PERMISSION: Readonly<Record<OperatorDomain, P>> = {
  SERVER_CONTROL: P.SERVER_CONTROL_RESOLVE,
  PLAYER_TRADE: P.PLAYER_TRADE_RECOVER,
  MARKETPLACE_CUSTODY: P.PLAYER_MARKETPLACE_RECOVER,
  MARKETPLACE_SETTLEMENT: P.PLAYER_MARKETPLACE_RECOVER,
  MARKETPLACE_RELEASE: P.PLAYER_MARKETPLACE_RECOVER,
  VIP_DELIVERY: P.VIP_DELIVERY_RECOVER,
  PLAYER_ACCOUNT: P.PLAYER_ACCOUNT_MODERATE,
  PLAYER_ECONOMY: P.PLAYER_ECONOMY_ADJUST,
  PLAYER_CHAT: P.PLAYER_CHAT_MODERATE,
};
// Metric label values (closed, lowercase).
export const metricDomain = (domain: OperatorDomain) => domain.toLowerCase();
export const metricAction = (action: OperatorActionKind) =>
  action.toLowerCase();
export const MAX_REASON_LENGTH = 500;
