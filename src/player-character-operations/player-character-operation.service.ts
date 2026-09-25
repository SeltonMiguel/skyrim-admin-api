import { Injectable, NotFoundException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { DataSource, In } from 'typeorm';
import { ActorCommandService } from '../actor-operations/actor-command.service.js';
import type { PlayerActor } from '../actors/actor.contracts.js';
import {
  commandPayload,
  commandResult,
} from '../game-bridge/command-contract.js';
import type { SubmitCommand } from '../game-bridge/command-contract.js';
import type { GameCommand } from '../game-bridge/entities/game-command.entity.js';
import type { GameCommandResult } from '../game-bridge/entities/game-command-result.entity.js';
import { CharacterOwnershipService } from '../player-characters/character-ownership.service.js';
import { PLAYER_CHARACTER_QUERY_TYPES } from './player-character-query.contracts.js';
import type { PlayerCharacterQueryType } from './player-character-query.contracts.js';
import type {
  PlayerCharacterOperationDto,
  PlayerCharacterOperationReferenceDto,
} from './dto/player-character-operation.dto.js';

type CommandWithResult = GameCommand & { result: GameCommandResult | null };
const notFound = () => new NotFoundException('Character operation not found');

// Player-facing read-only queries over the shared actor-aware pipeline: ownership is
// checked inside the command transaction, the actor is PLAYER and idempotency
// is scoped to PLAYER:<playerId>. Queries are not audited, as for staff.
@Injectable()
export class PlayerCharacterOperationService {
  constructor(
    private readonly database: DataSource,
    private readonly commands: ActorCommandService,
    private readonly ownership: CharacterOwnershipService,
  ) {}
  async request(
    actor: PlayerActor,
    type: PlayerCharacterQueryType,
    route: { gameServerId: string; characterId: string },
    idempotencyKey: string,
  ): Promise<PlayerCharacterOperationReferenceDto> {
    const { command } = await this.commands.create(
      {
        gameServerId: route.gameServerId,
        type,
        // The existing contract of the type builds and validates the payload.
        payload: commandPayload(type, { characterId: route.characterId }),
        idempotencyKey,
      } as SubmitCommand,
      actor,
      undefined,
      async (manager) => {
        await this.ownership.requireVerifiedOwnership(
          actor.playerId,
          route.gameServerId,
          route.characterId,
          manager,
        );
      },
    );
    return reference(command);
  }
  // Only commands this player created and of these types are visible.
  async get(
    actor: PlayerActor,
    operationId: string,
  ): Promise<PlayerCharacterOperationDto> {
    if (!isUUID(operationId)) throw notFound();
    const command = await this.database
      .getRepository<CommandWithResult>('GameCommand')
      .createQueryBuilder('command')
      .leftJoinAndMapOne(
        'command.result',
        'GameCommandResult',
        'result',
        'result.gameCommandId = command.id',
      )
      .where('command.id = :operationId', { operationId })
      .andWhere('command.requestedByPlayerId = :playerId', {
        playerId: actor.playerId,
      })
      .andWhere({ type: In([...PLAYER_CHARACTER_QUERY_TYPES]) })
      .getOne();
    if (!command) throw notFound();
    const result = command.result;
    return {
      ...reference(command),
      completedAt: command.completedAt,
      result: result
        ? {
            outcome: result.outcome,
            data:
              result.result === null
                ? null
                : commandResult(
                    command.type as PlayerCharacterQueryType,
                    result.result,
                    command.payload,
                  ),
            errorCode: result.errorCode,
            receivedAt: result.receivedAt,
          }
        : null,
    };
  }
}
// Allowlist: no attribution, scope, key, correlation, lease or deadlines.
function reference(command: GameCommand): PlayerCharacterOperationReferenceDto {
  const type = command.type as PlayerCharacterQueryType;
  return {
    operationId: command.id,
    type,
    gameServerId: command.gameServerId,
    characterId: commandPayload(type, command.payload).characterId,
    status: command.status,
    createdAt: command.createdAt,
  };
}
