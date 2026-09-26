import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { pageResult } from '../admin-queries/query-pagination.js';
import type { AuthenticatedStaff } from '../auth/auth.types.js';
import type { ApplicationConfig } from '../config/environment.js';
import { AgentSessionRegistry } from '../game-agent/agent-session.registry.js';
import {
  SERVER_CONTROL_ERRORS,
  SERVER_CONTROL_POLICY,
  SERVER_CONTROL_TYPES,
} from '../server-control/server-control.contracts.js';
import type { ServerControlErrorCode } from '../server-control/server-control.contracts.js';
import {
  MAX_DELIVERY_ATTEMPTS,
  rewardCommand,
} from '../vip-entitlements/vip-delivery.contracts.js';
import type { VipReward } from '../vip-store/vip-offer.contracts.js';
import { deliveryEvidence } from './recovery.service.js';
import type {
  ChatQueryDto,
  ReceiptQueryDto,
  ReleaseQueueQueryDto,
  ServerControlQueueQueryDto,
  VipQueueQueryDto,
  WorkQueueQueryDto,
} from './dto/operations.dto.js';

type Row = Record<string, unknown>;
const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : null;
const num = (value: unknown) => (value === null ? null : Number(value));

// Read side of operational recovery (12.4): bounded, paginated, oldest
// first, from the canonical tables only (never the Agent payload). "stale"
// is classification only (OPERATIONS_STALE_AFTER_MS): nothing is failed,
// retried or hidden because of its age.
@Injectable()
export class OperationsQueryService {
  private readonly staleAfterMs: number;
  constructor(
    private readonly database: DataSource,
    private readonly sessions: AgentSessionRegistry,
    config: ConfigService<{ application: ApplicationConfig }, true>,
  ) {
    this.staleAfterMs = config.get('application', {
      infer: true,
    }).operations.staleAfterMs;
  }
  private age(since: unknown) {
    if (!(since instanceof Date)) return { ageSeconds: null, stale: false };
    const ms = Math.max(0, Date.now() - since.getTime());
    return {
      ageSeconds: Math.floor(ms / 1000),
      stale: ms >= this.staleAfterMs,
    };
  }
  private async page(
    sql: string,
    params: unknown[],
    query: { page: number; limit: number },
    map: (row: Row) => Record<string, unknown>,
  ) {
    const offset = (query.page - 1) * query.limit;
    const [rows, [{ total }]] = await Promise.all([
      this.database.query(
        `${sql} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, query.limit, offset],
      ) as Promise<Row[]>,
      this.database.query(
        `SELECT count(*)::int AS total FROM (${sql}) counted`,
        params,
      ) as Promise<{ total: number }[]>,
    ]);
    return pageResult(rows.map(map), total, query);
  }
  private rejection(row: Row) {
    return row.rejection_reason
      ? {
          reason: row.rejection_reason as string,
          count: Number(row.rejection_count),
          lastRejectedAt: iso(row.last_rejected_at),
        }
      : null;
  }

  // Server Control UNCERTAIN, of the types the caller may read.
  async serverControl(
    auth: AuthenticatedStaff,
    query: ServerControlQueueQueryDto,
  ) {
    const types = SERVER_CONTROL_TYPES.filter((type) =>
      auth.permissions.includes(SERVER_CONTROL_POLICY[type].permission),
    );
    if (!types.length)
      throw new ForbiddenException('Missing required permissions');
    return this.page(
      `SELECT id, game_server_id, type, status, error_code, requested_by_staff_id,
              created_at, dispatched_at, completed_at, resolution,
              resolved_by_staff_id, resolved_at, resolution_reason
       FROM server_control_operations
       WHERE status = 'UNCERTAIN' AND type = ANY($1)
         AND ($2::uuid IS NULL OR game_server_id = $2)
         AND ($3::boolean IS NULL OR (resolution IS NOT NULL) = $3)
       ORDER BY completed_at, id`,
      [types, query.gameServerId ?? null, query.resolved ?? null],
      query,
      (r) => ({
        operationId: r.id,
        gameServerId: r.game_server_id,
        type: r.type,
        status: r.status,
        errorCode: r.error_code,
        errorMessage:
          SERVER_CONTROL_ERRORS[r.error_code as ServerControlErrorCode] ?? null,
        requestedByStaffId: r.requested_by_staff_id,
        createdAt: iso(r.created_at),
        dispatchedAt: iso(r.dispatched_at),
        completedAt: iso(r.completed_at),
        ...this.age(r.completed_at),
        resolution: r.resolution,
        resolvedByStaffId: r.resolved_by_staff_id,
        resolvedAt: iso(r.resolved_at),
        resolutionReason: r.resolution_reason,
      }),
    );
  }

  // Trades AWAITING_GAME_CONFIRMATION: GOLD is already reserved in escrow;
  // only the Agent's settlement (same workId) completes or fails them.
  trades(query: WorkQueueQueryDto) {
    return this.page(
      `SELECT t.id, t.game_server_id, t.initiator_character_id, t.target_character_id,
              t.created_at, t.locked_at, t.updated_at,
              (SELECT coalesce(sum(e.amount), 0) FROM player_trade_currency_escrows e
                WHERE e.trade_id = t.id AND e.status = 'RESERVED')::bigint AS reserved_gold,
              (SELECT count(*) FROM player_trade_offers o JOIN player_trade_items i ON i.offer_id = o.id
                WHERE o.trade_id = t.id)::int AS item_lines,
              r.reason AS rejection_reason, r.rejection_count, r.last_rejected_at
       FROM player_trades t
       LEFT JOIN agent_work_rejections r ON r.kind = 'TRADE_SETTLEMENT' AND r.work_id = t.id
       WHERE t.status = 'AWAITING_GAME_CONFIRMATION'
         AND ($1::uuid IS NULL OR t.game_server_id = $1)
       ORDER BY t.locked_at, t.id`,
      [query.gameServerId ?? null],
      query,
      (r) => ({
        tradeId: r.id,
        workId: r.id,
        kind: 'TRADE_SETTLEMENT',
        gameServerId: r.game_server_id,
        agentConnected: this.sessions.isConnected(r.game_server_id as string),
        initiatorCharacterId: r.initiator_character_id,
        targetCharacterId: r.target_character_id,
        status: 'AWAITING_GAME_CONFIRMATION',
        createdAt: iso(r.created_at),
        lockedAt: iso(r.locked_at),
        updatedAt: iso(r.updated_at),
        ...this.age(r.locked_at),
        reservedGold: num(r.reserved_gold),
        itemLines: r.item_lines,
        lastRejection: this.rejection(r),
      }),
    );
  }
  custody(query: WorkQueueQueryDto) {
    return this.page(
      `SELECT l.id, l.game_server_id, l.seller_character_id, l.item_external_id, l.quantity,
              l.created_at, l.updated_at,
              r.reason AS rejection_reason, r.rejection_count, r.last_rejected_at
       FROM player_marketplace_listings l
       LEFT JOIN agent_work_rejections r ON r.kind = 'MARKETPLACE_CUSTODY' AND r.work_id = l.id
       WHERE l.status = 'PENDING_CUSTODY'
         AND ($1::uuid IS NULL OR l.game_server_id = $1)
       ORDER BY l.created_at, l.id`,
      [query.gameServerId ?? null],
      query,
      (r) => ({
        listingId: r.id,
        workId: r.id,
        kind: 'MARKETPLACE_CUSTODY',
        gameServerId: r.game_server_id,
        agentConnected: this.sessions.isConnected(r.game_server_id as string),
        sellerCharacterId: r.seller_character_id,
        itemExternalId: r.item_external_id,
        quantity: r.quantity,
        status: 'PENDING_CUSTODY',
        createdAt: iso(r.created_at),
        updatedAt: iso(r.updated_at),
        ...this.age(r.created_at),
        lastRejection: this.rejection(r),
      }),
    );
  }
  settlements(query: WorkQueueQueryDto) {
    return this.page(
      `SELECT p.id, p.listing_id, l.game_server_id, p.buyer_character_id, l.seller_character_id,
              l.item_external_id, l.quantity, p.created_at, p.updated_at,
              (SELECT coalesce(sum(e.amount), 0) FROM player_marketplace_currency_escrows e
                WHERE e.purchase_id = p.id AND e.status = 'RESERVED')::bigint AS reserved_gold,
              r.reason AS rejection_reason, r.rejection_count, r.last_rejected_at
       FROM player_marketplace_purchases p
       JOIN player_marketplace_listings l ON l.id = p.listing_id
       LEFT JOIN agent_work_rejections r ON r.kind = 'MARKETPLACE_SETTLEMENT' AND r.work_id = p.id
       WHERE p.status = 'AWAITING_GAME_CONFIRMATION'
         AND ($1::uuid IS NULL OR l.game_server_id = $1)
       ORDER BY p.created_at, p.id`,
      [query.gameServerId ?? null],
      query,
      (r) => ({
        purchaseId: r.id,
        workId: r.id,
        kind: 'MARKETPLACE_SETTLEMENT',
        listingId: r.listing_id,
        gameServerId: r.game_server_id,
        agentConnected: this.sessions.isConnected(r.game_server_id as string),
        buyerCharacterId: r.buyer_character_id,
        sellerCharacterId: r.seller_character_id,
        itemExternalId: r.item_external_id,
        quantity: r.quantity,
        status: 'AWAITING_GAME_CONFIRMATION',
        createdAt: iso(r.created_at),
        updatedAt: iso(r.updated_at),
        ...this.age(r.created_at),
        reservedGold: num(r.reserved_gold),
        lastRejection: this.rejection(r),
      }),
    );
  }
  releases(query: ReleaseQueueQueryDto) {
    return this.page(
      `SELECT w.id, w.listing_id, w.game_server_id, w.seller_character_id, w.reason, w.status,
              w.error_code, w.created_at, w.completed_at, l.item_external_id, l.quantity,
              w.resolution, w.resolved_by_staff_id, w.resolved_at, w.resolution_reason,
              r.reason AS rejection_reason, r.rejection_count, r.last_rejected_at
       FROM player_marketplace_item_releases w
       JOIN player_marketplace_listings l ON l.id = w.listing_id
       LEFT JOIN agent_work_rejections r ON r.kind = 'MARKETPLACE_RELEASE' AND r.work_id = w.id
       WHERE w.status = ANY($1)
         AND ($2::uuid IS NULL OR w.game_server_id = $2)
         AND ($3::boolean IS NULL OR (w.resolution IS NOT NULL) = $3)
       ORDER BY w.created_at, w.id`,
      [
        query.status ? [query.status] : ['PENDING', 'FAILED'],
        query.gameServerId ?? null,
        query.resolved ?? null,
      ],
      query,
      (r) => ({
        releaseId: r.id,
        workId: r.id,
        kind: 'MARKETPLACE_RELEASE',
        listingId: r.listing_id,
        gameServerId: r.game_server_id,
        agentConnected: this.sessions.isConnected(r.game_server_id as string),
        sellerCharacterId: r.seller_character_id,
        itemExternalId: r.item_external_id,
        quantity: r.quantity,
        releaseReason: r.reason,
        status: r.status,
        errorCode: r.error_code,
        createdAt: iso(r.created_at),
        completedAt: iso(r.completed_at),
        ...this.age(r.status === 'FAILED' ? r.completed_at : r.created_at),
        resolution: r.resolution,
        resolvedByStaffId: r.resolved_by_staff_id,
        resolvedAt: iso(r.resolved_at),
        resolutionReason: r.resolution_reason,
        lastRejection: this.rejection(r),
      }),
    );
  }

  private delivery(r: Row) {
    const command = r.command_status
      ? {
          status: r.command_status as string,
          error_code: r.command_error_code as string | null,
        }
      : undefined;
    const evidence =
      r.status === 'FAILED' || r.status === 'UNCERTAIN'
        ? deliveryEvidence(
            {
              status: r.status as never,
              gameCommandId: r.game_command_id as string | null,
            },
            command,
          )
        : null;
    const reward = r.reward as VipReward;
    const typed = !!rewardCommand(reward, r.character_external_id as string);
    return {
      deliveryId: r.id,
      entitlementId: r.entitlement_id,
      rewardIndex: r.reward_index,
      rewardType: reward.type,
      gameServerId: r.game_server_id,
      agentConnected: this.sessions.isConnected(r.game_server_id as string),
      characterExternalId: r.character_external_id,
      status: r.status,
      errorCode: r.error_code,
      attempt: r.attempt,
      gameCommandId: r.game_command_id,
      commandStatus: r.command_status ?? null,
      commandErrorCode: r.command_error_code ?? null,
      evidence,
      // What RETRY_SAFE would accept now (entitlement re-checked on retry).
      retryable:
        typed &&
        Number(r.attempt) < MAX_DELIVERY_ATTEMPTS &&
        r.resolution !== 'CONFIRMED_DELIVERED' &&
        (evidence === 'PRE_EFFECT_FAILURE' ||
          r.resolution === 'CONFIRMED_NOT_DELIVERED'),
      createdAt: iso(r.created_at),
      completedAt: iso(r.completed_at),
      ...this.age(
        r.status === 'PENDING' || r.status === 'COMMAND_CREATED'
          ? r.created_at
          : r.completed_at,
      ),
      resolution: r.resolution,
      resolvedByStaffId: r.resolved_by_staff_id,
      resolvedAt: iso(r.resolved_at),
      resolutionReason: r.resolution_reason,
    };
  }
  private static readonly DELIVERY = `SELECT d.id, d.entitlement_id, d.reward_index, d.reward, d.game_server_id,
              d.character_external_id, d.status, d.error_code, d.attempt, d.game_command_id,
              d.created_at, d.completed_at, d.resolution, d.resolved_by_staff_id,
              d.resolved_at, d.resolution_reason,
              c.status AS command_status, r.error_code AS command_error_code
       FROM vip_reward_deliveries d
       LEFT JOIN game_commands c ON c.id = d.game_command_id
       LEFT JOIN game_command_results r ON r.game_command_id = c.id`;
  vipDeliveries(query: VipQueueQueryDto) {
    return this.page(
      `${OperationsQueryService.DELIVERY}
       WHERE d.status = ANY($1)
         AND ($2::uuid IS NULL OR d.game_server_id = $2)
         AND ($3::boolean IS NULL OR (d.resolution IS NOT NULL) = $3)
       ORDER BY d.created_at, d.id`,
      [
        query.status ? [query.status] : ['FAILED', 'UNCERTAIN'],
        query.gameServerId ?? null,
        query.resolved ?? null,
      ],
      query,
      (r) => this.delivery(r),
    );
  }
  async vipDelivery(id: string) {
    const [row] = (await this.database.query(
      `${OperationsQueryService.DELIVERY} WHERE d.id = $1`,
      [id],
    )) as Row[];
    if (!row) throw new NotFoundException('VIP delivery not found');
    const attempts = (await this.database.query(
      `SELECT attempt, game_command_id, status, error_code, completed_at, resolution,
              resolved_by_staff_id, resolved_at, resolution_reason,
              retried_by_staff_id, retry_reason, created_at
       FROM vip_reward_delivery_attempts WHERE delivery_id = $1 ORDER BY attempt`,
      [id],
    )) as Row[];
    return {
      ...this.delivery(row),
      previousAttempts: attempts.map((a) => ({
        attempt: a.attempt,
        gameCommandId: a.game_command_id,
        status: a.status,
        errorCode: a.error_code,
        completedAt: iso(a.completed_at),
        resolution: a.resolution,
        resolvedByStaffId: a.resolved_by_staff_id,
        resolvedAt: iso(a.resolved_at),
        resolutionReason: a.resolution_reason,
        retriedByStaffId: a.retried_by_staff_id,
        retryReason: a.retry_reason,
        archivedAt: iso(a.created_at),
      })),
    };
  }

  // Final DOMAIN_EVENT rejections (receipts): kind, reason, when. Never the
  // payload or its hash. CONFLICT answers are not persisted (metrics only).
  receipts(query: ReceiptQueryDto) {
    return this.page(
      `SELECT game_server_id, event_id, kind, status, reason, created_at
       FROM agent_domain_event_receipts
       WHERE status = 'REJECTED'
         AND ($1::uuid IS NULL OR game_server_id = $1)
         AND ($2::text IS NULL OR kind = $2)
       ORDER BY created_at DESC, event_id DESC`,
      [query.gameServerId ?? null, query.kind ?? null],
      query,
      (r) => ({
        gameServerId: r.game_server_id,
        eventId: r.event_id,
        kind: r.kind,
        status: r.status,
        reason: r.reason,
        createdAt: iso(r.created_at),
      }),
    );
  }

  // One aggregated read of every operator queue (counts, stale, oldest).
  async summary() {
    const stale = this.staleAfterMs / 1000;
    const rows = (await this.database.query(
      `WITH q(queue, since) AS (
         SELECT 'server_control_uncertain', completed_at FROM server_control_operations
           WHERE status = 'UNCERTAIN' AND resolution IS NULL
         UNION ALL SELECT 'trade_settlement', locked_at FROM player_trades
           WHERE status = 'AWAITING_GAME_CONFIRMATION'
         UNION ALL SELECT 'marketplace_custody', created_at FROM player_marketplace_listings
           WHERE status = 'PENDING_CUSTODY'
         UNION ALL SELECT 'marketplace_settlement', created_at FROM player_marketplace_purchases
           WHERE status = 'AWAITING_GAME_CONFIRMATION'
         UNION ALL SELECT 'marketplace_release_pending', created_at FROM player_marketplace_item_releases
           WHERE status = 'PENDING'
         UNION ALL SELECT 'marketplace_release_failed', completed_at FROM player_marketplace_item_releases
           WHERE status = 'FAILED' AND resolution IS NULL
         UNION ALL SELECT 'vip_delivery_open', created_at FROM vip_reward_deliveries
           WHERE status IN ('PENDING', 'COMMAND_CREATED')
         UNION ALL SELECT 'vip_delivery_failed', completed_at FROM vip_reward_deliveries
           WHERE status = 'FAILED' AND resolution IS NULL
         UNION ALL SELECT 'vip_delivery_uncertain', completed_at FROM vip_reward_deliveries
           WHERE status = 'UNCERTAIN' AND resolution IS NULL
       )
       SELECT queue, count(*)::int AS count,
              count(*) FILTER (WHERE EXTRACT(EPOCH FROM now() - since) >= $1)::int AS stale,
              EXTRACT(EPOCH FROM now() - min(since))::float8 AS oldest
       FROM q GROUP BY queue`,
      [stale],
    )) as { queue: string; count: number; stale: number; oldest: number }[];
    const QUEUES = [
      'server_control_uncertain',
      'trade_settlement',
      'marketplace_custody',
      'marketplace_settlement',
      'marketplace_release_pending',
      'marketplace_release_failed',
      'vip_delivery_open',
      'vip_delivery_failed',
      'vip_delivery_uncertain',
    ];
    return {
      generatedAt: new Date().toISOString(),
      staleAfterSeconds: stale,
      queues: QUEUES.map((queue) => {
        const row = rows.find((r) => r.queue === queue);
        return {
          queue,
          count: row?.count ?? 0,
          stale: row?.stale ?? 0,
          oldestAgeSeconds: row ? Math.floor(row.oldest) : null,
        };
      }),
    };
  }

  async player(playerId: string) {
    const [row] = (await this.database.query(
      `SELECT p.id, p.display_name, p.status, p.created_at, p.updated_at,
              (SELECT count(*) FROM player_sessions s
                WHERE s.player_id = p.id AND s.revoked_at IS NULL AND s.expires_at > now())::int AS active_sessions
       FROM players p WHERE p.id = $1`,
      [playerId],
    )) as Row[];
    if (!row) throw new NotFoundException('Player not found');
    return {
      playerId: row.id,
      displayName: row.display_name,
      status: row.status,
      activeSessions: row.active_sessions,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }
  async wallet(gameServerId: string, characterExternalId: string) {
    const [row] = (await this.database.query(
      `SELECT balance, updated_at FROM economy_accounts
       WHERE game_server_id = $1 AND currency = 'GOLD' AND owner_type = 'CHARACTER' AND character_external_id = $2`,
      [gameServerId, characterExternalId],
    )) as Row[];
    if (!row) throw new NotFoundException('Character wallet not found');
    return {
      gameServerId,
      characterExternalId,
      currency: 'GOLD',
      balance: Number(row.balance),
      updatedAt: iso(row.updated_at),
    };
  }
  private chat(r: Row) {
    return {
      messageId: r.id,
      gameServerId: r.game_server_id,
      channelType: r.channel_type,
      senderCharacterId: r.sender_character_id,
      groupId: r.group_id,
      guildId: r.guild_id,
      directThreadId: r.direct_thread_id,
      message: r.content,
      createdAt: iso(r.created_at),
      expiresAt: iso(r.expires_at),
      moderatedAt: iso(r.moderated_at),
      moderatedByStaffId: r.moderated_by_staff_id,
      moderationReason: r.moderation_reason,
    };
  }
  private static readonly CHAT = `SELECT id, game_server_id, channel_type, sender_character_id, group_id, guild_id,
              direct_thread_id, content, created_at, expires_at, moderated_at,
              moderated_by_staff_id, moderation_reason
       FROM player_chat_messages`;
  // Channel messages of one server (never DIRECT: a private message is
  // read only by id, from a report), newest first.
  chatMessages(query: ChatQueryDto) {
    return this.page(
      `${OperationsQueryService.CHAT}
       WHERE game_server_id = $1 AND channel_type IN ('GLOBAL', 'GROUP', 'GUILD')
         AND ($2::text IS NULL OR channel_type = $2)
         AND ($3::text IS NULL OR sender_character_id = $3)
         AND ($4::boolean IS NULL OR (moderated_at IS NOT NULL) = $4)
       ORDER BY created_at DESC, id DESC`,
      [
        query.gameServerId,
        query.channel ?? null,
        query.senderCharacterId ?? null,
        query.hidden ?? null,
      ],
      query,
      (r) => this.chat(r),
    );
  }
  async chatMessage(id: string) {
    const [row] = (await this.database.query(
      `${OperationsQueryService.CHAT} WHERE id = $1`,
      [id],
    )) as Row[];
    if (!row) throw new NotFoundException('Chat message not found');
    return this.chat(row);
  }
}
