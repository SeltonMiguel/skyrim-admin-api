import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isUUID } from 'class-validator';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, In } from 'typeorm';
import { pageResult } from '../admin-queries/query-pagination.js';
import { idempotencyScope } from '../actors/actor.contracts.js';
import type { PlayerActor } from '../actors/actor.contracts.js';
import { idempotencyKey } from '../actor-operations/actor-command.service.js';
import type { ApplicationConfig } from '../config/environment.js';
import type { GameServer } from '../game-bridge/entities/game-server.entity.js';
import { PlayerStatus } from '../player-accounts/player-account.contracts.js';
import type { Player } from '../player-accounts/entities/player.entity.js';
import type { PlayerCharacter } from '../player-characters/entities/player-character.entity.js';
import { CharacterLinkStatus } from '../player-characters/player-character.contracts.js';
import type { PlayerGroup } from '../player-groups/entities/player-group.entity.js';
import type { PlayerGroupMember } from '../player-groups/entities/player-group-member.entity.js';
import { GroupStatus } from '../player-groups/player-group.contracts.js';
import type { PlayerGuild } from '../player-guilds/entities/player-guild.entity.js';
import type { PlayerGuildMember } from '../player-guilds/entities/player-guild-member.entity.js';
import { GuildStatus } from '../player-guilds/player-guild.contracts.js';
import { RealtimeEventBus } from '../realtime-events/realtime-event-bus.js';
import {
  ChatRateLimitedException,
  ChatRateLimiter,
} from './chat-rate-limiter.js';
import type { PlayerChatDirectThread } from './entities/player-chat-direct-thread.entity.js';
import type { PlayerChatMessage } from './entities/player-chat-message.entity.js';
import type { PlayerChatRequest } from './entities/player-chat-request.entity.js';
import { ChatChannel, chatMessage } from './player-chat.contracts.js';
import type {
  ChatMessageDto,
  ChatPageQueryDto,
} from './dto/player-chat.dto.js';

export type ChatTarget =
  | { channel: ChatChannel.GLOBAL }
  | { channel: ChatChannel.GROUP; groupId: string }
  | { channel: ChatChannel.GUILD; guildId: string }
  | { channel: ChatChannel.DIRECT; targetCharacterId: string };
const characterNotFound = () => new NotFoundException('Character not found');
const groupNotFound = () => new NotFoundException('Group not found');
const guildNotFound = () => new NotFoundException('Guild not found');
const targetUnavailable = () =>
  new NotFoundException('Character not available');
const shared = { mode: 'pessimistic_read' } as const;

