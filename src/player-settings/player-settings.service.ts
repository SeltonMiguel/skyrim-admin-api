import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import {
  AuditAction,
  AuditOutcome,
  AuditResource,
} from '../audit/audit.types.js';
import type { PlayerActor } from '../actors/actor.contracts.js';
import { RealtimeEventBus } from '../realtime-events/realtime-event-bus.js';
import type { PlayerSettings } from './entities/player-settings.entity.js';
import {
  INTERACTION_SETTING,
  PLAYER_SETTING_FIELDS,
  PLAYER_SETTINGS_DEFAULTS,
} from './player-settings.contracts.js';
import type {
  PlayerInteraction,
  PlayerSettingField,
  PlayerSettingsValues,
} from './player-settings.contracts.js';
import type { PlayerSettingsDto } from './dto/player-settings.dto.js';

const values = (row: PlayerSettings | null): PlayerSettingsValues =>
  row
    ? {
        locale: row.locale,
        timeZone: row.timeZone,
        allowDirectMessages: row.allowDirectMessages,
        allowTradeRequests: row.allowTradeRequests,
        allowGroupInvites: row.allowGroupInvites,
        allowGuildInvites: row.allowGuildInvites,
      }
    : { ...PLAYER_SETTINGS_DEFAULTS };

// Account-scoped preferences. Depends on no Player domain; Chat, Trade,
// Groups and Guilds depend on it (allows) to honour the privacy flags.
// No GameServer is ever consulted.
@Injectable()
export class PlayerSettingsService {
  constructor(
    private readonly database: DataSource,
    private readonly audit: AuditService,
    private readonly events: RealtimeEventBus,
  ) {}
  private repo(manager: EntityManager) {
    return manager.getRepository<PlayerSettings>('PlayerSettings');
  }
  private view(row: PlayerSettings | null): PlayerSettingsDto {
    return { ...values(row), updatedAt: row?.updatedAt ?? null };
  }
  // Reading never materializes a row: no row means the defaults.
  async get(actor: PlayerActor): Promise<PlayerSettingsDto> {
    return this.view(
      await this.repo(this.database.manager).findOneBy({
        playerId: actor.playerId,
      }),
    );
  }
  // Whether another player may start this interaction with `playerId`, read
  // inside the caller's transaction. No row = defaults (allowed).
  async allows(
    manager: EntityManager,
    playerId: string,
    interaction: PlayerInteraction,
  ): Promise<boolean> {
    const field = INTERACTION_SETTING[interaction];
    const row = await this.repo(manager).findOneBy({ playerId });
    return values(row)[field];
  }
  // Applies only the fields sent. The row is locked when it exists; the
  // first effective change creates it (ON CONFLICT: a concurrent first
  // change wins the insert and ours is applied on top under its lock), so
  // concurrent partial PATCHes never lose each other's fields. A request
  // that changes nothing writes, audits and publishes nothing.
  async update(
    actor: PlayerActor,
    patch: Partial<PlayerSettingsValues>,
  ): Promise<PlayerSettingsDto> {
    const sent = PLAYER_SETTING_FIELDS.filter((f) => patch[f] !== undefined);
    if (!sent.length)
      throw new BadRequestException('At least one setting is required');
    const { dto, changed } = await this.database.transaction(
      async (manager) => {
        const lock = () =>
          this.repo(manager).findOne({
            where: { playerId: actor.playerId },
            lock: { mode: 'pessimistic_write' },
          });
        let row = await lock();
        let changed = this.diff(values(row), patch, sent);
        if (!changed.length) return { dto: this.view(row), changed };
        let inserted = false;
        if (!row) {
          const next = { ...values(null), ...this.pick(patch, changed) };
          const rows: unknown[] = await manager.query(
            `INSERT INTO player_settings(player_id, locale, time_zone, allow_direct_messages, allow_trade_requests, allow_group_invites, allow_guild_invites)
             VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (player_id) DO NOTHING RETURNING player_id`,
            [
              actor.playerId,
              next.locale,
              next.timeZone,
              next.allowDirectMessages,
              next.allowTradeRequests,
              next.allowGroupInvites,
              next.allowGuildInvites,
            ],
          );
          inserted = rows.length > 0;
          if (!inserted) {
            row = await lock();
            changed = this.diff(values(row), patch, sent);
            if (!changed.length) return { dto: this.view(row), changed };
          }
        }
        if (!inserted)
          await this.repo(manager).update(
            { playerId: actor.playerId },
            this.pick(patch, changed),
          );
        await this.audit.record(
          {
            actor,
            action: AuditAction.PLAYER_SETTINGS_UPDATED,
            resourceType: AuditResource.PLAYER_SETTINGS,
            resourceId: actor.playerId,
            metadata: { changedFields: changed },
            outcome: AuditOutcome.SUCCESS,
            statusCode: 200,
          },
          manager,
        );
        const saved = await this.repo(manager).findOneByOrFail({
          playerId: actor.playerId,
        });
        return { dto: this.view(saved), changed };
      },
    );
    // Only the player's own connections, after commit.
    if (changed.length)
      this.events.publish(
        'PLAYER_SETTINGS_UPDATED',
        { ...dto, updatedAt: dto.updatedAt?.toISOString() ?? null },
        { playerIds: [actor.playerId] },
      );
    return dto;
  }
  private diff(
    current: PlayerSettingsValues,
    patch: Partial<PlayerSettingsValues>,
    sent: PlayerSettingField[],
  ): PlayerSettingField[] {
    return sent.filter((f) => patch[f] !== current[f]);
  }
  private pick(
    patch: Partial<PlayerSettingsValues>,
    fields: PlayerSettingField[],
  ): Partial<PlayerSettingsValues> {
    return Object.fromEntries(fields.map((f) => [f, patch[f]]));
  }
}
