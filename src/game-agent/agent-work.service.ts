import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import type {
  AgentWorkAfter,
  AgentWorkRow,
} from '../actors/agent-event.contracts.js';
import { MarketplaceWorkSource } from '../player-marketplace/marketplace-work.source.js';
import { TradeWorkSource } from '../player-trades/trade-work.source.js';
import {
  AGENT_WORK_KINDS,
  MAX_WORK_PAGE_BYTES,
  MAX_WORK_PAGE_ITEMS,
} from './agent-domain-event.contracts.js';
import type { AgentWorkKind } from './agent-domain-event.contracts.js';
import { AgentProtocolError } from './agent-protocol.contracts.js';
import type { WorkSyncPayload } from './agent-protocol.contracts.js';

export interface WorkItem {
  workId: string;
  kind: AgentWorkKind;
  createdAt: string;
  data: Record<string, unknown>;
}
export interface WorkPage {
  items: WorkItem[];
  nextCursor: string | null;
}
type Source = (
  gameServerId: string,
  after: AgentWorkAfter | null,
  limit: number,
) => Promise<AgentWorkRow[]>;
interface Position {
  kind: number;
  after: AgentWorkAfter | null;
}
const invalid = (): never => {
  throw new AgentProtocolError('PROTOCOL_ERROR');
};

// Pending Host Agent work of one server (Etapa 11.4), always rebuilt from
// the domain tables: nothing is marked delivered because it was listed, and
// a dropped socket loses nothing (the next WORK_SYNC returns the same work,
// with the same workId). Kinds are read in the fixed AGENT_WORK_KINDS order;
// inside a kind, a keyset (ordering instant, id) cursor never relies on
// offsets. Work committed while a pass is running may appear only in the
// next pass (or the live push). Pages are bounded by count and bytes.
@Injectable()
export class AgentWorkService {
  private readonly sources: Readonly<Record<AgentWorkKind, Source>>;
  constructor(trades: TradeWorkSource, market: MarketplaceWorkSource) {
    this.sources = {
      TRADE_SETTLEMENT: (s, a, l) => trades.pending(s, a, l),
      MARKETPLACE_CUSTODY: (s, a, l) => market.custody(s, a, l),
      MARKETPLACE_SETTLEMENT: (s, a, l) => market.settlement(s, a, l),
      MARKETPLACE_RELEASE: (s, a, l) => market.release(s, a, l),
    };
  }
  async page(
    gameServerId: string,
    request: WorkSyncPayload,
  ): Promise<WorkPage> {
    const only =
      request.kind === undefined
        ? null
        : AGENT_WORK_KINDS.indexOf(request.kind);
    const start = request.cursor
      ? decode(request.cursor)
      : { kind: only ?? 0, after: null };
    if (only !== null && start.kind !== only) invalid();
    const limit = request.limit ?? MAX_WORK_PAGE_ITEMS;
    const items: WorkItem[] = [];
    let bytes = 0;
    let { kind, after } = start;
    while (kind < AGENT_WORK_KINDS.length) {
      const name = AGENT_WORK_KINDS[kind];
      const remaining = limit - items.length;
      const rows = await this.sources[name](gameServerId, after, remaining + 1);
      for (const row of rows.slice(0, remaining)) {
        const item: WorkItem = {
          workId: row.id,
          kind: name,
          createdAt: row.createdAt.toISOString(),
          data: row.data,
        };
        const size = Buffer.byteLength(JSON.stringify(item));
        if (bytes + size > MAX_WORK_PAGE_BYTES)
          return { items, nextCursor: encode({ kind, after }) };
        items.push(item);
        bytes += size;
        after = { pos: row.pos, id: row.id };
      }
      if (rows.length > remaining)
        return { items, nextCursor: encode({ kind, after }) };
      if (only !== null) break;
      kind += 1;
      after = null;
      if (items.length === limit)
        return {
          items,
          nextCursor:
            kind < AGENT_WORK_KINDS.length ? encode({ kind, after }) : null,
        };
    }
    return { items, nextCursor: null };
  }
}
// Opaque to the Agent; validated strictly on the way back.
function encode(position: Position): string {
  return Buffer.from(
    JSON.stringify([
      position.kind,
      position.after?.pos ?? null,
      position.after?.id ?? null,
    ]),
  ).toString('base64url');
}
function decode(cursor: string): Position {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return invalid();
  }
  if (!Array.isArray(value) || value.length !== 3) return invalid();
  const [kind, pos, id] = value as unknown[];
  if (
    !Number.isInteger(kind) ||
    (kind as number) < 0 ||
    (kind as number) >= AGENT_WORK_KINDS.length
  )
    return invalid();
  if (pos === null && id === null) return { kind: kind as number, after: null };
  if (
    typeof pos !== 'string' ||
    !/^\d{1,19}$/.test(pos) ||
    typeof id !== 'string' ||
    !isUUID(id)
  )
    return invalid();
  return { kind: kind as number, after: { pos, id } };
}