// Access per channel, decided by the database at insert time:
// - GLOBAL: any own VERIFIED character of the server;
// - GROUP: the current ACTIVE membership of that ownership link;
// - GUILD: the character identity's ACTIVE membership (survives an owner
//   change, like the guild itself);
// - DIRECT: a thread between the two CURRENT ownership links. A new owner
//   of either character never reads the previous owner's private messages.
//
// Lock order: idempotency claim, group/guild row FOR SHARE (their
// membership mutations take FOR UPDATE, so leave/kick/disband serialize with
// sends), then the ownership links FOR SHARE in ascending id order (revoke
// takes FOR UPDATE). Sends never block each other.
@Injectable()
export class PlayerChatService {
  private readonly retention: number;
  constructor(
    private readonly database: DataSource,
    private readonly events: RealtimeEventBus,
    private readonly limiter: ChatRateLimiter,
    config: ConfigService<{ application: ApplicationConfig }, true>,
  ) {
    this.retention = config.get('application', {
      infer: true,
    }).playerChat.retention;
  }
  private linksRepo(manager: EntityManager) {
    return manager.getRepository<PlayerCharacter>('PlayerCharacter');
  }
  private messages(manager: EntityManager) {
    return manager.getRepository<PlayerChatMessage>('PlayerChatMessage');
  }
  // Own and VERIFIED, else the same 404 as unknown/foreign/PENDING/REVOKED.
  private async ownLink(
    manager: EntityManager,
    actor: PlayerActor,
    id: string,
    lock = false,
  ): Promise<PlayerCharacter> {
    const link = isUUID(id)
      ? await this.linksRepo(manager).findOne({
          where: {
            id,
            playerId: actor.playerId,
            status: CharacterLinkStatus.VERIFIED,
          },
          ...(lock ? { lock: shared } : {}),
        })
      : null;
    if (!link) throw characterNotFound();
    return link;
  }
  // The current VERIFIED owner link of a character on a server.
  private async currentLink(
    manager: EntityManager,
    gameServerId: string,
    characterExternalId: string,
    lock = false,
  ): Promise<PlayerCharacter | null> {
    return this.linksRepo(manager).findOne({
      where: {
        gameServerId,
        characterExternalId,
        status: CharacterLinkStatus.VERIFIED,
      },
      ...(lock ? { lock: shared } : {}),
    });
  }
  private async activeGroup(manager: EntityManager, id: string, lock = false) {
    const group = isUUID(id)
      ? await manager.getRepository<PlayerGroup>('PlayerGroup').findOne({
          where: { id, status: GroupStatus.ACTIVE },
          ...(lock ? { lock: shared } : {}),
        })
      : null;
    if (!group) throw groupNotFound();
    return group;
  }
  private async activeGuild(manager: EntityManager, id: string, lock = false) {
    const guild = isUUID(id)
      ? await manager.getRepository<PlayerGuild>('PlayerGuild').findOne({
          where: { id, status: GuildStatus.ACTIVE },
          ...(lock ? { lock: shared } : {}),
        })
      : null;
    if (!guild) throw guildNotFound();
    return guild;
  }
  private async assertGroupMember(
    manager: EntityManager,
    group: PlayerGroup,
    link: PlayerCharacter,
  ) {
    const active = await manager
      .getRepository<PlayerGroupMember>('PlayerGroupMember')
      .createQueryBuilder('member')
      .where('member.groupId = :group', { group: group.id })
      .andWhere('member.playerCharacterId = :link', { link: link.id })
      .andWhere('member.leftAt IS NULL')
      .getExists();
    if (!active) throw groupNotFound();
  }
  private async assertGuildMember(
    manager: EntityManager,
    guild: PlayerGuild,
    link: PlayerCharacter,
  ) {
    const active = await manager
      .getRepository<PlayerGuildMember>('PlayerGuildMember')
      .createQueryBuilder('member')
      .where('member.guildId = :guild', { guild: guild.id })
      .andWhere('member.gameServerId = :server', {
        server: link.gameServerId,
      })
      .andWhere('member.characterExternalId = :character', {
        character: link.characterExternalId,
      })
      .andWhere('member.leftAt IS NULL')
      .getExists();
    if (!active) throw guildNotFound();
  }
  // Canonical pair: one thread per two ownership links.
  private pair(a: string, b: string): [string, string] {
    return a < b ? [a, b] : [b, a];
  }
  private async thread(
    manager: EntityManager,
    me: PlayerCharacter,
    other: PlayerCharacter,
  ): Promise<PlayerChatDirectThread | null> {
    const [a, b] = this.pair(me.id, other.id);
    return manager
      .getRepository<PlayerChatDirectThread>('PlayerChatDirectThread')
      .findOneBy({
        participantAPlayerCharacterId: a,
        participantBPlayerCharacterId: b,
      });
  }
  private async ensureThread(
    manager: EntityManager,
    me: PlayerCharacter,
    other: PlayerCharacter,
  ): Promise<string> {
    const [a, b] = this.pair(me.id, other.id);
    await manager.query(
      `INSERT INTO player_chat_direct_threads(game_server_id, participant_a_player_character_id, participant_b_player_character_id)
       VALUES ($1, $2, $3) ON CONFLICT (participant_a_player_character_id, participant_b_player_character_id) DO NOTHING`,
      [me.gameServerId, a, b],
    );
    return (await this.thread(manager, me, other))!.id;
  }
  private view(
    message: PlayerChatMessage,
    targetCharacterId: string | null = null,
  ): ChatMessageDto {
    return {
      messageId: message.id,
      channelType: message.channelType,
      gameServerId: message.gameServerId,
      senderCharacterId: message.senderCharacterId,
      message: message.content,
      groupId: message.groupId,
      guildId: message.guildId,
      targetCharacterId:
        message.channelType === ChatChannel.DIRECT ? targetCharacterId : null,
      createdAt: message.createdAt,
    };
  }
  // DIRECT messages name the other participant as target.
  private async directTarget(
    manager: EntityManager,
    message: PlayerChatMessage,
  ): Promise<string | null> {
    if (!message.directThreadId) return null;
    const thread = await manager
      .getRepository<PlayerChatDirectThread>('PlayerChatDirectThread')
      .findOneByOrFail({ id: message.directThreadId });
    const otherId =
      thread.participantAPlayerCharacterId === message.senderPlayerCharacterId
        ? thread.participantBPlayerCharacterId
        : thread.participantAPlayerCharacterId;
    return (await this.linksRepo(manager).findOneByOrFail({ id: otherId }))
      .characterExternalId;
  }
  // Realtime recipients, resolved in the send transaction.
  private async recipients(
    manager: EntityManager,
    target: ChatTarget,
    gameServerId: string,
    direct: string[],
  ): Promise<string[]> {
    const rows: { player_id: string }[] =
      target.channel === ChatChannel.GLOBAL
        ? // MVP: every ACTIVE player with a VERIFIED character on the
          // server; fine for now, not indefinitely scalable (Etapa 12).
          await manager.query(
            `SELECT DISTINCT c.player_id FROM player_characters c JOIN players p ON p.id = c.player_id
              WHERE c.game_server_id = $1 AND c.status = 'VERIFIED' AND p.status = 'ACTIVE'`,
            [gameServerId],
          )
        : target.channel === ChatChannel.GROUP
          ? await manager.query(
              `SELECT DISTINCT c.player_id FROM player_group_members m
                 JOIN player_characters c ON c.id = m.player_character_id AND c.status = 'VERIFIED'
                WHERE m.group_id = $1 AND m.left_at IS NULL`,
              [target.groupId],
            )
          : target.channel === ChatChannel.GUILD
            ? await manager.query(
                `SELECT DISTINCT c.player_id FROM player_guild_members m
                   JOIN player_characters c ON c.game_server_id = m.game_server_id
                    AND c.character_external_id = m.character_external_id AND c.status = 'VERIFIED'
                  WHERE m.guild_id = $1 AND m.left_at IS NULL`,
                [target.guildId],
              )
            : direct.map((player_id) => ({ player_id }));
    return rows.map((r) => r.player_id);
  }

