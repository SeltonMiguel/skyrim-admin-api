import type { EntityManager } from 'typeorm';

// Hook the Agent event pipeline (Etapa 11.4) passes to a trusted domain
// entry point. The domain calls it inside its own transaction, right before
// an accepted outcome (applied, or already applied) commits, so the event
// receipt and the domain mutation are atomic: there is no window where the
// domain committed and the receipt does not exist. Throwing rolls both back.
export type AgentEventHook = (manager: EntityManager) => Promise<void>;

// One unit of Host Agent work, read from canonical domain tables (never
// from memory). `id` is the domain entity id and the Agent's workId; `pos`
// is the entity's stable ordering instant in epoch microseconds (as text),
// used with `id` as a keyset cursor. `data` is allowlisted, typed and
// holds no economic term the Agent could change (no price, no GOLD).
export interface AgentWorkRow {
  id: string;
  pos: string;
  createdAt: Date;
  data: Record<string, unknown>;
}
export interface AgentWorkAfter {
  pos: string;
  id: string;
}
