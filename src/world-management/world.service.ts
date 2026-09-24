import { Injectable, NotFoundException } from '@nestjs/common';
import type { AuthenticatedStaff } from '../auth/auth.types.js';
import { AdministrativeCommandService } from '../administrative-operations/administrative-command.service.js';
import { AuditResource } from '../audit/audit.types.js';
import type { SubmitCommand } from '../game-bridge/command-contract.js';
import { commandJson } from '../game-bridge/command-json.js';
import { MAX_COMMAND_PAYLOAD_BYTES } from '../game-bridge/command-limits.js';
import { fields } from '../game-bridge/command-validation.js';
import { WORLD_POLICY } from './world-policy.js';
import { isWorldCommand, worldPayload } from './world-command.contracts.js';
import type {
  WorldCommandType,
  WorldPayload,
} from './world-command.contracts.js';
import { worldAuditMetadata } from './world-audit.js';
import { worldDetail, worldReference } from './world-operation.presenter.js';
export type WorldSubmission = {
  [T in WorldCommandType]: {
    type: T;
    gameServerId: string;
    idempotencyKey: string;
    payload: Omit<WorldPayload<T>, 'actorStaffId'>;
  };
}[WorldCommandType];
@Injectable()
export class WorldService {
  constructor(private readonly commands: AdministrativeCommandService) {}
  async create(input: WorldSubmission, auth: AuthenticatedStaff) {
    if (!isWorldCommand(input.type))
      throw new NotFoundException('World operation not found');
    const { permission, auditAction } = WORLD_POLICY[input.type];
    let payload: unknown = input.payload;
    if (input.type === 'WORLD_ENTITY_SPAWN') {
      const client = fields(commandJson(payload, MAX_COMMAND_PAYLOAD_BYTES), [
        'baseFormId',
        'quantity',
      ]);
      payload = { ...client, actorStaffId: auth.user.id };
    }
    const submission = {
      gameServerId: input.gameServerId,
      type: input.type,
      payload: worldPayload(input.type, payload),
      idempotencyKey: input.idempotencyKey,
    } as SubmitCommand;
    const command = await this.commands.create(
      submission,
      auth,
      permission,
      auditAction
        ? (command) => ({
            action: auditAction,
            resourceType: AuditResource.WORLD,
            resourceId: command.id,
            metadata: worldAuditMetadata(command),
          })
        : undefined,
    );
    return worldReference(command);
  }
  async get(id: string, auth: AuthenticatedStaff) {
    return worldDetail(
      await this.commands.get(
        id,
        auth,
        (type) =>
          isWorldCommand(type) ? WORLD_POLICY[type].permission : undefined,
        'World operation not found',
      ),
    );
  }
}
