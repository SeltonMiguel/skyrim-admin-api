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
import { DataSource, EntityManager, In, IsNull, MoreThan } from 'typeorm';
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
import { PlayerGroup } from './entities/player-group.entity.js';
import { PlayerGroupMember } from './entities/player-group-member.entity.js';
import { PlayerGroupInvite } from './entities/player-group-invite.entity.js';
import {
  GroupInviteStatus as I,
  GroupRole,
  GroupStatus,
  MAX_GROUP_MEMBERS,
} from './player-group.contracts.js';
import type { GroupDto, GroupInviteDto } from './dto/player-group.dto.js';

type Member = PlayerGroupMember & { playerCharacter: PlayerCharacter };
interface PendingEvent {
  type: RealtimeEventType;
  data: RealtimeData;
  playerIds: string[];
}
const groupNotFound = () => new NotFoundException('Group not found');
const inviteNotFound = () => new NotFoundException('Group invite not found');
const characterNotFound = () => new NotFoundException('Character not found');
const unavailable = () => new ConflictException('Character unavailable');

// Lock order in every transaction: group row, then character links, then
// memberships/invites. Partial unique indexes are the final authority.
@Injectable()
export class PlayerGroupService {
  private readonly inviteTtlMs: number;
  constructor(
    private readonly database: DataSource,
    private readonly audit: AuditService,
    private readonly events: RealtimeEventBus,
    private readonly settings: PlayerSettingsService,
    config: ConfigService<{ application: ApplicationConfig }, true>,
  ) {
    this.inviteTtlMs =
      config.get('application', { infer: true }).playerGroups.inviteTtl * 1000;
  }

