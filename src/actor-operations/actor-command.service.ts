import { ConflictException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import { AuditOutcome } from '../audit/audit.types.js';
import type { AuditEvent } from '../audit/audit.types.js';
import { actor as validActor } from '../actors/actor.contracts.js';
import type { Actor } from '../actors/actor.contracts.js';
import { GameCommandBus } from '../game-bridge/game-command-bus.js';
import { GameServerService } from '../game-bridge/game-server.service.js';
import { commandPayload, identifier } from '../game-bridge/command-contract.js';
import type { SubmitCommand } from '../game-bridge/command-contract.js';
import type { GameCommand } from '../game-bridge/entities/game-command.entity.js';

export function idempotencyKey(value: unknown): string {
  if (typeof value !== 'string') identifier('', 'Idempotency-Key');
  const key = value as string;
  identifier(key, 'Idempotency-Key');
  return key;
}
export type CommandAudit = (
  command: GameCommand,
) => Omit<AuditEvent, 'actor' | 'statusCode'>;
export type ActorSubmission = Omit<
  SubmitCommand,
  'actor' | 'requestedByStaffId'
>;

// Actor-aware core shared by staff and (future) player/system flows: one short
// transaction for server lock, scoped idempotent insert and atomic Audit.
// Authorization (RBAC or ownership) is the caller's responsibility; this core
// grants nothing. Transport stays in the dispatcher, after commit.
@Injectable()
export class ActorCommandService {
  constructor(
    private readonly database: DataSource,
    private readonly bus: GameCommandBus,
    private readonly servers: GameServerService,
    private readonly audit: AuditService,
  ) {}
  async create(
    input: ActorSubmission,
    origin: Actor,
    event?: CommandAudit,
  ): Promise<{ command: GameCommand; created: boolean }> {
    // Snapshot before the first await; never retain caller-owned objects.
    const actor = validActor(origin);
    const submission = {
      gameServerId: input.gameServerId,
      type: input.type,
      payload: commandPayload(input.type, input.payload),
      idempotencyKey: idempotencyKey(input.idempotencyKey),
      actor,
    } as SubmitCommand;
    return this.database.transaction(async (manager) => {
      const server = await this.servers.get(
        submission.gameServerId,
        manager,
        true,
      );
      // Domain HTTP replays, like new operations, require an enabled server.
      if (!server.enabled) throw new ConflictException('Game server disabled');
      const result = await this.bus.submitInTransaction(submission, manager);
      if (result.created && event)
        await this.audit.record(
          {
            ...event(result.command),
            actor,
            outcome: AuditOutcome.SUCCESS,
            statusCode: 202,
          },
          manager,
        );
      return result;
    });
  }
}
