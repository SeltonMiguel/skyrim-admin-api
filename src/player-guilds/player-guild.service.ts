import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isUUID } from 'class-validator';
import { randomUUID } from 'node:crypto';
import {
  DataSource,
  EntityManager,
  In,
  IsNull,
  MoreThan,
  QueryFailedError,
} from 'typeorm';
import type { ApplicationConfig } from '../config/environment.js';
import { AuditService } from '../audit/audit.service.js';
import {
  AuditAction,
  AuditOutcome,
  AuditResource,
} from '../audit/audit.types.js';
import type { PlayerActor } from '../actors/actor.contracts.js';
import type { GameServer } from '../game-bridge/entities/game-server.entity.js';
import type { PlayerCharacter } from '../player-characters/entities/player-character.entity.js';
import { CharacterLinkStatus } from '../player-characters/player-character.contracts.js';
import { PlayerSettingsService } from '../player-settings/player-settings.service.js';
import { PlayerInteraction } from '../player-settings/player-settings.contracts.js';
import { RealtimeEventBus } from '../realtime-events/realtime-event-bus.js';
import type {
  RealtimeData,
  RealtimeEventType,
} from '../realtime-events/realtime-event-bus.js';
import { PlayerGuild } from './entities/player-guild.entity.js';
import { PlayerGuildMember } from './entities/player-guild-member.entity.js';
import { PlayerGuildInvite } from './entities/player-guild-invite.entity.js';
import {
  GuildInviteCancelReason,
  GuildInviteStatus as I,
  GuildRole,
  GuildStatus,
  MAX_GUILD_MEMBERS,
  guildCan,
  guildNameKey,
} from './player-guild.contracts.js';
import type { GuildPermission } from './player-guild.contracts.js';
import type {
  CharacterGuildDto,
  GuildDisbandDto,
  GuildDto,
  GuildInviteDto,
  GuildLeaveDto,
} from './dto/player-guild.dto.js';

interface PendingEvent {
  type: RealtimeEventType;
  data: RealtimeData;
  playerIds: string[];
}
// Raw RETURNING row of an invite cancelled as a side effect.
interface CancelledInvite {
  id: string;
  guild_id: string;
  game_server_id: string;
  target_character_external_id: string;
}
// Current VERIFIED ownership per character external id of one server.
type Owners = Map<string, PlayerCharacter>;
interface Context {
  guild: PlayerGuild;
  link: PlayerCharacter;
  members: PlayerGuildMember[];
  self: PlayerGuildMember;
  owners: Owners;
}
const guildNotFound = () => new NotFoundException('Guild not found');
const inviteNotFound = () => new NotFoundException('Guild invite not found');
const memberNotFound = () => new NotFoundException('Guild member not found');
const characterNotFound = () => new NotFoundException('Character not found');
const inAGuild = () => new ConflictException('Character already in a guild');
// Final authority is PostgreSQL: races that pass the service checks end on
// one of these partial unique indexes and are reported as the same 409.
const UNIQUE_CONFLICTS: Record<string, string> = {
  player_guilds_name_key: 'Guild name unavailable',
  player_guild_members_active_key: 'Character already in a guild',
  player_guild_members_master_key: 'Guild master conflict',
  player_guild_invites_pending_key: 'Guild invite already pending',
};

// Membership is keyed by character identity (server + external id). A
// VERIFIED ownership link only authorizes the current player to act for the
// character; it is resolved per request and never stored on the guild.
//
// Lock order in every transaction: guild row, then character links (actor,
// then target), then membership/invite rows. Creation has no guild yet and
// starts at the character link.
@Injectable()
export class PlayerGuildService {
  private readonly inviteTtlMs: number;
  constructor(
    private readonly database: DataSource,
    private readonly audit: AuditService,
    private readonly events: RealtimeEventBus,
    private readonly settings: PlayerSettingsService,
    config: ConfigService<{ application: ApplicationConfig }, true>,
  ) {
    this.inviteTtlMs =
      config.get('application', { infer: true }).playerGuilds.inviteTtl * 1000;
  }