  async send(
    actor: PlayerActor,
    key: string | undefined,
    characterLinkId: string,
    rawMessage: string,
    target: ChatTarget,
  ): Promise<ChatMessageDto> {
    const idempotency = idempotencyKey(key);
    const content = chatMessage(rawMessage);
    const scope = idempotencyScope(actor);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([target, characterLinkId, content]))
      .digest('hex');
    // A known key is a retry: it never consumes quota. Otherwise reserve a
    // slot for this key (shared by concurrent retries of it).
    const known = await this.database
      .getRepository<PlayerChatRequest>('PlayerChatRequest')
      .existsBy({ idempotencyScope: scope, idempotencyKey: idempotency });
    const bucket = `${actor.playerId}:${characterLinkId}`;
    let owner = false;
    if (!known) {
      const slot = this.limiter.acquire(bucket, idempotency);
      if ('retryAfter' in slot)
        throw new ChatRateLimitedException(slot.retryAfter);
      owner = slot.owner;
    }
    try {
      const { dto, playerIds } = await this.database.transaction((manager) =>
        this.apply(manager, actor, {
          scope,
          key: idempotency,
          fingerprint,
          characterLinkId,
          content,
          target,
        }),
      );
      if (playerIds.length)
        this.events.publish(
          'CHAT_MESSAGE_CREATED',
          { ...dto, createdAt: dto.createdAt.toISOString() },
          { playerIds },
        );
      return dto;
    } catch (error) {
      if (owner) this.limiter.release(bucket, idempotency);
      throw error;
    }
  }
  private async apply(
    manager: EntityManager,
    actor: PlayerActor,
    input: {
      scope: string;
      key: string;
      fingerprint: string;
      characterLinkId: string;
      content: string;
      target: ChatTarget;
    },
  ): Promise<{ dto: ChatMessageDto; playerIds: string[] }> {
    const messageId = randomUUID();
    const claimed: unknown[] = await manager.query(
      `INSERT INTO player_chat_requests(idempotency_scope, idempotency_key, player_id, request_fingerprint, message_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + $6 * interval '1 second')
       ON CONFLICT (idempotency_scope, idempotency_key) DO NOTHING RETURNING id`,
      [
        input.scope,
        input.key,
        actor.playerId,
        input.fingerprint,
        messageId,
        this.retention,
      ],
    );
    if (!claimed.length) {
      const existing = await manager
        .getRepository<PlayerChatRequest>('PlayerChatRequest')
        .findOneByOrFail({
          idempotencyScope: input.scope,
          idempotencyKey: input.key,
        });
      if (existing.requestFingerprint !== input.fingerprint)
        throw new ConflictException(
          'Idempotency-Key already used with different content',
        );
      // Replays answer only while the player still owns the sender link.
      await this.ownLink(manager, actor, input.characterLinkId);
      const message = await this.messages(manager).findOneByOrFail({
        id: existing.messageId,
      });
      return {
        dto: this.view(message, await this.directTarget(manager, message)),
        playerIds: [],
      };
    }
    const { target } = input;
    const group =
      target.channel === ChatChannel.GROUP
        ? await this.activeGroup(manager, target.groupId, true)
        : null;
    const guild =
      target.channel === ChatChannel.GUILD
        ? await this.activeGuild(manager, target.guildId, true)
        : null;
    let link: PlayerCharacter;
    let other: PlayerCharacter | null = null;
    if (target.channel === ChatChannel.DIRECT) {
      // Both links FOR SHARE in ascending id order.
      const mine = await this.ownLink(manager, actor, input.characterLinkId);
      if (mine.characterExternalId === target.targetCharacterId)
        throw new BadRequestException('Cannot message your own character');
      const theirs = await this.currentLink(
        manager,
        mine.gameServerId,
        target.targetCharacterId,
      );
      if (!theirs) throw targetUnavailable();
      const locked = await this.linksRepo(manager).find({
        where: {
          id: In([mine.id, theirs.id]),
          status: CharacterLinkStatus.VERIFIED,
        },
        order: { id: 'ASC' },
        lock: shared,
      });
      link = locked.find((l) => l.id === mine.id) ?? throwNotFound();
      other = locked.find((l) => l.id === theirs.id) ?? throwUnavailable();
      const player = await manager
        .getRepository<Player>('Player')
        .findOneBy({ id: other.playerId });
      if (player?.status !== PlayerStatus.ACTIVE) throw targetUnavailable();
    } else
      link = await this.ownLink(manager, actor, input.characterLinkId, true);
    const server = await manager
      .getRepository<GameServer>('GameServer')
      .findOneByOrFail({ id: link.gameServerId });
    // A disabled server stops new messages; history stays readable.
    if (!server.enabled) throw new ConflictException('Game server disabled');
    if (group) {
      if (group.gameServerId !== link.gameServerId) throw groupNotFound();
      await this.assertGroupMember(manager, group, link);
    }
    if (guild) {
      if (guild.gameServerId !== link.gameServerId) throw guildNotFound();
      await this.assertGuildMember(manager, guild, link);
    }
    const threadId = other
      ? await this.ensureThread(manager, link, other)
      : null;
    await manager.query(
      `INSERT INTO player_chat_messages(id, game_server_id, channel_type, sender_character_id, sender_player_character_id, group_id, guild_id, direct_thread_id, content, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + $10 * interval '1 second')`,
      [
        messageId,
        link.gameServerId,
        target.channel,
        link.characterExternalId,
        link.id,
        group?.id ?? null,
        guild?.id ?? null,
        threadId,
        input.content,
        this.retention,
      ],
    );
    const message = await this.messages(manager).findOneByOrFail({
      id: messageId,
    });
    return {
      dto: this.view(message, other?.characterExternalId ?? null),
      playerIds: await this.recipients(
        manager,
        target,
        link.gameServerId,
        other ? [link.playerId, other.playerId] : [],
      ),
    };
  }

  private async history(
    where: (builder: ReturnType<PlayerChatService['builder']>) => void,
    query: ChatPageQueryDto,
    targetOf: (message: PlayerChatMessage) => string | null = () => null,
  ) {
    const builder = this.builder();
    where(builder);
    // Expired messages are hidden, never deleted here.
    const [messages, total] = await builder
      .andWhere('message.expiresAt > now()')
      .orderBy('message.createdAt', 'DESC')
      .addOrderBy('message.id', 'DESC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();
    return pageResult(
      messages.map((m) => this.view(m, targetOf(m))),
      total,
      query,
    );
  }
  private builder() {
    return this.messages(this.database.manager).createQueryBuilder('message');
  }
  async globalHistory(
    actor: PlayerActor,
    characterLinkId: string,
    query: ChatPageQueryDto,
  ) {
    const link = await this.ownLink(
      this.database.manager,
      actor,
      characterLinkId,
    );
    return this.history(
      (b) =>
        b
          .where('message.gameServerId = :server', {
            server: link.gameServerId,
          })
          .andWhere('message.channelType = :channel', {
            channel: ChatChannel.GLOBAL,
          }),
      query,
    );
  }
  async groupHistory(
    actor: PlayerActor,
    groupId: string,
    characterLinkId: string,
    query: ChatPageQueryDto,
  ) {
    const manager = this.database.manager;
    const group = await this.activeGroup(manager, groupId);
    const link = await this.ownLink(manager, actor, characterLinkId);
    await this.assertGroupMember(manager, group, link);
    return this.history(
      (b) => b.where('message.groupId = :group', { group: group.id }),
      query,
    );
  }
  async guildHistory(
    actor: PlayerActor,
    guildId: string,
    characterLinkId: string,
    query: ChatPageQueryDto,
  ) {
    const manager = this.database.manager;
    const guild = await this.activeGuild(manager, guildId);
    const link = await this.ownLink(manager, actor, characterLinkId);
    if (guild.gameServerId !== link.gameServerId) throw guildNotFound();
    await this.assertGuildMember(manager, guild, link);
    return this.history(
      (b) => b.where('message.guildId = :guild', { guild: guild.id }),
      query,
    );
  }
  // Only the thread of the two CURRENT ownership links is readable.
  async directHistory(
    actor: PlayerActor,
    characterLinkId: string,
    targetCharacterId: string,
    query: ChatPageQueryDto,
  ) {
    const manager = this.database.manager;
    const link = await this.ownLink(manager, actor, characterLinkId);
    if (link.characterExternalId === targetCharacterId)
      throw new BadRequestException('Cannot message your own character');
    const other = await this.currentLink(
      manager,
      link.gameServerId,
      targetCharacterId,
    );
    if (!other) throw targetUnavailable();
    const thread = await this.thread(manager, link, other);
    if (!thread) return pageResult([], 0, query);
    return this.history(
      (b) => b.where('message.directThreadId = :thread', { thread: thread.id }),
      query,
      (m) =>
        m.senderPlayerCharacterId === link.id
          ? other.characterExternalId
          : link.characterExternalId,
    );
  }
}
function throwNotFound(): never {
  throw characterNotFound();
}
function throwUnavailable(): never {
  throw targetUnavailable();
}