  // Runs the mutation, then publishes its events only after commit.
  private async mutate<T>(
    work: (manager: EntityManager, events: PendingEvent[]) => Promise<T>,
  ): Promise<T> {
    const events: PendingEvent[] = [];
    const result = await this.database.transaction((manager) =>
      work(manager, events),
    );
    for (const event of events)
      this.events.publish(event.type, event.data, {
        playerIds: event.playerIds,
      });
    return result;
  }
  private links(manager: EntityManager) {
    return manager.getRepository<PlayerCharacter>('PlayerCharacter');
  }
  private members(manager: EntityManager) {
    return manager.getRepository<PlayerGroupMember>('PlayerGroupMember');
  }
  private invites(manager: EntityManager) {
    return manager.getRepository<PlayerGroupInvite>('PlayerGroupInvite');
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
  private async lockGroup(manager: EntityManager, id: string) {
    if (!isUUID(id)) throw groupNotFound();
    const group = await manager
      .getRepository<PlayerGroup>('PlayerGroup')
      .findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
    if (!group) throw groupNotFound();
    return group;
  }
  private activeMembers(manager: EntityManager, groupId: string) {
    return manager
      .getRepository<Member>('PlayerGroupMember')
      .createQueryBuilder('member')
      .innerJoinAndSelect('member.playerCharacter', 'link')
      .where('member.groupId = :groupId', { groupId })
      .andWhere('member.leftAt IS NULL')
      .orderBy('member.joinedAt', 'ASC')
      .addOrderBy('member.id', 'ASC')
      .getMany();
  }
  // Only current VERIFIED owners are recipients; a revoked link's former
  // owner no longer receives the group's events.
  private owners(members: Member[]): string[] {
    return members
      .filter((m) => m.playerCharacter.status === CharacterLinkStatus.VERIFIED)
      .map((m) => m.playerCharacter.playerId);
  }
  private ownedBy(member: Member, actor: PlayerActor) {
    return (
      member.playerCharacter.playerId === actor.playerId &&
      member.playerCharacter.status === CharacterLinkStatus.VERIFIED
    );
  }
  // Non-members get 404; members that are not the leader get 403.
  private requireLeader(members: Member[], actor: PlayerActor): Member {
    const leader = members.find((m) => m.role === GroupRole.LEADER);
    if (leader && this.ownedBy(leader, actor)) return leader;
    if (members.some((m) => this.ownedBy(m, actor)))
      throw new ForbiddenException('Only the group leader can do this');
    throw groupNotFound();
  }
  private view(
    group: PlayerGroup,
    members: Member[],
    actor: PlayerActor,
  ): GroupDto {
    return {
      id: group.id,
      gameServerId: group.gameServerId,
      status: group.status,
      maxMembers: MAX_GROUP_MEMBERS,
      members: members.map((m) => ({
        memberId: m.id,
        characterId: m.playerCharacter.characterExternalId,
        role: m.role,
        joinedAt: m.joinedAt,
        characterLinkId: this.ownedBy(m, actor) ? m.playerCharacterId : null,
      })),
      createdAt: group.createdAt,
    };
  }
  private async inviteView(
    manager: EntityManager,
    invite: PlayerGroupInvite,
    gameServerId: string,
  ): Promise<GroupInviteDto> {
    const [target, inviter] = await Promise.all([
      this.links(manager).findOneByOrFail({
        id: invite.targetPlayerCharacterId,
      }),
      this.links(manager).findOneByOrFail({
        id: invite.invitedByPlayerCharacterId,
      }),
    ]);
    return {
      inviteId: invite.id,
      groupId: invite.groupId,
      gameServerId,
      targetCharacterId: target.characterExternalId,
      invitedByCharacterId: inviter.characterExternalId,
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
    group: PlayerGroup,
    extra: Record<string, unknown>,
    statusCode: number,
  ) {
    return this.audit.record(
      {
        actor,
        action,
        resourceType: AuditResource.PLAYER_GROUP,
        resourceId: group.id,
        metadata: {
          groupId: group.id,
          gameServerId: group.gameServerId,
          ...extra,
        },
        outcome: AuditOutcome.SUCCESS,
        statusCode,
      },
      manager,
    );
  }
  private async inAnyGroup(manager: EntityManager, playerCharacterId: string) {
    return this.members(manager).existsBy({
      playerCharacterId,
      leftAt: IsNull(),
    });
  }

  async create(actor: PlayerActor, characterLinkId: string): Promise<GroupDto> {
    return this.mutate(async (manager, events) => {
      // Link lock serializes concurrent creations for the same character.
      const link = await this.ownLink(manager, actor, characterLinkId, true);
      const server = await manager
        .getRepository<GameServer>('GameServer')
        .findOneByOrFail({ id: link.gameServerId });
      if (!server.enabled) throw new ConflictException('Game server disabled');
      if (await this.inAnyGroup(manager, link.id))
        throw new ConflictException('Character already in a group');
      const groups = manager.getRepository<PlayerGroup>('PlayerGroup');
      const group = await groups.save(
        groups.create({
          id: randomUUID(),
          gameServerId: link.gameServerId,
          status: GroupStatus.ACTIVE,
          disbandedAt: null,
        }),
      );
      const member = await this.members(manager).save(
        this.members(manager).create({
          id: randomUUID(),
          groupId: group.id,
          playerCharacterId: link.id,
          role: GroupRole.LEADER,
          joinedAt: new Date(),
          leftAt: null,
        }),
      );
      await this.record(
        manager,
        actor,
        AuditAction.PLAYER_GROUP_CREATED,
        group,
        {
          characterLinkId: link.id,
          memberId: member.id,
        },
        201,
      );
      events.push({
        type: 'GROUP_CREATED',
        data: {
          groupId: group.id,
          gameServerId: group.gameServerId,
          memberId: member.id,
        },
        playerIds: [actor.playerId],
      });
      return this.view(
        group,
        await this.activeMembers(manager, group.id),
        actor,
      );
    });
  }
  // Members only; after leaving or disband the group is no longer visible.
  async get(actor: PlayerActor, groupId: string): Promise<GroupDto> {
    if (!isUUID(groupId)) throw groupNotFound();
    const manager = this.database.manager;
    const group = await manager
      .getRepository<PlayerGroup>('PlayerGroup')
      .findOneBy({ id: groupId, status: GroupStatus.ACTIVE });
    if (!group) throw groupNotFound();
    const members = await this.activeMembers(manager, group.id);
    if (!members.some((m) => this.ownedBy(m, actor))) throw groupNotFound();
    return this.view(group, members, actor);
  }
  // The active group of an own VERIFIED character, else { group: null };
  // unknown, foreign, PENDING and REVOKED links are the same 404.
  async forCharacter(
    actor: PlayerActor,
    characterLinkId: string,
  ): Promise<{ group: GroupDto | null }> {
    const manager = this.database.manager;
    const link = await this.ownLink(manager, actor, characterLinkId);
    const membership = await this.members(manager).findOneBy({
      playerCharacterId: link.id,
      leftAt: IsNull(),
    });
    if (!membership) return { group: null };
    const group = await manager
      .getRepository<PlayerGroup>('PlayerGroup')
      .findOneBy({ id: membership.groupId, status: GroupStatus.ACTIVE });
    if (!group) return { group: null };
    return {
      group: this.view(
        group,
        await this.activeMembers(manager, group.id),
        actor,
      ),
    };
  }
  // Repeating a pending invite returns it unchanged (no Audit, no event).
  async invite(
    actor: PlayerActor,
    groupId: string,
    input: { actorCharacterLinkId: string; targetCharacterId: string },
  ): Promise<{ invite: GroupInviteDto; created: boolean }> {
    return this.mutate(async (manager, events) => {
      const group = await this.lockGroup(manager, groupId);
      const actorLink = await this.ownLink(
        manager,
        actor,
        input.actorCharacterLinkId,
      );
      const members = await this.activeMembers(manager, group.id);
      const leader = this.requireLeader(members, actor);
      if (leader.playerCharacterId !== actorLink.id)
        throw new ForbiddenException('Only the group leader can do this');
      // The target is resolved on the group's server from its public game id;
      // the VERIFIED link id is used only internally. Unknown, PENDING,
      // REVOKED and other-server characters are indistinguishable.
      const target = await this.links(manager).findOne({
        where: {
          gameServerId: group.gameServerId,
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
            PlayerInteraction.GROUP_INVITE,
          )))
      )
        throw new NotFoundException('Character not available');
      if (await this.inAnyGroup(manager, target.id)) throw unavailable();
      if (members.length >= MAX_GROUP_MEMBERS)
        throw new ConflictException('Group full');
      const now = new Date();
      const pending = await this.invites(manager).findOneBy({
        groupId: group.id,
        targetPlayerCharacterId: target.id,
        status: I.PENDING,
      });
      if (pending && pending.expiresAt > now)
        return {
          invite: await this.inviteView(manager, pending, group.gameServerId),
          created: false,
        };
      if (pending)
        await this.invites(manager).update(pending.id, {
          status: I.EXPIRED,
          respondedAt: now,
        });
      const invite = await this.invites(manager).save(
        this.invites(manager).create({
          id: randomUUID(),
          groupId: group.id,
          targetPlayerCharacterId: target.id,
          invitedByPlayerCharacterId: actorLink.id,
          status: I.PENDING,
          expiresAt: new Date(now.getTime() + this.inviteTtlMs),
          respondedAt: null,
          createdAt: now,
        }),
      );
      await this.record(
        manager,
        actor,
        AuditAction.PLAYER_GROUP_INVITED,
        group,
        {
          inviteId: invite.id,
          actorCharacterLinkId: actorLink.id,
          targetCharacterLinkId: target.id,
        },
        201,
      );
      events.push({
        type: 'GROUP_INVITE_CREATED',
        data: {
          groupId: group.id,
          gameServerId: group.gameServerId,
          inviteId: invite.id,
          targetCharacterId: target.characterExternalId,
          expiresAt: invite.expiresAt.toISOString(),
        },
        playerIds: [...this.owners(members), target.playerId],
      });
      return {
        invite: await this.inviteView(manager, invite, group.gameServerId),
        created: true,
      };
    });
  }
  // Pending, unexpired invites to the player's own VERIFIED characters.
  async listInvites(actor: PlayerActor): Promise<{ items: GroupInviteDto[] }> {
    const manager = this.database.manager;
    const invites = await this.invites(manager)
      .createQueryBuilder('invite')
      .innerJoin('invite.target', 'target')
      .innerJoin('invite.group', 'grp')
      .where('target.playerId = :playerId', { playerId: actor.playerId })
      .andWhere('target.status = :verified', {
        verified: CharacterLinkStatus.VERIFIED,
      })
      .andWhere('invite.status = :pending', { pending: I.PENDING })
      .andWhere({ expiresAt: MoreThan(new Date()) })
      .andWhere('grp.status = :active', { active: GroupStatus.ACTIVE })
      .orderBy('invite.createdAt', 'ASC')
      .addOrderBy('invite.id', 'ASC')
      .take(100)
      .getMany();
    if (!invites.length) return { items: [] };
    const groups = await manager
      .getRepository<PlayerGroup>('PlayerGroup')
      .findBy({ id: In([...new Set(invites.map((i) => i.groupId))]) });
    const server = new Map(groups.map((g) => [g.id, g.gameServerId]));
    return {
      items: await Promise.all(
        invites.map((i) => this.inviteView(manager, i, server.get(i.groupId)!)),
      ),
    };
  }
  // Locks group, invite and target link; only the target's owner may answer.
  private async answerable(
    manager: EntityManager,
    actor: PlayerActor,
    inviteId: string,
  ) {
    if (!isUUID(inviteId)) throw inviteNotFound();
    const located = await this.invites(manager).findOneBy({ id: inviteId });
    if (!located) throw inviteNotFound();
    const group = await this.lockGroup(manager, located.groupId);
    const invite = await this.invites(manager).findOneOrFail({
      where: { id: inviteId },
      lock: { mode: 'pessimistic_write' },
    });
    const target = await this.links(manager).findOne({
      where: {
        id: invite.targetPlayerCharacterId,
        playerId: actor.playerId,
        status: CharacterLinkStatus.VERIFIED,
      },
      lock: { mode: 'pessimistic_write' },
    });
    if (!target) throw inviteNotFound();
    if (invite.status !== I.PENDING)
      throw new ConflictException('Group invite no longer pending');
    return { group, invite, target, expired: invite.expiresAt <= new Date() };
  }
  // Marks an expired invite EXPIRED (committed), then reports 409.
  private async expire(manager: EntityManager, invite: PlayerGroupInvite) {
    await this.invites(manager).update(invite.id, {
      status: I.EXPIRED,
      respondedAt: new Date(),
    });
  }
  async accept(actor: PlayerActor, inviteId: string): Promise<GroupDto> {
    const outcome = await this.mutate(async (manager, events) => {
      const { group, invite, target, expired } = await this.answerable(
        manager,
        actor,
        inviteId,
      );
      if (expired) {
        await this.expire(manager, invite);
        return null;
      }
      if (group.status !== GroupStatus.ACTIVE)
        throw new ConflictException('Group not active');
      if (await this.inAnyGroup(manager, target.id))
        throw new ConflictException('Character already in a group');
      const members = await this.activeMembers(manager, group.id);
      // Capacity is checked under the group lock: no lost updates.
      if (members.length >= MAX_GROUP_MEMBERS)
        throw new ConflictException('Group full');
      const now = new Date();
      const member = await this.members(manager).save(
        this.members(manager).create({
          id: randomUUID(),
          groupId: group.id,
          playerCharacterId: target.id,
          role: GroupRole.MEMBER,
          joinedAt: now,
          leftAt: null,
        }),
      );
      await this.invites(manager).update(invite.id, {
        status: I.ACCEPTED,
        respondedAt: now,
      });
      await this.record(
        manager,
        actor,
        AuditAction.PLAYER_GROUP_INVITE_ACCEPTED,
        group,
        {
          inviteId: invite.id,
          characterLinkId: target.id,
          memberId: member.id,
        },
        200,
      );
      const current = await this.activeMembers(manager, group.id);
      const data = { groupId: group.id, gameServerId: group.gameServerId };
      events.push(
        {
          type: 'GROUP_INVITE_ACCEPTED',
          data: { ...data, inviteId: invite.id },
          playerIds: this.owners(current),
        },
        {
          type: 'GROUP_MEMBER_JOINED',
          data: {
            ...data,
            memberId: member.id,
            characterId: target.characterExternalId,
          },
          playerIds: this.owners(current),
        },
      );
      return this.view(group, current, actor);
    });
    if (!outcome) throw new ConflictException('Group invite expired');
    return outcome;
  }
  async decline(actor: PlayerActor, inviteId: string): Promise<GroupInviteDto> {
    const outcome = await this.mutate(async (manager, events) => {
      const { group, invite, target, expired } = await this.answerable(
        manager,
        actor,
        inviteId,
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
        AuditAction.PLAYER_GROUP_INVITE_DECLINED,
        group,
        {
          inviteId: invite.id,
          characterLinkId: target.id,
        },
        200,
      );
      events.push({
        type: 'GROUP_INVITE_DECLINED',
        data: {
          groupId: group.id,
          gameServerId: group.gameServerId,
          inviteId: invite.id,
        },
        playerIds: [
          ...this.owners(await this.activeMembers(manager, group.id)),
          actor.playerId,
        ],
      });
      return this.inviteView(manager, invite, group.gameServerId);
    });
    if (!outcome) throw new ConflictException('Group invite expired');
    return outcome;
  }
  // A member leaves; the leader leaving disbands the whole group.
  async leave(
    actor: PlayerActor,
    groupId: string,
    characterLinkId: string,
  ): Promise<{ status: GroupStatus }> {
    return this.mutate(async (manager, events) => {
      const group = await this.lockGroup(manager, groupId);
      const link = await this.ownLink(manager, actor, characterLinkId);
      const members = await this.activeMembers(manager, group.id);
      const member = members.find((m) => m.playerCharacterId === link.id);
      if (!member) throw groupNotFound();
      if (member.role === GroupRole.LEADER) {
        await this.disbandLocked(
          manager,
          actor,
          group,
          members,
          events,
          'LEADER_LEFT',
        );
        return { status: GroupStatus.DISBANDED };
      }
      await this.members(manager).update(member.id, { leftAt: new Date() });
      await this.record(
        manager,
        actor,
        AuditAction.PLAYER_GROUP_MEMBER_LEFT,
        group,
        {
          memberId: member.id,
          characterLinkId: link.id,
        },
        200,
      );
      events.push({
        type: 'GROUP_MEMBER_LEFT',
        data: {
          groupId: group.id,
          gameServerId: group.gameServerId,
          memberId: member.id,
        },
        playerIds: this.owners(members),
      });
      return { status: group.status };
    });
  }
  async kick(
    actor: PlayerActor,
    groupId: string,
    memberId: string,
  ): Promise<GroupDto> {
    return this.mutate(async (manager, events) => {
      const group = await this.lockGroup(manager, groupId);
      const members = await this.activeMembers(manager, group.id);
      const leader = this.requireLeader(members, actor);
      const member = members.find((m) => m.id === memberId);
      if (!member) throw new NotFoundException('Group member not found');
      if (member.id === leader.id)
        throw new BadRequestException('The leader cannot kick itself');
      await this.members(manager).update(member.id, { leftAt: new Date() });
      await this.record(
        manager,
        actor,
        AuditAction.PLAYER_GROUP_MEMBER_KICKED,
        group,
        {
          memberId: member.id,
          characterLinkId: member.playerCharacterId,
          actorCharacterLinkId: leader.playerCharacterId,
        },
        200,
      );
      events.push({
        type: 'GROUP_MEMBER_KICKED',
        data: {
          groupId: group.id,
          gameServerId: group.gameServerId,
          memberId: member.id,
        },
        playerIds: this.owners(members),
      });
      return this.view(
        group,
        members.filter((m) => m.id !== member.id),
        actor,
      );
    });
  }
  async disband(
    actor: PlayerActor,
    groupId: string,
  ): Promise<{ status: GroupStatus }> {
    return this.mutate(async (manager, events) => {
      const group = await this.lockGroup(manager, groupId);
      const members = await this.activeMembers(manager, group.id);
      this.requireLeader(members, actor);
      await this.disbandLocked(
        manager,
        actor,
        group,
        members,
        events,
        'DISBANDED_BY_LEADER',
      );
      return { status: GroupStatus.DISBANDED };
    });
  }
  private async disbandLocked(
    manager: EntityManager,
    actor: PlayerActor,
    group: PlayerGroup,
    members: Member[],
    events: PendingEvent[],
    reason: 'LEADER_LEFT' | 'DISBANDED_BY_LEADER',
  ) {
    const now = new Date();
    await manager
      .getRepository<PlayerGroup>('PlayerGroup')
      .update(group.id, { status: GroupStatus.DISBANDED, disbandedAt: now });
    await this.members(manager).update(
      { groupId: group.id, leftAt: IsNull() },
      { leftAt: now },
    );
    const pending = await this.invites(manager)
      .createQueryBuilder('invite')
      .innerJoinAndSelect('invite.target', 'target')
      .where('invite.groupId = :groupId', { groupId: group.id })
      .andWhere('invite.status = :pending', { pending: I.PENDING })
      .getMany();
    await this.invites(manager).update(
      { groupId: group.id, status: I.PENDING },
      { status: I.CANCELLED, respondedAt: now },
    );
    await this.record(
      manager,
      actor,
      AuditAction.PLAYER_GROUP_DISBANDED,
      group,
      {
        reason,
        memberCount: members.length,
        cancelledInvites: pending.length,
      },
      200,
    );
    events.push({
      type: 'GROUP_DISBANDED',
      data: { groupId: group.id, gameServerId: group.gameServerId, reason },
      playerIds: [
        ...this.owners(members),
        ...pending
          .filter((i) => i.target.status === CharacterLinkStatus.VERIFIED)
          .map((i) => i.target.playerId),
      ],
    });
  }
}
