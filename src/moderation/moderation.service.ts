import { Injectable, NotFoundException } from '@nestjs/common';
import type { AuthenticatedStaff } from '../auth/auth.types.js';
import { AdministrativeCommandService } from '../administrative-operations/administrative-command.service.js';
import { AuditResource } from '../audit/audit.types.js';
import type { SubmitCommand } from '../game-bridge/command-contract.js';
import { commandJson } from '../game-bridge/command-json.js';
import { MAX_COMMAND_PAYLOAD_BYTES } from '../game-bridge/command-limits.js';
import { fields } from '../game-bridge/command-validation.js';
import { MODERATION_POLICY } from './moderation-policy.js';
import {
  isModerationCommand,
  moderationPayload,
} from './moderation-command.contracts.js';
import type {
  ModerationCommandType,
  ModerationPayload,
} from './moderation-command.contracts.js';
import { moderationAuditMetadata } from './moderation-audit.js';
import {
  moderationDetail,
  moderationReference,
} from './moderation-operation.presenter.js';

// actorStaffId is absent even from the domain submission API, not only the HTTP DTO.
export type ModerationSubmission = {
  [T in ModerationCommandType]: {
    type: T;
    gameServerId: string;
    idempotencyKey: string;
    payload: Omit<ModerationPayload<T>, 'actorStaffId'>;
  };
}[ModerationCommandType];
@Injectable()
export class ModerationService {
  constructor(private readonly commands: AdministrativeCommandService) {}
  async create(input: ModerationSubmission, auth: AuthenticatedStaff) {
    if (!isModerationCommand(input.type))
      throw new NotFoundException('Moderation operation not found');
    const policy = MODERATION_POLICY[input.type];
    let payload: unknown = input.payload;
    // Closed input validation rejects forged staff IDs before adding authenticated identity.
    if (
      input.type === 'STAFF_NOCLIP_SET' ||
      input.type === 'STAFF_INVISIBILITY_SET' ||
      input.type === 'STAFF_TELEPORT_TO_PLAYER' ||
      input.type === 'PLAYER_TELEPORT_TO_STAFF'
    ) {
      const required =
        input.type === 'STAFF_NOCLIP_SET' ||
        input.type === 'STAFF_INVISIBILITY_SET'
          ? ['enabled']
          : ['targetPlayerId'];
      const client = fields(
        commandJson(payload, MAX_COMMAND_PAYLOAD_BYTES),
        required,
      );
      payload = { ...client, actorStaffId: auth.user.id };
    }
    const submission = {
      gameServerId: input.gameServerId,
      type: input.type,
      payload: moderationPayload(input.type, payload),
      idempotencyKey: input.idempotencyKey,
    } as SubmitCommand;
    const command = await this.commands.create(
      submission,
      auth,
      policy.permission,
      (command) => ({
        action: policy.auditAction,
        resourceType: AuditResource.MODERATION,
        resourceId: command.id,
        metadata: moderationAuditMetadata(command),
      }),
    );
    return moderationReference(command);
  }
  async get(id: string, auth: AuthenticatedStaff) {
    return moderationDetail(
      await this.commands.get(
        id,
        auth,
        (type) =>
          isModerationCommand(type)
            ? MODERATION_POLICY[type].permission
            : undefined,
        'Moderation operation not found',
      ),
    );
  }
}
