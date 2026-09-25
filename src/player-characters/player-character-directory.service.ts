import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { pageResult } from '../admin-queries/query-pagination.js';
import type { PlayerActor } from '../actors/actor.contracts.js';
import type { GameServer } from '../game-bridge/entities/game-server.entity.js';
import type { PlayerCharacter } from './entities/player-character.entity.js';
import { CharacterLinkStatus as S } from './player-character.contracts.js';
import type {
  PlayerCharacterDto,
  PlayerCharactersQueryDto,
} from './dto/player-character.dto.js';

type LinkWithServer = PlayerCharacter & { gameServer: GameServer };
// REVOKED links stay in the database as history but are not player-facing.
const VISIBLE = [S.PENDING, S.VERIFIED];

// Read-only view of the player's own character links (1:N). No selected or
// active character exists server-side; each operation names its character.
@Injectable()
export class PlayerCharacterDirectoryService {
  constructor(private readonly database: DataSource) {}
  private links(actor: PlayerActor) {
    // One query with the server join: no N+1.
    return this.database
      .getRepository<LinkWithServer>('PlayerCharacter')
      .createQueryBuilder('link')
      .innerJoinAndSelect('link.gameServer', 'server')
      .where('link.playerId = :playerId', { playerId: actor.playerId })
      .andWhere({ status: In(VISIBLE) });
  }
  async list(actor: PlayerActor, query: PlayerCharactersQueryDto) {
    const [items, total] = await this.links(actor)
      // 'VERIFIED' > 'PENDING': VERIFIED first, then oldest link, then id.
      .orderBy('link.status', 'DESC')
      .addOrderBy('link.createdAt', 'ASC')
      .addOrderBy('link.id', 'ASC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();
    return pageResult(items.map(playerCharacter), total, query);
  }
  // Other player, REVOKED and unknown are indistinguishable.
  async get(actor: PlayerActor, id: string): Promise<PlayerCharacterDto> {
    const link = await this.links(actor)
      .andWhere('link.id = :id', { id })
      .getOne();
    if (!link) throw new NotFoundException('Character not found');
    return playerCharacter(link);
  }
}
// Allowlist: no playerId, revokedAt, challenge data or command internals.
function playerCharacter(link: LinkWithServer): PlayerCharacterDto {
  return {
    id: link.id,
    gameServer: {
      id: link.gameServer.id,
      code: link.gameServer.code,
      name: link.gameServer.name,
      enabled: link.gameServer.enabled,
    },
    characterId: link.characterExternalId,
    status: link.status,
    verifiedAt: link.verifiedAt,
    createdAt: link.createdAt,
  };
}
