import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { uuid } from '../game-bridge/command-contract.js';
import { externalId } from '../game-bridge/command-validation.js';
import { PlayerCharacter } from './entities/player-character.entity.js';
import { CharacterLinkStatus } from './player-character.contracts.js';

// Reusable ownership policy for 10.5+. The playerId must come from the
// authenticated PlayerActor, never from request input. Account status is the
// guard's concern; this policy answers only "is this character VERIFIED for
// this player on this server".
@Injectable()
export class CharacterOwnershipService {
  constructor(private readonly database: DataSource) {}
  async findVerifiedOwnership(
    playerId: string,
    gameServerId: string,
    characterExternalId: string,
    manager: EntityManager = this.database.manager,
  ): Promise<PlayerCharacter | null> {
    uuid(playerId);
    uuid(gameServerId);
    return manager.getRepository<PlayerCharacter>('PlayerCharacter').findOneBy({
      playerId,
      gameServerId,
      characterExternalId: externalId(characterExternalId),
      status: CharacterLinkStatus.VERIFIED,
    });
  }
  // 404 for "not yours", "not verified" and "unknown" alike: nothing leaks.
  async requireVerifiedOwnership(
    playerId: string,
    gameServerId: string,
    characterExternalId: string,
    manager?: EntityManager,
  ): Promise<PlayerCharacter> {
    const link = await this.findVerifiedOwnership(
      playerId,
      gameServerId,
      characterExternalId,
      manager,
    );
    if (!link) throw new NotFoundException('Character not available');
    return link;
  }
}
