import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import { AuditOutcome, AuditResource } from '../audit/audit.types.js';
import type { AuthenticatedStaff } from '../auth/auth.types.js';
import { GameCommandBus } from '../game-bridge/game-command-bus.js';
import { GameServerService } from '../game-bridge/game-server.service.js';
import { identifier } from '../game-bridge/command-contract.js';
import type { SubmitCommand } from '../game-bridge/command-contract.js';
import type { GameCommand } from '../game-bridge/entities/game-command.entity.js';
import type { GameCommandResult } from '../game-bridge/entities/game-command-result.entity.js';
import {
  characterPayload,
  isCharacterCommand,
} from './character-command.contracts.js';
import type { CharacterCommandType } from './character-command.contracts.js';
import { CHARACTER_POLICY } from './character-policy.js';
import { characterAuditMetadata } from './character-audit.js';
import {
  operationDetail,
  operationReference,
} from './character-operation.presenter.js';

export function idempotencyKey(value: unknown): string {
  if (typeof value !== 'string') identifier('', 'Idempotency-Key');
  const key = value as string;
  identifier(key, 'Idempotency-Key');
  return key;
}
export type CharacterSubmission = {
  [T in CharacterCommandType]: Omit<
    Extract<SubmitCommand, { type: T }>,
    'requestedByStaffId'
  >;
}[CharacterCommandType];

@Injectable()
export class CharacterService {
  constructor(
    private readonly database: DataSource,
    private readonly bus: GameCommandBus,
    private readonly servers: GameServerService,
    private readonly audit: AuditService,
  ) {}

  async create(input: CharacterSubmission, auth: AuthenticatedStaff) {
    if (!isCharacterCommand(input.type))
      throw new NotFoundException('Character operation not found');
    const policy = CHARACTER_POLICY[input.type];
    if (!auth.permissions.includes(policy.permission))
      throw new ForbiddenException('Missing required permissions');
    // Validate/copy before awaits; attribution always comes from authentication.
    const payload = characterPayload(input.type, input.payload);
    const submission = {
      gameServerId: input.gameServerId,
      type: input.type,
      payload,
      idempotencyKey: idempotencyKey(input.idempotencyKey),
      requestedByStaffId: auth.user.id,
    } as SubmitCommand;
    const actor = {
      id: auth.user.id,
      username: auth.user.username,
      displayName: auth.user.displayName,
      roleName: auth.user.roleName,
    };
    const command = await this.database.transaction(async (manager) => {
      const server = await this.servers.get(
        submission.gameServerId,
        manager,
        true,
      );
      // Character HTTP operations reject disabled servers, including replays.
      if (!server.enabled) throw new ConflictException('Game server disabled');
      const { command, created } = await this.bus.submitInTransaction(
        submission,
        manager,
      );
      if (created && policy.auditAction)
        await this.audit.record(
          {
            actor,
            action: policy.auditAction,
            outcome: AuditOutcome.SUCCESS,
            resourceType: AuditResource.CHARACTER,
            resourceId: payload.characterId,
            statusCode: 202,
            metadata: characterAuditMetadata(command),
          },
          manager,
        );
      return command;
    });
    // Creation only queues work. Dispatch/retries belong to the existing worker API.
    return operationReference(command);
  }
  async get(id: string, auth: AuthenticatedStaff) {
    const repository = this.database.getRepository<
      GameCommand & { result: GameCommandResult | null }
    >('GameCommand');
    const metadata = await repository.findOne({
      where: { id },
      select: { id: true, type: true },
    });
    if (!metadata || !isCharacterCommand(metadata.type))
      throw new NotFoundException('Character operation not found');
    if (!auth.permissions.includes(CHARACTER_POLICY[metadata.type].permission))
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
    if (!command) throw new NotFoundException('Character operation not found');
    return operationDetail(command);
  }
}