  // Runs the mutation, then publishes its events only after commit.
  private async mutate<T>(
    work: (manager: EntityManager, events: PendingEvent[]) => Promise<T>,
  ): Promise<T> {
    const events: PendingEvent[] = [];
    let result: T;
    try {
      result = await this.database.transaction((manager) =>
        work(manager, events),
      );
    } catch (error) {
      const driver =
        error instanceof QueryFailedError
          ? (error.driverError as { code?: string; constraint?: string })
          : undefined;
      const message =
        driver?.code === '23505' && driver.constraint
          ? UNIQUE_CONFLICTS[driver.constraint]
          : undefined;
      if (message) throw new ConflictException(message);
      throw error;
    }
    for (const event of events)
      this.events.publish(event.type, event.data, {
        playerIds: event.playerIds,
      });
    return result;
  }
  private links(manager: EntityManager) {
    return manager.getRepository<PlayerCharacter>('PlayerCharacter');
  }
  private guilds(manager: EntityManager) {
    return manager.getRepository<PlayerGuild>('PlayerGuild');
  }
  private members(manager: EntityManager) {
    return manager.getRepository<PlayerGuildMember>('PlayerGuildMember');
  }
  private invites(manager: EntityManager) {
    return manager.getRepository<PlayerGuildInvite>('PlayerGuildInvite');
  }
  // Own and VERIFIED, else the same 404 as unknown/foreign/PENDING/REVOKED.
  private async ownLink(
    manager: EntityManager,
    actor: PlayerActor,
    id: string,
    lock = false,
  ): Promise<PlayerCharacter> {
    const link = await this.links(manager).findOne({
      where: {
        id,
        playerId: actor.playerId,
        status: CharacterLinkStatus.VERIFIED,
      },
      ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
    if (!link) throw characterNotFound();
    return link;
  }
  private async lockGuild(manager: EntityManager, id: string) {
    if (!isUUID(id)) throw guildNotFound();
    const guild = await this.guilds(manager).findOne({
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!guild) throw guildNotFound();
    return guild;
  }
  private activeMembers(manager: EntityManager, guildId: string) {
    return this.members(manager).find({
      where: { guildId, leftAt: IsNull() },
      order: { joinedAt: 'ASC', id: 'ASC' },
    });
  }
  private async owners(
    manager: EntityManager,
    gameServerId: string,
    characterExternalIds: string[],
  ): Promise<Owners> {
    if (!characterExternalIds.length) return new Map();
    const links = await this.links(manager).findBy({
      gameServerId,
      characterExternalId: In([...new Set(characterExternalIds)]),
      status: CharacterLinkStatus.VERIFIED,
    });
    return new Map(links.map((l) => [l.characterExternalId, l]));
  }
  // Realtime goes only to the current VERIFIED owners: a revoked former owner
  // stops receiving the guild's events although the membership remains.
  private recipients(owners: Owners, members: PlayerGuildMember[]): string[] {
    return members.flatMap((m) => {
      const owner = owners.get(m.characterExternalId);
      return owner ? [owner.playerId] : [];
    });
  }
  private inGuild(
    manager: EntityManager,
    gameServerId: string,
    characterExternalId: string,
  ) {
    return this.members(manager).existsBy({
      gameServerId,
      characterExternalId,
      leftAt: IsNull(),
    });
  }
  // Locks the ACTIVE guild and resolves the actor's member through an own
  // VERIFIED link. Non-members (and a link on another server) get 404.
  private async context(
    manager: EntityManager,
    actor: PlayerActor,
    guildId: string,
    characterLinkId: string,
  ): Promise<Context> {
    const guild = await this.lockGuild(manager, guildId);
    const link = await this.ownLink(manager, actor, characterLinkId);
    if (guild.status !== GuildStatus.ACTIVE) throw guildNotFound();
    const members = await this.activeMembers(manager, guild.id);
    const self = members.find(
      (m) =>
        m.gameServerId === link.gameServerId &&
        m.characterExternalId === link.characterExternalId,
    );
    if (!self) throw guildNotFound();
    const owners = await this.owners(
      manager,
      guild.gameServerId,
      members.map((m) => m.characterExternalId),
    );
    return { guild, link, members, self, owners };
  }
  private require(context: Context, permission: GuildPermission) {
    if (!guildCan(context.self.role, permission))
      throw new ForbiddenException('Guild role does not allow this');
  }
  private target(context: Context, memberId: string) {
    const member = context.members.find((m) => m.id === memberId);
    if (!member) throw memberNotFound();
    return member;
  }
  private async view(
    manager: EntityManager,
    guild: PlayerGuild,
    members: PlayerGuildMember[],
    owners: Owners,
    actor: PlayerActor,
  ): Promise<GuildDto> {
    const server = await manager
      .getRepository<GameServer>('GameServer')
      .findOneByOrFail({ id: guild.gameServerId });
    return {
      id: guild.id,
      gameServer: {
        id: server.id,
        code: server.code,
        name: server.name,
        enabled: server.enabled,
      },
      name: guild.name,
      status: guild.status,
      members: members.map((m) => {
        const owner = owners.get(m.characterExternalId);
        return {
          memberId: m.id,
          characterId: m.characterExternalId,
          characterLinkId:
            owner && owner.playerId === actor.playerId ? owner.id : null,
          role: m.role,
          joinedAt: m.joinedAt,
        };
      }),
      createdAt: guild.createdAt,
    };
  }
  private inviteView(
    invite: PlayerGuildInvite,
    guild: PlayerGuild,
  ): GuildInviteDto {
    return {
      inviteId: invite.id,
      guildId: invite.guildId,
      guildName: guild.name,
      gameServerId: invite.gameServerId,
      targetCharacterId: invite.targetCharacterExternalId,
      invitedByCharacterId: invite.invitedByCharacterExternalId,
      status: invite.status,
      expiresAt: invite.expiresAt,
      createdAt: invite.createdAt,
      respondedAt: invite.respondedAt,
    };
  }
  private record(
    manager: EntityManager,
    actor: PlayerActor,
    action: AuditAction,
    guild: PlayerGuild,
    actorCharacterId: string,
    extra: Record<string, unknown>,
    statusCode: number,
  ) {
    return this.audit.record(
      {
        actor,
        action,
        resourceType: AuditResource.PLAYER_GUILD,
        resourceId: guild.id,
        metadata: {
          guildId: guild.id,
          gameServerId: guild.gameServerId,
          actorCharacterId,
          ...extra,
        },
        outcome: AuditOutcome.SUCCESS,
        statusCode,
      },
      manager,
    );
  }
  // PENDING -> CANCELLED in one statement; RETURNING yields exactly the rows
  // that changed, so invites that were no longer PENDING produce no event.
  private async cancelPending(
    manager: EntityManager,
    now: Date,
    where: string,
    parameters: Record<string, string>,
  ): Promise<CancelledInvite[]> {
    const result = await this.invites(manager)
      .createQueryBuilder('invite')
      .update()
      .set({ status: I.CANCELLED, respondedAt: now })
      .where(`status = :pending AND ${where}`, {
        ...parameters,
        pending: I.PENDING,
      })
      .returning('id, guild_id, game_server_id, target_character_external_id')
      .execute();
    return result.raw as CancelledInvite[];
  }
  // One GUILD_INVITE_CANCELLED per cancelled invite, to the target's current
  // VERIFIED owner and the relevant members of the inviting guild.
  private async announceCancelled(
    manager: EntityManager,
    events: PendingEvent[],
    cancelled: CancelledInvite[],
    reason: GuildInviteCancelReason,
    membersOf: (guildId: string) => PlayerGuildMember[],
  ) {
    for (const invite of cancelled) {
      const members = membersOf(invite.guild_id);
      const owners = await this.owners(manager, invite.game_server_id, [
        invite.target_character_external_id,
        ...members.map((m) => m.characterExternalId),
      ]);
      const target = owners.get(invite.target_character_external_id);
      events.push({
        type: 'GUILD_INVITE_CANCELLED',
        data: {
          guildId: invite.guild_id,
          gameServerId: invite.game_server_id,
          inviteId: invite.id,
          targetCharacterId: invite.target_character_external_id,
          reason,
        },
        playerIds: [
          ...(target ? [target.playerId] : []),
          ...this.recipients(owners, members),
        ],
      });
    }
  }
  private data(guild: PlayerGuild, extra: RealtimeData = {}): RealtimeData {
    return { guildId: guild.id, gameServerId: guild.gameServerId, ...extra };
  }

  async create(
    actor: PlayerActor,
    input: { characterLinkId: string; name: string },
  ): Promise<GuildDto> {
    return this.mutate(async (manager, events) => {
      // The link lock serializes concurrent creations for the same character.
      const link = await this.ownLink(
        manager,
        actor,
        input.characterLinkId,
        true,
      );
      const server = await manager
        .getRepository<GameServer>('GameServer')
        .findOneByOrFail({ id: link.gameServerId });
      if (!server.enabled) throw new ConflictException('Game server disabled');
      if (
        await this.inGuild(manager, link.gameServerId, link.characterExternalId)
      )
        throw inAGuild();
      const nameKey = guildNameKey(input.name);
      if (
        await this.guilds(manager).existsBy({
          gameServerId: link.gameServerId,
          nameKey,
          status: GuildStatus.ACTIVE,
        })
      )
        throw new ConflictException('Guild name unavailable');
      const guild = await this.guilds(manager).save(
        this.guilds(manager).create({
          id: randomUUID(),
          gameServerId: link.gameServerId,
          name: input.name,
          nameKey,
          status: GuildStatus.ACTIVE,
          disbandedAt: null,
        }),
      );
      const master = await this.members(manager).save(
        this.members(manager).create({
          id: randomUUID(),
          guildId: guild.id,
          gameServerId: guild.gameServerId,
          characterExternalId: link.characterExternalId,
          role: GuildRole.MASTER,
          joinedAt: new Date(),
          leftAt: null,
        }),
      );
      await this.record(
        manager,
        actor,
        AuditAction.PLAYER_GUILD_CREATED,
        guild,
        link.characterExternalId,
        { memberId: master.id, name: guild.name, role: GuildRole.MASTER },
        201,
      );
      events.push({
        type: 'GUILD_CREATED',
        data: this.data(guild, { name: guild.name, memberId: master.id }),
        playerIds: [actor.playerId],
      });
      return this.view(
        manager,
        guild,
        [master],
        new Map([[link.characterExternalId, link]]),
        actor,
      );
    });
  }
  // Members only, through an own VERIFIED link of a member character.
  async get(
    actor: PlayerActor,
    guildId: string,
    characterLinkId: string,
  ): Promise<GuildDto> {
    if (!isUUID(guildId)) throw guildNotFound();
    const manager = this.database.manager;
    const link = await this.ownLink(manager, actor, characterLinkId);
    const guild = await this.guilds(manager).findOneBy({
      id: guildId,
      status: GuildStatus.ACTIVE,
    });
    if (!guild || guild.gameServerId !== link.gameServerId)
      throw guildNotFound();
    const members = await this.activeMembers(manager, guild.id);
    if (
      !members.some((m) => m.characterExternalId === link.characterExternalId)
    )
      throw guildNotFound();
    const owners = await this.owners(
      manager,
      guild.gameServerId,
      members.map((m) => m.characterExternalId),
    );
    return this.view(manager, guild, members, owners, actor);
  }
  // The active guild of an own character, or { guild: null }.
  async forCharacter(
    actor: PlayerActor,
    characterLinkId: string,
  ): Promise<CharacterGuildDto> {
    const manager = this.database.manager;
    const link = await this.ownLink(manager, actor, characterLinkId);
    const membership = await this.members(manager).findOneBy({
      gameServerId: link.gameServerId,
      characterExternalId: link.characterExternalId,
      leftAt: IsNull(),
    });
    if (!membership) return { guild: null };
    const guild = await this.guilds(manager).findOneByOrFail({
      id: membership.guildId,
    });
    const members = await this.activeMembers(manager, guild.id);
    const owners = await this.owners(
      manager,
      guild.gameServerId,
      members.map((m) => m.characterExternalId),
    );
    return { guild: await this.view(manager, guild, members, owners, actor) };
  }
  // MASTER or OFFICER. Repeating a pending invite returns it unchanged (no
  // Audit, no event).
  async invite(
    actor: PlayerActor,
    guildId: string,
    input: { actorCharacterLinkId: string; targetCharacterId: string },
  ): Promise<{ invite: GuildInviteDto; created: boolean }> {
    return this.mutate(async (manager, events) => {
      const context = await this.context(
        manager,
        actor,
        guildId,
        input.actorCharacterLinkId,
      );
      this.require(context, 'invite');
      const { guild, members, self } = context;
      // Resolved on the guild's server from the public game id; unknown,
      // PENDING, REVOKED and other-server characters are indistinguishable.
      const target = await this.links(manager).findOne({
        where: {
          gameServerId: guild.gameServerId,
          characterExternalId: input.targetCharacterId,
          status: CharacterLinkStatus.VERIFIED,
        },
        lock: { mode: 'pessimistic_write' },
      });
      // A target whose owner refuses new invites from other players looks
      // exactly like an unavailable one.
      if (
        !target ||
        (target.playerId !== actor.playerId &&
          !(await this.settings.allows(
            manager,
            target.playerId,
            PlayerInteraction.GUILD_INVITE,
          )))
      )
        throw new NotFoundException('Character not available');
      if (
        members.some(
          (m) => m.characterExternalId === target.characterExternalId,
        )
      )
        throw new ConflictException('Character already in this guild');
      if (
        await this.inGuild(
          manager,
          guild.gameServerId,
          target.characterExternalId,
        )
      )
        throw new ConflictException('Character unavailable');
      const now = new Date();
      const pending = await this.invites(manager).findOneBy({
        guildId: guild.id,
        targetCharacterExternalId: target.characterExternalId,
        status: I.PENDING,
      });
      if (pending && pending.expiresAt > now)
        return { invite: this.inviteView(pending, guild), created: false };
      if (members.length >= MAX_GUILD_MEMBERS)
        throw new ConflictException('Guild full');
      if (pending)
        await this.invites(manager).update(pending.id, {
          status: I.EXPIRED,
          respondedAt: now,
        });
      const invite = await this.invites(manager).save(
        this.invites(manager).create({
          id: randomUUID(),
          guildId: guild.id,
          gameServerId: guild.gameServerId,
          targetCharacterExternalId: target.characterExternalId,
          invitedByCharacterExternalId: self.characterExternalId,
          status: I.PENDING,
          expiresAt: new Date(now.getTime() + this.inviteTtlMs),
          respondedAt: null,
          createdAt: now,
        }),
      );
      await this.record(
        manager,
        actor,
        AuditAction.PLAYER_GUILD_INVITED,
        guild,
        self.characterExternalId,
        {
          inviteId: invite.id,
          targetCharacterId: target.characterExternalId,
          role: self.role,
        },
        201,
      );
      events.push({
        type: 'GUILD_INVITE_CREATED',
        data: this.data(guild, {
          guildName: guild.name,
          inviteId: invite.id,
          targetCharacterId: target.characterExternalId,
          invitedByCharacterId: self.characterExternalId,
          expiresAt: invite.expiresAt.toISOString(),
        }),
        playerIds: [
          ...this.recipients(context.owners, members),
          target.playerId,
        ],
      });
      return { invite: this.inviteView(invite, guild), created: true };
    });
  }
  // Pending, unexpired invites addressed to one own VERIFIED character.
  async listInvites(
    actor: PlayerActor,
    characterLinkId: string,
  ): Promise<{ items: GuildInviteDto[] }> {
    const manager = this.database.manager;
    const link = await this.ownLink(manager, actor, characterLinkId);
    const invites = await this.invites(manager)
      .createQueryBuilder('invite')
      .innerJoinAndSelect('invite.guild', 'guild')
      .where('invite.gameServerId = :server', { server: link.gameServerId })
      .andWhere('invite.targetCharacterExternalId = :character', {
        character: link.characterExternalId,
      })
      .andWhere('invite.status = :pending', { pending: I.PENDING })
      .andWhere({ expiresAt: MoreThan(new Date()) })
      .andWhere('guild.status = :active', { active: GuildStatus.ACTIVE })
      .orderBy('invite.createdAt', 'ASC')
      .addOrderBy('invite.id', 'ASC')
      .take(100)
      .getMany();
    return { items: invites.map((i) => this.inviteView(i, i.guild)) };
  }
  // Locks guild, own target link, then the invite. The invite is answered
  // only through the VERIFIED link of its target character; anything else is
  // the same 404 as an unknown invite.
  private async answerable(
    manager: EntityManager,
    actor: PlayerActor,
    inviteId: string,
    characterLinkId: string,
  ) {
    if (!isUUID(inviteId)) throw inviteNotFound();
    const located = await this.invites(manager).findOneBy({ id: inviteId });
    if (!located) throw inviteNotFound();
    const guild = await this.lockGuild(manager, located.guildId);
    const link = await this.ownLink(manager, actor, characterLinkId, true);
    if (
      link.gameServerId !== located.gameServerId ||
      link.characterExternalId !== located.targetCharacterExternalId
    )
      throw inviteNotFound();
    const invite = await this.invites(manager).findOneOrFail({
      where: { id: inviteId },
      lock: { mode: 'pessimistic_write' },
    });
    if (invite.status !== I.PENDING)
      throw new ConflictException('Guild invite no longer pending');
    return { guild, invite, link, expired: invite.expiresAt <= new Date() };
  }
  // Marks an expired invite EXPIRED (committed); the caller then reports 409.
  private async expire(manager: EntityManager, invite: PlayerGuildInvite) {
    await this.invites(manager).update(invite.id, {
      status: I.EXPIRED,
      respondedAt: new Date(),
    });
  }
  async accept(
    actor: PlayerActor,
    inviteId: string,
    characterLinkId: string,
  ): Promise<GuildDto> {
    const outcome = await this.mutate(async (manager, events) => {
      const { guild, invite, link, expired } = await this.answerable(
        manager,
        actor,
        inviteId,
        characterLinkId,
      );
      if (expired) {
        await this.expire(manager, invite);
        return null;
      }
      if (guild.status !== GuildStatus.ACTIVE)
        throw new ConflictException('Guild not active');
      if (
        await this.inGuild(manager, link.gameServerId, link.characterExternalId)
      )
        throw inAGuild();
      const members = await this.activeMembers(manager, guild.id);
      // Capacity is checked under the guild lock: no lost updates.
      if (members.length >= MAX_GUILD_MEMBERS)
        throw new ConflictException('Guild full');
      const now = new Date();
      const member = await this.members(manager).save(
        this.members(manager).create({
          id: randomUUID(),
          guildId: guild.id,
          gameServerId: guild.gameServerId,
          characterExternalId: link.characterExternalId,
          role: GuildRole.MEMBER,
          joinedAt: now,
          leftAt: null,
        }),
      );
      await this.invites(manager).update(invite.id, {
        status: I.ACCEPTED,
        respondedAt: now,
      });
      // The character joined a guild: its other pending invites are void.
      const cancelled = await this.cancelPending(
        manager,
        now,
        'game_server_id = :server AND target_character_external_id = :character AND id <> :accepted',
        {
          server: link.gameServerId,
          character: link.characterExternalId,
          accepted: invite.id,
        },
      );
      await this.record(
        manager,
        actor,
        AuditAction.PLAYER_GUILD_INVITE_ACCEPTED,
        guild,
        link.characterExternalId,
        {
          inviteId: invite.id,
          memberId: member.id,
          role: GuildRole.MEMBER,
          cancelledInvites: cancelled.length,
        },
        200,
      );
      const current = [...members, member];
      const owners = await this.owners(
        manager,
        guild.gameServerId,
        current.map((m) => m.characterExternalId),
      );
      const playerIds = this.recipients(owners, current);
      events.push(
        {
          type: 'GUILD_INVITE_ACCEPTED',
          data: this.data(guild, { inviteId: invite.id }),
          playerIds,
        },
        {
          type: 'GUILD_MEMBER_JOINED',
          data: this.data(guild, {
            memberId: member.id,
            characterId: member.characterExternalId,
            role: member.role,
          }),
          playerIds,
        },
      );
      // Each cancelled invite goes to its target and to the members of the
      // guild that issued it (read after this guild's changes, same commit).
      const others = new Map<string, PlayerGuildMember[]>();
      for (const guildId of new Set(cancelled.map((c) => c.guild_id)))
        others.set(guildId, await this.activeMembers(manager, guildId));
      await this.announceCancelled(
        manager,
        events,
        cancelled,
        GuildInviteCancelReason.TARGET_JOINED_ANOTHER_GUILD,
        (guildId) => others.get(guildId) ?? [],
      );
      return this.view(manager, guild, current, owners, actor);
    });
    if (!outcome) throw new ConflictException('Guild invite expired');
    return outcome;
  }
  async decline(
    actor: PlayerActor,
    inviteId: string,
    characterLinkId: string,
  ): Promise<GuildInviteDto> {
    const outcome = await this.mutate(async (manager, events) => {
      const { guild, invite, link, expired } = await this.answerable(
        manager,
        actor,
        inviteId,
        characterLinkId,
      );
      if (expired) {
        await this.expire(manager, invite);
        return null;
      }
      const now = new Date();
      invite.status = I.DECLINED;
      invite.respondedAt = now;
      await this.invites(manager).update(invite.id, {
        status: I.DECLINED,
        respondedAt: now,
      });
      await this.record(
        manager,
        actor,
        AuditAction.PLAYER_GUILD_INVITE_DECLINED,
        guild,
        link.characterExternalId,
        { inviteId: invite.id },
        200,
      );
      const members = await this.activeMembers(manager, guild.id);
      const owners = await this.owners(
        manager,
        guild.gameServerId,
        members.map((m) => m.characterExternalId),
      );
      events.push({
        type: 'GUILD_INVITE_DECLINED',
        data: this.data(guild, {
          inviteId: invite.id,
          targetCharacterId: link.characterExternalId,
        }),
        playerIds: [...this.recipients(owners, members), actor.playerId],
      });
      return this.inviteView(invite, guild);
    });
    if (!outcome) throw new ConflictException('Guild invite expired');
    return outcome;
  }
  // MEMBER/OFFICER only: the MASTER must transfer mastership or disband.
  async leave(
    actor: PlayerActor,
    guildId: string,
    characterLinkId: string,
  ): Promise<GuildLeaveDto> {
    return this.mutate(async (manager, events) => {
      const context = await this.context(
        manager,
        actor,
        guildId,
        characterLinkId,
      );
      const { guild, self } = context;
      if (self.role === GuildRole.MASTER)
        throw new ConflictException(
          'Guild master must transfer mastership or disband the guild',
        );
      const leftAt = new Date();
      await this.members(manager).update(self.id, { leftAt });
      await this.record(
        manager,
        actor,
        AuditAction.PLAYER_GUILD_MEMBER_LEFT,
        guild,
        self.characterExternalId,
        { memberId: self.id, role: self.role },
        200,
      );
      events.push({
        type: 'GUILD_MEMBER_LEFT',
        data: this.data(guild, {
          memberId: self.id,
          characterId: self.characterExternalId,
        }),
        playerIds: this.recipients(context.owners, context.members),
      });
      return { guildId: guild.id, memberId: self.id, leftAt };
    });
  }
  async kick(
    actor: PlayerActor,
    guildId: string,
    memberId: string,
    actorCharacterLinkId: string,
  ): Promise<GuildDto> {
    return this.mutate(async (manager, events) => {
      const context = await this.context(
        manager,
        actor,
        guildId,
        actorCharacterLinkId,
      );
      this.require(context, 'kick');
      const { guild, self } = context;
      const member = this.target(context, memberId);
      if (member.id === self.id)
        throw new BadRequestException('The guild master cannot kick itself');
      await this.members(manager).update(member.id, { leftAt: new Date() });
      await this.record(
        manager,
        actor,
        AuditAction.PLAYER_GUILD_MEMBER_KICKED,
        guild,
        self.characterExternalId,
        {
          memberId: member.id,
          targetCharacterId: member.characterExternalId,
          role: member.role,
        },
        200,
      );
      events.push({
        type: 'GUILD_MEMBER_KICKED',
        data: this.data(guild, {
          memberId: member.id,
          characterId: member.characterExternalId,
        }),
        playerIds: this.recipients(context.owners, context.members),
      });
      return this.view(
        manager,
        guild,
        context.members.filter((m) => m.id !== member.id),
        context.owners,
        actor,
      );
    });
  }
  // MASTER promotes MEMBER -> OFFICER or demotes OFFICER -> MEMBER. The
  // same role again is a no-op (no Audit, no event).
  async changeRole(
    actor: PlayerActor,
    guildId: string,
    memberId: string,
    input: {
      actorCharacterLinkId: string;
      role: GuildRole.OFFICER | GuildRole.MEMBER;
    },
  ): Promise<GuildDto> {
    return this.mutate(async (manager, events) => {
      const context = await this.context(
        manager,
        actor,
        guildId,
        input.actorCharacterLinkId,
      );
      this.require(context, 'changeRole');
      const { guild, self } = context;
      const member = this.target(context, memberId);
      if (member.role === GuildRole.MASTER)
        throw new BadRequestException(
          'Use transfer-master to change the guild master',
        );
      if (member.role !== input.role) {
        const previousRole = member.role;
        await this.members(manager).update(member.id, { role: input.role });
        member.role = input.role;
        await this.record(
          manager,
          actor,
          AuditAction.PLAYER_GUILD_MEMBER_ROLE_CHANGED,
          guild,
          self.characterExternalId,
          {
            memberId: member.id,
            targetCharacterId: member.characterExternalId,
            previousRole,
            role: input.role,
          },
          200,
        );
        events.push({
          type: 'GUILD_MEMBER_ROLE_CHANGED',
          data: this.data(guild, {
            memberId: member.id,
            characterId: member.characterExternalId,
            previousRole,
            role: input.role,
          }),
          playerIds: this.recipients(context.owners, context.members),
        });
      }
      return this.view(manager, guild, context.members, context.owners, actor);
    });
  }
  // Atomic: the current MASTER becomes OFFICER, then the target becomes
  // MASTER (in that order, so the partial unique index never sees two).
  async transferMaster(
    actor: PlayerActor,
    guildId: string,
    memberId: string,
    actorCharacterLinkId: string,
  ): Promise<GuildDto> {
    return this.mutate(async (manager, events) => {
      const context = await this.context(
        manager,
        actor,
        guildId,
        actorCharacterLinkId,
      );
      this.require(context, 'transferMaster');
      const { guild, self } = context;
      const member = this.target(context, memberId);
      if (member.id === self.id)
        throw new BadRequestException(
          'The guild master cannot transfer to itself',
        );
      const previousRole = member.role;
      await this.members(manager).update(self.id, { role: GuildRole.OFFICER });
      await this.members(manager).update(member.id, { role: GuildRole.MASTER });
      self.role = GuildRole.OFFICER;
      member.role = GuildRole.MASTER;
      await this.record(
        manager,
        actor,
        AuditAction.PLAYER_GUILD_MASTER_TRANSFERRED,
        guild,
        self.characterExternalId,
        {
          memberId: member.id,
          targetCharacterId: member.characterExternalId,
          previousRole,
          previousMasterMemberId: self.id,
          role: GuildRole.MASTER,
        },
        200,
      );
      events.push({
        type: 'GUILD_MASTER_TRANSFERRED',
        data: this.data(guild, {
          memberId: member.id,
          characterId: member.characterExternalId,
          previousMasterMemberId: self.id,
          previousMasterCharacterId: self.characterExternalId,
        }),
        playerIds: this.recipients(context.owners, context.members),
      });
      return this.view(manager, guild, context.members, context.owners, actor);
    });
  }
  // MASTER only. Memberships end (kept as history), pending invites are
  // cancelled and the name becomes available again.
  async disband(
    actor: PlayerActor,
    guildId: string,
    actorCharacterLinkId: string,
  ): Promise<GuildDisbandDto> {
    return this.mutate(async (manager, events) => {
      const context = await this.context(
        manager,
        actor,
        guildId,
        actorCharacterLinkId,
      );
      this.require(context, 'disband');
      const { guild, self, members } = context;
      const now = new Date();
      await this.guilds(manager).update(guild.id, {
        status: GuildStatus.DISBANDED,
        disbandedAt: now,
      });
      await this.members(manager).update(
        { guildId: guild.id, leftAt: IsNull() },
        { leftAt: now },
      );
      const pending = await this.cancelPending(
        manager,
        now,
        'guild_id = :guild',
        { guild: guild.id },
      );
      await this.record(
        manager,
        actor,
        AuditAction.PLAYER_GUILD_DISBANDED,
        guild,
        self.characterExternalId,
        { memberCount: members.length, cancelledInvites: pending.length },
        200,
      );
      const invited = await this.owners(
        manager,
        guild.gameServerId,
        pending.map((i) => i.target_character_external_id),
      );
      events.push({
        type: 'GUILD_DISBANDED',
        data: this.data(guild, { name: guild.name }),
        playerIds: [
          ...this.recipients(context.owners, members),
          ...[...invited.values()].map((l) => l.playerId),
        ],
      });
      await this.announceCancelled(
        manager,
        events,
        pending,
        GuildInviteCancelReason.GUILD_DISBANDED,
        () => members,
      );
      return { status: GuildStatus.DISBANDED };
    });
  }
}
