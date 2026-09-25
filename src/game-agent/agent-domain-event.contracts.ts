// Closed catalog of Host Agent domain events (Etapa 11.4). Adding a kind
// is an explicit code change (validator + handler + CHECK); there is no
// generic entity/action/payload event and no command or script.
export const AGENT_EVENT_KINDS = [
  // Proof typed by the player in game; the backend resolves the challenge.
  'CHARACTER_OWNERSHIP_PROOF',
  // Gameplay fact; eventId is the profession's external event identity.
  'PROFESSION_EXPERIENCE',
  // Completion of backend-defined work (workId = the work's entity id).
  'TRADE_SETTLEMENT',
  'MARKETPLACE_CUSTODY',
  'MARKETPLACE_SETTLEMENT',
  'MARKETPLACE_RELEASE',
] as const;
export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];
export const isAgentEventKind = (value: unknown): value is AgentEventKind =>
  AGENT_EVENT_KINDS.includes(value as AgentEventKind);

// Closed catalog of work the backend asks the Host Agent to perform. Items
// are derived from domain tables at read time (never from memory).
export const AGENT_WORK_KINDS = [
  'TRADE_SETTLEMENT',
  'MARKETPLACE_CUSTODY',
  'MARKETPLACE_SETTLEMENT',
  'MARKETPLACE_RELEASE',
] as const;
export type AgentWorkKind = (typeof AGENT_WORK_KINDS)[number];
export const isAgentWorkKind = (value: unknown): value is AgentWorkKind =>
  AGENT_WORK_KINDS.includes(value as AgentWorkKind);
export const MAX_WORK_PAGE_ITEMS = 50;
// WORK_ITEMS payload budget, well under the 128 KiB frame limit.
export const MAX_WORK_PAGE_BYTES = 96 * 1024;

export enum ReceiptStatus {
  APPLIED = 'APPLIED',
  REJECTED = 'REJECTED',
}
