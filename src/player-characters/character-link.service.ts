import { RealtimeEventBus } from '../realtime-events/realtime-event-bus.js';
import type { AgentEventHook } from '../actors/agent-event.contracts.js';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isUUID } from 'class-validator';
import { randomUUID } from 'node:crypto';
import {
  DataSource,
  EntityManager,
  IsNull,
  Not,
  QueryFailedError,
} from 'typeorm';
import type { ApplicationConfig } from '../config/environment.js';
import { AuditService } from '../audit/audit.service.js';
import {
  AuditAction,
  AuditOutcome,
  AuditResource,
} from '../audit/audit.types.js';
import { systemActor, SystemSource } from '../actors/actor.contracts.js';
import type { PlayerActor } from '../actors/actor.contracts.js';
import { uuid } from '../game-bridge/command-contract.js';
import { externalId } from '../game-bridge/command-validation.js';
import type { GameServer } from '../game-bridge/entities/game-server.entity.js';
import type { Player } from '../player-accounts/entities/player.entity.js';
import { PlayerStatus } from '../player-accounts/player-account.contracts.js';
import { PlayerCharacter } from './entities/player-character.entity.js';
import { PlayerCharacterLinkChallenge } from './entities/player-character-link-challenge.entity.js';
import {
  challengeHash,
  CharacterLinkStatus as S,
  generateChallenge,
  normalizeChallenge,
} from './player-character.contracts.js';
import type { OwnershipConfirmation } from './player-character.contracts.js';

type Reject = Extract<OwnershipConfirmation, { outcome: 'REJECTED' }>['reason'];
const reject = (reason: Reject): OwnershipConfirmation => ({
  outcome: 'REJECTED',
  reason,
});
const unavailable = () => new ConflictException('Character unavailable');

