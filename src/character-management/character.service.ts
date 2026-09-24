import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditResource } from '../audit/audit.types.js';
import type { AuthenticatedStaff } from '../auth/auth.types.js';
import type { SubmitCommand } from '../game-bridge/command-contract.js';
import { AdministrativeCommandService } from '../administrative-operations/administrative-command.service.js';
export { idempotencyKey } from '../administrative-operations/administrative-command.service.js';
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

export type CharacterSubmission = {
  [T in CharacterCommandType]: Omit<
    Extract<SubmitCommand, { type: T }>,
    'requestedByStaffId'
  >;
}[CharacterCommandType];

@Injectable()
export class CharacterService {
  constructor(private readonly commands: AdministrativeCommandService) {}
  async create(input: CharacterSubmission, auth: AuthenticatedStaff) {
    if (!isCharacterCommand(input.type))
      throw new NotFoundException('Character operation not found');
    const type = input.type;
    const { permission, auditAction } = CHARACTER_POLICY[type];
    const command = await this.commands.create(
      input,
      auth,
      permission,
      auditAction
        ? (command) => ({
            action: auditAction,
            resourceType: AuditResource.CHARACTER,
            resourceId: characterPayload(type, command.payload).characterId,
            metadata: characterAuditMetadata(command),
          })
        : undefined,
    );
    return operationReference(command);
  }
  async get(id: string, auth: AuthenticatedStaff) {
    const command = await this.commands.get(
      id,
      auth,
      (type) =>
        isCharacterCommand(type)
          ? CHARACTER_POLICY[type].permission
          : undefined,
      'Character operation not found',
    );
    return operationDetail(command);
  }
}
