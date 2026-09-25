import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import {
  AuditAction,
  AuditOutcome,
  AuditResource,
} from '../audit/audit.types.js';
import type { PlayerActor } from '../actors/actor.contracts.js';
import type { PlayerCharacter } from '../player-characters/entities/player-character.entity.js';
import { CharacterLinkStatus } from '../player-characters/player-character.contracts.js';
import { CharacterProfession } from './entities/character-profession.entity.js';
import {
  MIN_PROFESSION_LEVEL,
  ProfessionProgressionPolicy as Policy,
} from './profession.contracts.js';
import type { Profession, ProfessionProgress } from './profession.contracts.js';
import type { ProfessionDto } from './dto/profession.dto.js';

export function professionProgress(
  row: CharacterProfession,
): ProfessionProgress {
  return {
    gameServerId: row.gameServerId,
    characterExternalId: row.characterExternalId,
    profession: row.profession,
    level: row.level,
    experience: row.experience,
    nextLevelExperience: Policy.nextLevelExperience(row.level),
  };
}
// Player view: addressed by the authorizing link; no character id or player id.
function professionDto(
  linkId: string,
  row: CharacterProfession,
): ProfessionDto {
  return {
    characterLinkId: linkId,
    profession: row.profession,
    level: row.level,
    experience: row.experience,
    nextLevelExperience: Policy.nextLevelExperience(row.level),
  };
}
const notFound = () => new NotFoundException('Character not found');

// The profession belongs to the character (server + character id). A player
// reaches it only through an own VERIFIED link, whose identity is used; the
// character id is never taken from request input.
@Injectable()
export class ProfessionService {
  constructor(
    private readonly database: DataSource,
    private readonly audit: AuditService,
  ) {}
  // Other player, PENDING, REVOKED and unknown links are indistinguishable.
  private async ownedLink(
    manager: EntityManager,
    actor: PlayerActor,
    linkId: string,
    lock: boolean,
  ) {
    const link = await manager
      .getRepository<PlayerCharacter>('PlayerCharacter')
      .findOne({
        where: {
          id: linkId,
          playerId: actor.playerId,
          status: CharacterLinkStatus.VERIFIED,
        },
        ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
      });
    if (!link) throw notFound();
    return link;
  }
  private professionOf(manager: EntityManager, link: PlayerCharacter) {
    return manager
      .getRepository<CharacterProfession>('CharacterProfession')
      .findOneBy({
        gameServerId: link.gameServerId,
        characterExternalId: link.characterExternalId,
      });
  }
  async get(actor: PlayerActor, linkId: string): Promise<ProfessionDto> {
    const manager = this.database.manager;
    const link = await this.ownedLink(manager, actor, linkId, false);
    const row = await this.professionOf(manager, link);
    return row
      ? professionDto(link.id, row)
      : { characterLinkId: link.id, profession: null };
  }
  // Same profession again is idempotent (no Audit); a different one is 409.
  async select(
    actor: PlayerActor,
    linkId: string,
    profession: Profession,
  ): Promise<{ state: ProfessionDto; created: boolean }> {
    return this.database.transaction(async (manager) => {
      // Locks the link so a concurrent revoke cannot interleave.
      const link = await this.ownedLink(manager, actor, linkId, true);
      const id = randomUUID();
      await manager
        .getRepository<CharacterProfession>('CharacterProfession')
        .createQueryBuilder()
        .insert()
        .values({
          id,
          gameServerId: link.gameServerId,
          characterExternalId: link.characterExternalId,
          profession,
          experience: 0,
          level: MIN_PROFESSION_LEVEL,
        })
        .onConflict(
          'ON CONSTRAINT character_professions_character_key DO NOTHING',
        )
        .execute();
      const row = (await this.professionOf(manager, link))!;
      if (row.profession !== profession)
        throw new ConflictException(
          'Profession already selected',
          'PROFESSION_ALREADY_SELECTED',
        );
      const created = row.id === id;
      if (created)
        await this.audit.record(
          {
            actor,
            action: AuditAction.PROFESSION_SELECTED,
            resourceType: AuditResource.CHARACTER_PROFESSION,
            resourceId: row.id,
            metadata: {
              // The ownership link that authorized the selection.
              playerCharacterId: link.id,
              gameServerId: row.gameServerId,
              characterExternalId: row.characterExternalId,
              profession: row.profession,
              level: row.level,
            },
            outcome: AuditOutcome.SUCCESS,
            statusCode: 201,
          },
          manager,
        );
      return { state: professionDto(link.id, row), created };
    });
  }
}
