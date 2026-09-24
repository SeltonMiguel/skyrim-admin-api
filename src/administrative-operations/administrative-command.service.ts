import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { AuthenticatedStaff } from '../auth/auth.types.js';
import type { Permission } from '../rbac/permissions.js';
import { staffActor } from '../actors/actor.contracts.js';
import { ActorCommandService } from '../actor-operations/actor-command.service.js';
import type {
  ActorSubmission,
  CommandAudit,
} from '../actor-operations/actor-command.service.js';
import type { CommandType } from '../game-bridge/command-contract.js';
import type { GameCommand } from '../game-bridge/entities/game-command.entity.js';
import type { GameCommandResult } from '../game-bridge/entities/game-command-result.entity.js';

export { idempotencyKey } from '../actor-operations/actor-command.service.js';
export type OperationCommand = GameCommand & {
  result: GameCommandResult | null;
};

// Staff wrapper over the actor-aware core: RBAC permission, then STAFF actor.
// Domain services (Character, Moderation, World) keep calling this API.
@Injectable()
export class AdministrativeCommandService {
  constructor(
    private readonly database: DataSource,
    private readonly commands: ActorCommandService,
  ) {}
  async create(
    input: ActorSubmission,
    auth: AuthenticatedStaff,
    permission: Permission,
    event?: CommandAudit,
  ): Promise<GameCommand> {
    if (!auth.permissions.includes(permission))
      throw new ForbiddenException('Missing required permissions');
    return (await this.commands.create(input, staffActor(auth.user), event))
      .command;
  }
  async get(
    id: string,
    auth: AuthenticatedStaff,
    permissionForType: (type: CommandType) => Permission | undefined,
    notFoundMessage: string,
  ): Promise<OperationCommand> {
    const repository =
      this.database.getRepository<OperationCommand>('GameCommand');
    const metadata = await repository.findOne({
      where: { id },
      select: { id: true, type: true },
    });
    const permission = metadata && permissionForType(metadata.type);
    if (!permission) throw new NotFoundException(notFoundMessage);
    if (!auth.permissions.includes(permission))
      throw new ForbiddenException('Missing required permissions');
    const command = await repository
      .createQueryBuilder('command')
      .select([
        'command.id',
        'command.gameServerId',
        'command.type',
        'command.status',
        'command.payload',
        'command.correlationId',
        'command.requestId',
        'command.requestedByStaffId',
        'command.dispatchAttempts',
        'command.lastDispatchAt',
        'command.ackDeadlineAt',
        'command.executionDeadlineAt',
        'command.acknowledgedAt',
        'command.completedAt',
        'command.createdAt',
      ])
      .leftJoinAndMapOne(
        'command.result',
        'GameCommandResult',
        'result',
        'result.gameCommandId = command.id',
      )
      .where('command.id = :id', { id })
      .getOne();
    if (!command) throw new NotFoundException(notFoundMessage);
    return command;
  }
}