// Lock order everywhere: player_characters row, then its challenges.
@Injectable()
export class CharacterLinkService {
  private readonly ttlMs: number;
  constructor(
    private readonly database: DataSource,
    private readonly audit: AuditService,
    private readonly events: RealtimeEventBus,
    config: ConfigService<{ application: ApplicationConfig }, true>,
  ) {
    this.ttlMs =
      config.get('application', { infer: true }).playerCharacters.challengeTtl *
      1000;
  }
  private links(manager: EntityManager) {
    return manager.getRepository<PlayerCharacter>('PlayerCharacter');
  }
  private challenges(manager: EntityManager) {
    return manager.getRepository<PlayerCharacterLinkChallenge>(
      'PlayerCharacterLinkChallenge',
    );
  }
  // Knowing a character id proves nothing: this only opens a PENDING claim
  // and returns a single-use challenge to be typed inside the game.
  async request(
    actor: PlayerActor,
    input: { gameServerId: string; characterExternalId: string },
  ): Promise<{ link: PlayerCharacter; challenge: string; expiresAt: Date }> {
    const playerId = actor.playerId;
    const gameServerId = input.gameServerId;
    uuid(gameServerId);
    const characterExternalId = externalId(input.characterExternalId);
    const challenge = generateChallenge();
    const hash = challengeHash(normalizeChallenge(challenge)!);
    const result = await this.database.transaction(async (manager) => {
      const server = await manager
        .getRepository<GameServer>('GameServer')
        .findOneBy({ id: gameServerId });
      if (!server) throw new NotFoundException('Game server not found');
      if (!server.enabled) throw new ConflictException('Game server disabled');
      // Early answer only; the partial unique index decides at confirmation.
      if (
        await this.links(manager).existsBy({
          gameServerId,
          characterExternalId,
          status: S.VERIFIED,
          playerId: Not(playerId),
        })
      )
        throw unavailable();
      await this.links(manager)
        .createQueryBuilder()
        .insert()
        .values({
          id: randomUUID(),
          playerId,
          gameServerId,
          characterExternalId,
          status: S.PENDING,
        })
        .onConflict('ON CONSTRAINT player_characters_link_key DO NOTHING')
        .execute();
      const link = await this.links(manager).findOneOrFail({
        where: { playerId, gameServerId, characterExternalId },
        lock: { mode: 'pessimistic_write' },
      });
      if (link.status === S.VERIFIED)
        throw new ConflictException('Character link already verified');
      const relink = link.status === S.REVOKED;
      if (relink) {
        link.status = S.PENDING;
        link.verifiedAt = null;
        link.revokedAt = null;
        await this.links(manager).save(link);
      }
      const now = new Date();
      await this.revokeActiveChallenges(manager, link.id, now);
      const expiresAt = new Date(now.getTime() + this.ttlMs);
      await this.challenges(manager).insert({
        id: randomUUID(),
        playerCharacterId: link.id,
        challengeHash: hash,
        expiresAt,
        createdAt: now,
      });
      await this.record(
        manager,
        actor,
        AuditAction.PLAYER_CHARACTER_LINK_REQUESTED,
        link,
        {
          status: S.PENDING,
          relink,
        },
        201,
      );
      return { link, challenge, expiresAt };
    });
    this.notify(result.link);
    return result;
  }
  async get(actor: PlayerActor, linkId: string): Promise<PlayerCharacter> {
    const link = isUUID(linkId)
      ? await this.links(this.database.manager).findOneBy({
          id: linkId,
          playerId: actor.playerId,
        })
      : null;
    if (!link) throw new NotFoundException('Character link not found');
    return link;
  }
  // Idempotent: an already REVOKED link is returned unchanged, without Audit.
  async revoke(actor: PlayerActor, linkId: string): Promise<PlayerCharacter> {
    if (!isUUID(linkId))
      throw new NotFoundException('Character link not found');
    let changed = false;
    const result = await this.database.transaction(async (manager) => {
      const link = await this.links(manager).findOne({
        where: { id: linkId, playerId: actor.playerId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!link) throw new NotFoundException('Character link not found');
      if (link.status === S.REVOKED) return link;
      changed = true;
      const previousStatus = link.status;
      const now = new Date();
      link.status = S.REVOKED;
      link.revokedAt = now;
      await this.links(manager).save(link);
      await this.revokeActiveChallenges(manager, link.id, now);
      await this.record(
        manager,
        actor,
        AuditAction.PLAYER_CHARACTER_LINK_REVOKED,
        link,
        {
          previousStatus,
        },
        200,
      );
      return link;
    });
    if (changed) this.notify(result);
    return result;
  }
  // Trusted internal entry point for the authenticated Agent transport
  // (Etapa 11). Never exposed over HTTP. A replay of a consumed challenge for
  // the same, still VERIFIED link returns ALREADY_VERIFIED without effects.
  // gameServerId must be the authenticated Agent session's (Etapa 11.4). A
  // challenge of another server is a CHALLENGE_MISMATCH (the player typed a
  // code of another server): refused without change. onAccepted runs in this
  // transaction before VERIFIED/ALREADY_VERIFIED commits.
  async confirmFromAgent(
    input: {
      challenge: string;
      gameServerId: string;
      characterExternalId: string;
    },
    onAccepted?: AgentEventHook,
  ): Promise<OwnershipConfirmation> {
    const canonical = normalizeChallenge(input.challenge);
    if (!canonical) return reject('INVALID_CHALLENGE');
    let characterExternalId: string;
    try {
      characterExternalId = externalId(input.characterExternalId);
    } catch {
      return reject('CHALLENGE_MISMATCH');
    }
    if (!isUUID(input.gameServerId)) return reject('CHALLENGE_MISMATCH');
    const hash = challengeHash(canonical);
    let changed: PlayerCharacter | undefined;
    try {
      const result = await this.database.transaction<OwnershipConfirmation>(
        async (manager) => {
          const located = await this.challenges(manager)
            .createQueryBuilder('challenge')
            .select(['challenge.id', 'challenge.playerCharacterId'])
            .where('challenge.challengeHash = :hash', { hash })
            .getOne();
          if (!located) return reject('INVALID_CHALLENGE');
          const link = await this.links(manager).findOneOrFail({
            where: { id: located.playerCharacterId },
            lock: { mode: 'pessimistic_write' },
          });
          const challenge = await this.challenges(manager).findOneOrFail({
            where: { id: located.id },
            lock: { mode: 'pessimistic_write' },
          });
          const matches =
            link.gameServerId === input.gameServerId &&
            link.characterExternalId === characterExternalId;
          if (challenge.consumedAt) {
            if (!matches || link.status !== S.VERIFIED)
              return reject('INVALID_CHALLENGE');
            await onAccepted?.(manager);
            return {
              outcome: 'ALREADY_VERIFIED',
              linkId: link.id,
              playerId: link.playerId,
            };
          }
          if (challenge.revokedAt || link.status !== S.PENDING)
            return reject('INVALID_CHALLENGE');
          if (challenge.expiresAt.getTime() <= Date.now())
            return reject('EXPIRED_CHALLENGE');
          if (!matches) return reject('CHALLENGE_MISMATCH');
          const server = await manager
            .getRepository<GameServer>('GameServer')
            .findOneBy({ id: link.gameServerId });
          if (!server?.enabled) return reject('SERVER_UNAVAILABLE');
          // Re-read the account: a suspension after the request blocks it.
          const player = await manager.getRepository<Player>('Player').findOne({
            where: { id: link.playerId },
            lock: { mode: 'pessimistic_read' },
          });
          if (player?.status !== PlayerStatus.ACTIVE)
            return reject('PLAYER_UNAVAILABLE');
          if (
            await this.links(manager).existsBy({
              gameServerId: link.gameServerId,
              characterExternalId: link.characterExternalId,
              status: S.VERIFIED,
            })
          )
            return reject('CHARACTER_UNAVAILABLE');
          const now = new Date();
          challenge.consumedAt = now;
          await this.challenges(manager).update(challenge.id, {
            consumedAt: now,
          });
          link.status = S.VERIFIED;
          link.verifiedAt = now;
          await this.links(manager).save(link);
          await this.record(
            manager,
            systemActor(SystemSource.AGENT),
            AuditAction.PLAYER_CHARACTER_LINK_VERIFIED,
            link,
            { playerId: link.playerId },
          );
          await onAccepted?.(manager);
          changed = link;
          return {
            outcome: 'VERIFIED',
            linkId: link.id,
            playerId: link.playerId,
          };
        },
      );
      if (changed) this.notify(changed);
      return result;
    } catch (error) {
      // Concurrent confirmation for another player lost the VERIFIED index race.
      if (
        error instanceof QueryFailedError &&
        (error.driverError as { constraint?: string })?.constraint ===
          'player_characters_verified_key'
      )
        return reject('CHARACTER_UNAVAILABLE');
      throw error;
    }
  }
  // Called only after the owning transaction (including Agent receipt) commits.
  private notify(link: PlayerCharacter): void {
    this.events.publish(
      'PLAYER_CHARACTER_LINK_UPDATED',
      {
        characterLinkId: link.id,
        gameServerId: link.gameServerId,
        characterExternalId: link.characterExternalId,
        status: link.status,
        updatedAt: link.updatedAt.toISOString(),
      },
      { playerIds: [link.playerId] },
    );
  }
  private revokeActiveChallenges(
    manager: EntityManager,
    playerCharacterId: string,
    now: Date,
  ) {
    return this.challenges(manager).update(
      { playerCharacterId, consumedAt: IsNull(), revokedAt: IsNull() },
      { revokedAt: now },
    );
  }
  // Metadata allowlist: never the challenge, its hash or provider identity.
  private record(
    manager: EntityManager,
    actor: PlayerActor | ReturnType<typeof systemActor>,
    action: AuditAction,
    link: PlayerCharacter,
    extra: Record<string, unknown>,
    statusCode?: number,
  ) {
    return this.audit.record(
      {
        actor,
        action,
        resourceType: AuditResource.PLAYER_CHARACTER,
        resourceId: link.id,
        metadata: {
          linkId: link.id,
          gameServerId: link.gameServerId,
          characterExternalId: link.characterExternalId,
          ...extra,
        },
        outcome: AuditOutcome.SUCCESS,
        statusCode,
      },
      manager,
    );
  }
}
