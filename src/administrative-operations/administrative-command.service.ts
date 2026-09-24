import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import { AuditOutcome } from '../audit/audit.types.js';
import type { AuditEvent } from '../audit/audit.types.js';
import type { AuthenticatedStaff } from '../auth/auth.types.js';
import type { Permission } from '../rbac/permissions.js';
import { GameCommandBus } from '../game-bridge/game-command-bus.js';
import { GameServerService } from '../game-bridge/game-server.service.js';
import { commandPayload, identifier } from '../game-bridge/command-contract.js';
import type {
  CommandType,
  SubmitCommand,
} from '../game-bridge/command-contract.js';
import type { GameCommand } from '../game-bridge/entities/game-command.entity.js';
import type { GameCommandResult } from '../game-bridge/entities/game-command-result.entity.js';

export function idempotencyKey(value: unknown): string {
  if (typeof value !== 'string') identifier('', 'Idempotency-Key');
  const key = value as string;
  identifier(key, 'Idempotency-Key');
  return key;
}
export type OperationCommand = GameCommand & {
  result: GameCommandResult | null;
};
type OperationAudit = (
  command: GameCommand,
) => Omit<AuditEvent, 'actor' | 'statusCode'>;

// Shared Etapa 05 workflow: domain policy supplies the permission and audit allowlist.
// This service queues committed work; transport remains exclusively in the dispatcher.
@Injectable()
export class AdministrativeCommandService {
  constructor(
    private readonly database: DataSource,
    private readonly bus: GameCommandBus,
    private readonly servers: GameServerService,
    private readonly audit: AuditService,
  ) {}
  async create(
    input: SubmitCommand,
    auth: AuthenticatedStaff,
    permission: Permission,
    event?: OperationAudit,
  ): Promise<GameCommand> {
    if (!auth.permissions.includes(permission))
      throw new ForbiddenException('Missing required permissions');
    const submission = {
      gameServerId: input.gameServerId,
      type: input.type,
      payload: commandPayload(input.type, input.payload),
      idempotencyKey: idempotencyKey(input.idempotencyKey),
      requestedByStaffId: auth.user.id,
    } as SubmitCommand;
    const actor = {
      id: auth.user.id,
      username: auth.user.username,
      displayName: auth.user.displayName,
      roleName: auth.user.roleName,
    };
    return this.database.transaction(async (manager) => {
      const server = await this.servers.get(
        submission.gameServerId,
        manager,
        true,
      );
      // Domain HTTP replays, like new operations, require an enabled server.
      if (!server.enabled) throw new ConflictException('Game server disabled');
      const { command, created } = await this.bus.submitInTransaction(
        submission,
        manager,
      );
      if (created && event)
        await this.audit.record(
          {
            ...event(command),
            actor,
            outcome: AuditOutcome.SUCCESS,
            statusCode: 202,
          },
          manager,
        );
      return command;
    });
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
