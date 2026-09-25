import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type {
  AgentWorkAfter,
  AgentWorkRow,
} from '../actors/agent-event.contracts.js';
import {
  ListingStatus,
  PurchaseStatus,
  ReleaseStatus,
} from './player-marketplace.contracts.js';

type Row = {
  id: string;
  pos: string;
  created_at: Date;
  listing_id: string;
  seller_character_id: string;
  item_external_id: string;
  quantity: number;
  buyer_character_id?: string;
};
const KEYSET = (column: string) =>
  `($3::bigint IS NULL OR ((extract(epoch FROM ${column}) * 1000000)::bigint, w.id) > ($3::bigint, $4::uuid))`;
const POS = (column: string) =>
  `(extract(epoch FROM ${column}) * 1000000)::bigint::text AS pos`;

// Read-only projections of the physical work the Marketplace needs from the
// Host Agent (Etapa 11.4). Item, quantity and characters come from the
// listing (immutable terms); never the price or any GOLD amount.
@Injectable()
export class MarketplaceWorkSource {
  constructor(private readonly database: DataSource) {}
  private async rows(sql: string, params: unknown[]): Promise<Row[]> {
    return this.database.query(sql, params);
  }
  private params(
    gameServerId: string,
    status: string,
    after: AgentWorkAfter | null,
    limit: number,
  ) {
    return [gameServerId, status, after?.pos ?? null, after?.id ?? null, limit];
  }
  // PENDING_CUSTODY listing: take the item from the seller into custody.
  async custody(
    gameServerId: string,
    after: AgentWorkAfter | null,
    limit: number,
  ): Promise<AgentWorkRow[]> {
    const rows = await this.rows(
      `SELECT w.id, ${POS('w.created_at')}, w.created_at, w.id AS listing_id,
              w.seller_character_id, w.item_external_id, w.quantity
       FROM player_marketplace_listings w
       WHERE w.game_server_id = $1 AND w.status = $2 AND ${KEYSET('w.created_at')}
       ORDER BY w.created_at, w.id LIMIT $5`,
      this.params(gameServerId, ListingStatus.PENDING_CUSTODY, after, limit),
    );
    return rows.map((r) => this.row(r, { listingId: r.listing_id }));
  }
  // AWAITING purchase: the custodied item goes to the buyer once settled.
  async settlement(
    gameServerId: string,
    after: AgentWorkAfter | null,
    limit: number,
  ): Promise<AgentWorkRow[]> {
    const rows = await this.rows(
      `SELECT w.id, ${POS('w.created_at')}, w.created_at, l.id AS listing_id,
              l.seller_character_id, l.item_external_id, l.quantity, w.buyer_character_id
       FROM player_marketplace_purchases w
       JOIN player_marketplace_listings l ON l.id = w.listing_id
       WHERE l.game_server_id = $1 AND w.status = $2 AND ${KEYSET('w.created_at')}
       ORDER BY w.created_at, w.id LIMIT $5`,
      this.params(
        gameServerId,
        PurchaseStatus.AWAITING_GAME_CONFIRMATION,
        after,
        limit,
      ),
    );
    return rows.map((r) =>
      this.row(r, {
        purchaseId: r.id,
        listingId: r.listing_id,
        buyerCharacterId: r.buyer_character_id,
      }),
    );
  }
  // PENDING release: return the custodied item to the seller.
  async release(
    gameServerId: string,
    after: AgentWorkAfter | null,
    limit: number,
  ): Promise<AgentWorkRow[]> {
    const rows = await this.rows(
      `SELECT w.id, ${POS('w.created_at')}, w.created_at, l.id AS listing_id,
              w.seller_character_id, l.item_external_id, l.quantity
       FROM player_marketplace_item_releases w
       JOIN player_marketplace_listings l ON l.id = w.listing_id
       WHERE w.game_server_id = $1 AND w.status = $2 AND ${KEYSET('w.created_at')}
       ORDER BY w.created_at, w.id LIMIT $5`,
      this.params(gameServerId, ReleaseStatus.PENDING, after, limit),
    );
    return rows.map((r) =>
      this.row(r, { releaseId: r.id, listingId: r.listing_id }),
    );
  }
  private row(r: Row, ids: Record<string, unknown>): AgentWorkRow {
    return {
      id: r.id,
      pos: r.pos,
      createdAt: r.created_at,
      data: {
        ...ids,
        sellerCharacterId: r.seller_character_id,
        itemExternalId: r.item_external_id,
        quantity: r.quantity,
      },
    };
  }
}
