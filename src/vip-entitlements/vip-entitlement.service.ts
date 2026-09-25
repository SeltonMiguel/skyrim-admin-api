import { Injectable, NotFoundException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import type { FindOptionsWhere } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import {
  AuditAction,
  AuditOutcome,
  AuditResource,
} from '../audit/audit.types.js';
import {
  actor as copyActor,
  ActorType,
  idempotencyScope,
} from '../actors/actor.contracts.js';
import type { Actor, PlayerActor } from '../actors/actor.contracts.js';
import { idempotencyKey } from '../actor-operations/actor-command.service.js';
import { externalId } from '../game-bridge/command-validation.js';
import type { GameServer } from '../game-bridge/entities/game-server.entity.js';
import type { Player } from '../player-accounts/entities/player.entity.js';
import type { PlayerCharacter } from '../player-characters/entities/player-character.entity.js';
import { CharacterLinkStatus } from '../player-characters/player-character.contracts.js';
import type { VipRewardDelivery } from './entities/vip-reward-delivery.entity.js';
import { DeliveryStatus } from './vip-delivery.contracts.js';
import { RealtimeEventBus } from '../realtime-events/realtime-event-bus.js';
import type {
  RealtimeData,
  RealtimeEventType,
} from '../realtime-events/realtime-event-bus.js';
import type { VipOffer } from '../vip-store/entities/vip-offer.entity.js';
import { publicOffer } from '../vip-store/vip-offer.presenter.js';
import type { PlayerVipEntitlement } from './entities/player-vip-entitlement.entity.js';
import type { VipEntitlementRequest } from './entities/vip-entitlement-request.entity.js';
import {
  EntitlementOperation as Op,
  EntitlementStatus,
  VipEntitlementScope,
} from './vip-entitlement.contracts.js';
import type {
  EntitlementTarget,
  GrantEntitlementInput,
  GrantEntitlementResult,
  RevokeEntitlementInput,
  RevokeEntitlementResult,
} from './vip-entitlement.contracts.js';
import type {
  VipEffectiveDto,
  VipEntitlementDto,
} from './dto/vip-entitlement.dto.js';

type Entitlement = PlayerVipEntitlement & { offer: VipOffer };
interface Pending {
  type: RealtimeEventType;
  data: RealtimeData;
  playerIds: string[];
}
class Invalid extends Error {}
const isUniqueViolation = (error: unknown) =>
  error instanceof QueryFailedError &&
  (error.driverError as { code?: string }).code === '23505';
const effective = (e: PlayerVipEntitlement, now = new Date()) =>
  e.status === EntitlementStatus.ACTIVE &&
  (e.expiresAt === null || e.expiresAt > now);
// Effective = ACTIVE and not past its expiry; expiry is derived on read and
// materialized as EXPIRED only when a grant or revoke touches the row.
const EFFECTIVE = `entitlement.status = 'ACTIVE' AND (entitlement.expiresAt IS NULL OR entitlement.expiresAt > now())`;
// Only STAFF and SYSTEM grant or revoke; a player never grants itself.
function authority(value: unknown): Actor {
  const actor = copyActor(value);
  if (actor.type === ActorType.PLAYER) throw new Invalid('actor');
  return actor;
}
const source = (actor: Actor) =>
  actor.type === ActorType.SYSTEM ? `SYSTEM:${actor.source}` : 'STAFF';
const fingerprint = (content: unknown) =>
  createHash('sha256').update(JSON.stringify(content)).digest('hex');

// Internal VIP entitlement authority (no Player mutation route): grants and
// revokes by STAFF/SYSTEM actors with idempotency, Player reads, and typed
// checks for future domains (they never touch these tables directly).
//
// Lock order: offer row FOR SHARE (catalog changes take FOR UPDATE), then the
// holder's ACTIVE entitlement FOR UPDATE. The partial unique indexes are the
// final guarantee against two ACTIVE equivalent entitlements.
@Injectable()
export class VipEntitlementService {
  constructor(
    private readonly database: DataSource,
    private readonly audit: AuditService,
    private readonly events: RealtimeEventBus,
  ) {}
  private entitlements(manager: EntityManager) {
    return manager.getRepository<PlayerVipEntitlement>('PlayerVipEntitlement');
  }
  private requests(manager: EntityManager) {
    return manager.getRepository<VipEntitlementRequest>(
      'VipEntitlementRequest',
    );
  }
  private holder(target: EntitlementTarget) {
    return target.scope === VipEntitlementScope.PLAYER
      ? { scope: target.scope, playerId: target.playerId }
      : {
          scope: target.scope,
          gameServerId: target.gameServerId,
          characterExternalId: target.characterExternalId,
        };
  }
  private target(value: EntitlementTarget): EntitlementTarget {
    if (value?.scope === VipEntitlementScope.PLAYER && isUUID(value.playerId))
      return { scope: value.scope, playerId: value.playerId };
    if (
      value?.scope === VipEntitlementScope.CHARACTER &&
      isUUID(value.gameServerId)
    )
      return {
        scope: value.scope,
        gameServerId: value.gameServerId,
        characterExternalId: externalId(value.characterExternalId),
      };
    throw new Invalid('target');
  }
  // Replays answer with the recorded entitlement; other content conflicts.
  private async replayed(
    manager: EntityManager,
    scope: string,
    key: string,
    operation: Op,
    content: string,
  ): Promise<VipEntitlementRequest | 'CONFLICT' | null> {
    const existing = await this.requests(manager).findOneBy({
      idempotencyScope: scope,
      idempotencyKey: key,
    });
    if (!existing) return null;
    return existing.operation === operation &&
      existing.requestFingerprint === content
      ? existing
      : 'CONFLICT';
  }
  private record(
    manager: EntityManager,
    actor: Actor,
    action: AuditAction,
    entitlement: Entitlement,
  ) {
    return this.audit.record(
      {
        actor,
        action,
        resourceType: AuditResource.VIP_ENTITLEMENT,
        resourceId: entitlement.id,
        metadata: {
          entitlementId: entitlement.id,
          productId: entitlement.vipOfferId,
          productCode: entitlement.offer.code,
          scope: entitlement.scope,
          ...(entitlement.scope === VipEntitlementScope.CHARACTER
            ? {
                gameServerId: entitlement.gameServerId,
                characterExternalId: entitlement.characterExternalId,
              }
            : {}),
          status: entitlement.status,
          expiresAt: entitlement.expiresAt?.toISOString() ?? null,
          source: entitlement.source,
        },
        outcome: AuditOutcome.SUCCESS,
      },
      manager,
    );
  }
  // PLAYER: the account; CHARACTER: its current VERIFIED owner, if any.
  private async recipients(
    manager: EntityManager,
    entitlement: PlayerVipEntitlement,
  ): Promise<string[]> {
    if (entitlement.playerId) return [entitlement.playerId];
    const owner = await manager
      .getRepository<PlayerCharacter>('PlayerCharacter')
      .findOneBy({
        gameServerId: entitlement.gameServerId!,
        characterExternalId: entitlement.characterExternalId!,
        status: CharacterLinkStatus.VERIFIED,
      });
    return owner ? [owner.playerId] : [];
  }
  private data(entitlement: Entitlement): RealtimeData {
    return {
      entitlementId: entitlement.id,
      scope: entitlement.scope,
      status: entitlement.status,
      productId: entitlement.vipOfferId,
      productCode: entitlement.offer.code,
      productName: entitlement.offer.name,
      gameServerId: entitlement.gameServerId,
      characterId: entitlement.characterExternalId,
      grantedAt: entitlement.grantedAt.toISOString(),
      expiresAt: entitlement.expiresAt?.toISOString() ?? null,
    };
  }
  private async publishAfter<T>(
    work: (manager: EntityManager, events: Pending[]) => Promise<T>,
  ): Promise<T> {
    const events: Pending[] = [];
    const result = await this.database.transaction((m) => work(m, events));
    for (const event of events)
      this.events.publish(event.type, event.data, {
        playerIds: event.playerIds,
      });
    return result;
  }

  async grant(
    input: GrantEntitlementInput,
    retried = false,
  ): Promise<GrantEntitlementResult> {
    let actor: Actor, key: string, target: EntitlementTarget;
    let expiresAt: Date | null, externalReference: string | null;
    try {
      actor = authority(input.actor);
    } catch {
      return { outcome: 'REJECTED', reason: 'ACTOR_NOT_ALLOWED' };
    }
    try {
      key = idempotencyKey(input.idempotencyKey);
      if (!isUUID(input.offerId)) throw new Invalid('offer');
      target = this.target(input.target);
      expiresAt = input.expiresAt ?? null;
      if (
        expiresAt !== null &&
        (!(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime()))
      )
        throw new Invalid('expiresAt');
      externalReference =
        input.externalReference == null
          ? null
          : externalId(input.externalReference);
    } catch {
      return { outcome: 'REJECTED', reason: 'INVALID_INPUT' };
    }
    const scope = idempotencyScope(actor);
    const content = fingerprint([
      Op.GRANT,
      input.offerId,
      target,
      expiresAt?.toISOString() ?? null,
      externalReference,
    ]);
    try {
      return await this.publishAfter(async (manager, events) => {
        const replay = await this.replayed(
          manager,
          scope,
          key,
          Op.GRANT,
          content,
        );
        if (replay === 'CONFLICT')
          return { outcome: 'REJECTED', reason: 'IDEMPOTENCY_CONFLICT' };
        if (replay)
          return {
            outcome: 'ALREADY_GRANTED',
            entitlementId: replay.entitlementId,
          };
        const now = new Date();
        if (expiresAt && expiresAt <= now)
          return { outcome: 'REJECTED', reason: 'INVALID_INPUT' };
        // The active catalog controls new grants.
        const offer = await manager
          .getRepository<VipOffer>('VipOffer')
          .findOne({
            where: { id: input.offerId },
            lock: { mode: 'pessimistic_read' },
          });
        if (!offer) return { outcome: 'REJECTED', reason: 'OFFER_NOT_FOUND' };
        if (!offer.active)
          return { outcome: 'REJECTED', reason: 'OFFER_NOT_ACTIVE' };
        if (offer.entitlementScope !== target.scope)
          return { outcome: 'REJECTED', reason: 'SCOPE_MISMATCH' };
        const exists =
          target.scope === VipEntitlementScope.PLAYER
            ? await manager
                .getRepository<Player>('Player')
                .existsBy({ id: target.playerId })
            : await manager
                .getRepository<GameServer>('GameServer')
                .existsBy({ id: target.gameServerId });
        if (!exists) return { outcome: 'REJECTED', reason: 'TARGET_NOT_FOUND' };
        const current = await this.entitlements(manager).findOne({
          where: {
            ...this.holder(target),
            vipOfferId: offer.id,
            status: EntitlementStatus.ACTIVE,
          } as FindOptionsWhere<PlayerVipEntitlement>,
          lock: { mode: 'pessimistic_write' },
        });
        if (current && effective(current, now)) {
          // Equivalent right already held: returned unchanged (no extension).
          await this.requests(manager).insert({
            idempotencyScope: scope,
            idempotencyKey: key,
            operation: Op.GRANT,
            requestFingerprint: content,
            entitlementId: current.id,
          });
          return { outcome: 'ALREADY_ACTIVE', entitlementId: current.id };
        }
        if (current)
          await this.entitlements(manager).update(current.id, {
            status: EntitlementStatus.EXPIRED,
          });
        const id = randomUUID();
        await this.entitlements(manager).insert({
          id,
          vipOfferId: offer.id,
          scope: target.scope,
          playerId:
            target.scope === VipEntitlementScope.PLAYER
              ? target.playerId
              : null,
          gameServerId:
            target.scope === VipEntitlementScope.CHARACTER
              ? target.gameServerId
              : null,
          characterExternalId:
            target.scope === VipEntitlementScope.CHARACTER
              ? target.characterExternalId
              : null,
          status: EntitlementStatus.ACTIVE,
          grantedAt: now,
          expiresAt,
          revokedAt: null,
          source: source(actor),
          externalReference,
        });
        await this.requests(manager).insert({
          idempotencyScope: scope,
          idempotencyKey: key,
          operation: Op.GRANT,
          requestFingerprint: content,
          entitlementId: id,
        });
        const saved = (await this.entitlements(manager).findOneOrFail({
          where: { id },
          relations: { offer: true },
        })) as Entitlement;
        await this.record(
          manager,
          actor,
          AuditAction.VIP_ENTITLEMENT_GRANTED,
          saved,
        );
        // CHARACTER rights have a gameplay target: one delivery per typed
        // reward, snapshotted now (Etapa 11.4). PLAYER rights stay account
        // rights: no character is ever chosen for them.
        if (target.scope === VipEntitlementScope.CHARACTER)
          await manager
            .getRepository<VipRewardDelivery>('VipRewardDelivery')
            .insert(
              offer.rewards.map((reward, rewardIndex) => ({
                entitlementId: id,
                rewardIndex,
                reward,
                gameServerId: target.gameServerId,
                characterExternalId: target.characterExternalId,
                status: DeliveryStatus.PENDING,
              })),
            );
        events.push({
          type: 'VIP_ENTITLEMENT_GRANTED',
          data: this.data(saved),
          playerIds: await this.recipients(manager, saved),
        });
        return { outcome: 'GRANTED', entitlementId: id };
      });
    } catch (error) {
      // A concurrent equivalent grant or the same key won: read it back.
      if (!retried && isUniqueViolation(error)) return this.grant(input, true);
      throw error;
    }
  }
  async revoke(
    input: RevokeEntitlementInput,
    retried = false,
  ): Promise<RevokeEntitlementResult> {
    let actor: Actor, key: string;
    try {
      actor = authority(input.actor);
    } catch {
      return { outcome: 'REJECTED', reason: 'ACTOR_NOT_ALLOWED' };
    }
    try {
      key = idempotencyKey(input.idempotencyKey);
      if (!isUUID(input.entitlementId)) throw new Invalid('entitlement');
    } catch {
      return { outcome: 'REJECTED', reason: 'INVALID_INPUT' };
    }
    const scope = idempotencyScope(actor);
    const content = fingerprint([Op.REVOKE, input.entitlementId]);
    try {
      return await this.publishAfter(async (manager, events) => {
        const replay = await this.replayed(
          manager,
          scope,
          key,
          Op.REVOKE,
          content,
        );
        if (replay === 'CONFLICT')
          return { outcome: 'REJECTED', reason: 'IDEMPOTENCY_CONFLICT' };
        if (replay)
          return {
            outcome: 'ALREADY_REVOKED',
            entitlementId: replay.entitlementId,
          };
        const entitlement = await this.entitlements(manager).findOne({
          where: { id: input.entitlementId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!entitlement)
          return { outcome: 'REJECTED', reason: 'ENTITLEMENT_NOT_FOUND' };
        const remember = () =>
          this.requests(manager).insert({
            idempotencyScope: scope,
            idempotencyKey: key,
            operation: Op.REVOKE,
            requestFingerprint: content,
            entitlementId: entitlement.id,
          });
        if (entitlement.status === EntitlementStatus.REVOKED) {
          await remember();
          return { outcome: 'ALREADY_REVOKED', entitlementId: entitlement.id };
        }
        if (!effective(entitlement)) {
          if (entitlement.status === EntitlementStatus.ACTIVE)
            await this.entitlements(manager).update(entitlement.id, {
              status: EntitlementStatus.EXPIRED,
            });
          return { outcome: 'REJECTED', reason: 'NOT_ACTIVE' };
        }
        await this.entitlements(manager).update(entitlement.id, {
          status: EntitlementStatus.REVOKED,
          revokedAt: new Date(),
        });
        await remember();
        const saved = (await this.entitlements(manager).findOneOrFail({
          where: { id: entitlement.id },
          relations: { offer: true },
        })) as Entitlement;
        await this.record(
          manager,
          actor,
          AuditAction.VIP_ENTITLEMENT_REVOKED,
          saved,
        );
        events.push({
          type: 'VIP_ENTITLEMENT_REVOKED',
          data: this.data(saved),
          playerIds: await this.recipients(manager, saved),
        });
        return { outcome: 'REVOKED', entitlementId: entitlement.id };
      });
    } catch (error) {
      if (!retried && isUniqueViolation(error)) return this.revoke(input, true);
      throw error;
    }
  }

  private effectiveOf(
    manager: EntityManager,
    where: (
      builder: ReturnType<VipEntitlementService['builder']>,
    ) => ReturnType<VipEntitlementService['builder']>,
  ) {
    return where(this.builder(manager))
      .andWhere(EFFECTIVE)
      .orderBy('entitlement.grantedAt', 'DESC')
      .addOrderBy('entitlement.id', 'DESC')
      .getMany() as Promise<Entitlement[]>;
  }
  private builder(manager: EntityManager) {
    // The offer is joined whatever its catalog state: a disabled offer does
    // not hide a right already granted.
    return this.entitlements(manager)
      .createQueryBuilder('entitlement')
      .innerJoinAndSelect('entitlement.offer', 'offer');
  }
  private view(entitlement: Entitlement): VipEntitlementDto {
    return {
      entitlementId: entitlement.id,
      product: publicOffer(entitlement.offer),
      scope: entitlement.scope,
      grantedAt: entitlement.grantedAt,
      expiresAt: entitlement.expiresAt,
    };
  }
  private playerRights(manager: EntityManager, playerId: string) {
    return this.effectiveOf(manager, (b) =>
      b
        .where('entitlement.scope = :scope', {
          scope: VipEntitlementScope.PLAYER,
        })
        .andWhere('entitlement.playerId = :player', { player: playerId }),
    );
  }
  private characterRights(
    manager: EntityManager,
    gameServerId: string,
    characterExternalId: string,
  ) {
    return this.effectiveOf(manager, (b) =>
      b
        .where('entitlement.scope = :scope', {
          scope: VipEntitlementScope.CHARACTER,
        })
        .andWhere('entitlement.gameServerId = :server', {
          server: gameServerId,
        })
        .andWhere('entitlement.characterExternalId = :character', {
          character: characterExternalId,
        }),
    );
  }
  private async ownLink(actor: PlayerActor, id: string) {
    const link = await this.database.manager
      .getRepository<PlayerCharacter>('PlayerCharacter')
      .findOneBy({
        id,
        playerId: actor.playerId,
        status: CharacterLinkStatus.VERIFIED,
      });
    if (!link) throw new NotFoundException('Character not found');
    return link;
  }
  async forPlayer(actor: PlayerActor) {
    const rights = await this.playerRights(
      this.database.manager,
      actor.playerId,
    );
    return { items: rights.map((e) => this.view(e)) };
  }
  // CHARACTER rights belong to the character identity: the current owner
  // sees them, a previous owner no longer can.
  async forCharacter(actor: PlayerActor, characterLinkId: string) {
    const link = await this.ownLink(actor, characterLinkId);
    const rights = await this.characterRights(
      this.database.manager,
      link.gameServerId,
      link.characterExternalId,
    );
    return { items: rights.map((e) => this.view(e)) };
  }
  async effective(
    actor: PlayerActor,
    characterLinkId: string,
  ): Promise<VipEffectiveDto> {
    const link = await this.ownLink(actor, characterLinkId);
    const manager = this.database.manager;
    const [player, character] = await Promise.all([
      this.playerRights(manager, actor.playerId),
      this.characterRights(
        manager,
        link.gameServerId,
        link.characterExternalId,
      ),
    ]);
    return {
      player: player.map((e) => this.view(e)),
      character: character.map((e) => this.view(e)),
    };
  }
  // Typed checks for future VIP benefits, by the stable offer code.
  async hasPlayerEntitlement(
    playerId: string,
    offerCode: string,
  ): Promise<boolean> {
    if (!isUUID(playerId)) return false;
    return (await this.playerRights(this.database.manager, playerId)).some(
      (e) => e.offer.code === offerCode,
    );
  }
  async hasCharacterEntitlement(
    gameServerId: string,
    characterExternalId: string,
    offerCode: string,
  ): Promise<boolean> {
    if (!isUUID(gameServerId)) return false;
    return (
      await this.characterRights(
        this.database.manager,
        gameServerId,
        characterExternalId,
      )
    ).some((e) => e.offer.code === offerCode);
  }
}
