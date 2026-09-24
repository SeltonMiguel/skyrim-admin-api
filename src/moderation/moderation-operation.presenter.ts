import { NotFoundException } from '@nestjs/common';
import type { GameCommand } from '../game-bridge/entities/game-command.entity.js';
import type { OperationCommand } from '../administrative-operations/administrative-command.service.js';
import { commandDetail } from '../admin-queries/query.presenters.js';
import {
  isModerationCommand,
  moderationPayload,
  moderationResult,
} from './moderation-command.contracts.js';
import type {
  ModerationOperationReferenceDto,
  ModerationOperationDetailDto,
} from './dto/operation.dto.js';
export function moderationReference(
  command: GameCommand,
): ModerationOperationReferenceDto {
  if (!isModerationCommand(command.type))
    throw new NotFoundException('Moderation operation not found');
  return {
    commandId: command.id,
    gameServerId: command.gameServerId,
    type: command.type,
    status: command.status,
    correlationId: command.correlationId,
    requestId: command.requestId,
    createdAt: command.createdAt,
  };
}
export function moderationDetail(
  command: OperationCommand,
): ModerationOperationDetailDto {
  if (!isModerationCommand(command.type))
    throw new NotFoundException('Moderation operation not found');
  const operational = commandDetail(command);
  return {
    ...moderationReference(command),
    requestedByStaffId: operational.requestedByStaffId,
    dispatchAttempts: operational.dispatchAttempts,
    lastDispatchAt: operational.lastDispatchAt,
    acknowledgedAt: operational.acknowledgedAt,
    completedAt: operational.completedAt,
    ackDeadlineAt: operational.ackDeadlineAt,
    executionDeadlineAt: operational.executionDeadlineAt,
    payload: moderationPayload(command.type, command.payload),
    result: command.result
      ? {
          outcome: command.result.outcome,
          result:
            command.result.result === null
              ? null
              : moderationResult(
                  command.type,
                  command.result.result,
                  command.payload,
                ),
          errorCode: command.result.errorCode,
          errorMessage: command.result.errorMessage,
          receivedAt: command.result.receivedAt,
        }
      : null,
  };
}
