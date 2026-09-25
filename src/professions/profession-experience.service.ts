import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import {
  AuditAction,
  AuditOutcome,
  AuditResource,
} from '../audit/audit.types.js';
import type { AgentEventHook } from '../actors/agent-event.contracts.js';
import { systemActor, SystemSource } from '../actors/actor.contracts.js';
import { externalId } from '../game-bridge/command-validation.js';
import { PlayerStatus } from '../player-accounts/player-account.contracts.js';
import type { PlayerCharacter } from '../player-characters/entities/player-character.entity.js';
import { CharacterLinkStatus } from '../player-characters/player-character.contracts.js';
import { CharacterProfession } from './entities/character-profession.entity.js';
import { ProfessionExperienceEvent } from './entities/profession-experience-event.entity.js';
import {
  MAX_EXPERIENCE_GRANT,
  ProfessionProgressionPolicy as Policy,
} from './profession.contracts.js';
import type { ExperienceGrant } from './profession.contracts.js';
import { professionProgress } from './profession.service.js';

type Reason = Extract<ExperienceGrant, { outcome: 'REJECTED' }>['reason'];
const reject = (reason: Reason): ExperienceGrant => ({
  outcome: 'REJECTED',
  reason,
});

// Trusted internal entry point for the Agent transport (Etapa 11); there is
// no HTTP route. The Agent identifies the character as it knows it (server +
// character id), which is the profession's identity, and must emit event ids
// unique within each game server.
@Injectable()
export class ProfessionExperienceService {
  constructor(
    private readonly database: DataSource,
    private readonly audit: AuditService,
  ) {}
  // gameServerId is the authenticated Agent session's (Etapa 11.4): the
  // profession identity is (session server, character), so another server's
  // character cannot be reached. onAccepted runs in this transaction before
  // GRANTED/ALREADY_APPLIED commits.
  async grantFromAgent(
    input: {
      gameServerId: string;
      characterExternalId: string;
      eventId: string;
      amount: number;
    },
    onAccepted?: AgentEventHook,
  ): Promise<ExperienceGrant> {
    let characterExternalId: string, eventId: string;
    try {
      characterExternalId = externalId(input.characterExternalId);
      eventId = externalId(input.eventId);
    } catch {
      return reject('INVALID_INPUT');
    }
    const { gameServerId, amount } = input;
    if (
      !isUUID(gameServerId) ||
      !Number.isSafeInteger(amount) ||
      amount < 1 ||
      amount > MAX_EXPERIENCE_GRANT
    )
      return reject('INVALID_INPUT');
    return this.database.transaction(async (manager) => {
      // The profession row lock serializes every grant for this character:
      // replays see the committed event and concurrent events never lose XP.
      const professions = manager.getRepository<CharacterProfession>(
        'CharacterProfession',
      );
      const profession = await professions.findOne({
        where: { gameServerId, characterExternalId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!profession) return reject('PROFESSION_NOT_SELECTED');
      // MVP rule: a character whose current VERIFIED owner is suspended or
      // banned does not progress. Without a current owner, the character's
      // own progress still accrues (it belongs to the character).
      const owner = await manager
        .getRepository<PlayerCharacter>('PlayerCharacter')
        .findOne({
          where: {
            gameServerId,
            characterExternalId,
            status: CharacterLinkStatus.VERIFIED,
          },
          relations: { player: true },
        });
      if (owner && owner.player.status !== PlayerStatus.ACTIVE)
        return reject('PLAYER_UNAVAILABLE');
      const events = manager.getRepository<ProfessionExperienceEvent>(
        'ProfessionExperienceEvent',
      );
      const inserted = await events
        .createQueryBuilder()
        .insert()
        .values({
          id: randomUUID(),
          characterProfessionId: profession.id,
          gameServerId,
          externalEventId: eventId,
          amount,
        })
        .onConflict(
          'ON CONSTRAINT profession_experience_events_event_key DO NOTHING',
        )
        .returning('id')
        .execute();
      if (!inserted.raw.length) {
        const existing = await events.findOneByOrFail({
          gameServerId,
          externalEventId: eventId,
        });
        if (
          existing.characterProfessionId !== profession.id ||
          existing.amount !== amount
        )
          return reject('EVENT_CONFLICT');
        await onAccepted?.(manager);
        return {
          outcome: 'ALREADY_APPLIED',
          progress: professionProgress(profession),
        };
      }
      const previousLevel = profession.level;
      profession.experience = Policy.add(profession.experience, amount);
      profession.level = Policy.levelFor(profession.experience);
      await professions.update(profession.id, {
        experience: profession.experience,
        level: profession.level,
      });
      await this.audit.record(
        {
          actor: systemActor(SystemSource.AGENT),
          action: AuditAction.PROFESSION_EXPERIENCE_GRANTED,
          resourceType: AuditResource.CHARACTER_PROFESSION,
          resourceId: profession.id,
          metadata: {
            gameServerId,
            characterExternalId,
            profession: profession.profession,
            amount,
            previousLevel,
            newLevel: profession.level,
            externalEventId: eventId,
          },
          outcome: AuditOutcome.SUCCESS,
        },
        manager,
      );
      await onAccepted?.(manager);
      return { outcome: 'GRANTED', progress: professionProgress(profession) };
    });
  }
}
