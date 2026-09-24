import { NotFoundException } from '@nestjs/common';
import type { GameCommand } from '../game-bridge/entities/game-command.entity.js';
import type { OperationCommand } from '../administrative-operations/administrative-command.service.js';
import { commandDetail } from '../admin-queries/query.presenters.js';
import {
  isWorldCommand,
  worldPayload,
  worldResult,
} from './world-command.contracts.js';
import type {
  WorldOperationReferenceDto,
  WorldOperationDetailDto,
} from './dto/operation.dto.js';
export function worldReference(
  command: GameCommand,
): WorldOperationReferenceDto {
  if (!isWorldCommand(command.type))
    throw new NotFoundException('World operation not found');
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
export function worldDetail(
  command: OperationCommand,
): WorldOperationDetailDto {
  if (!isWorldCommand(command.type))
    throw new NotFoundException('World operation not found');
  const operational = commandDetail(command);
  return {
    ...worldReference(command),
    requestedByStaffId: operational.requestedByStaffId,
    dispatchAttempts: operational.dispatchAttempts,
    lastDispatchAt: operational.lastDispatchAt,
    acknowledgedAt: operational.acknowledgedAt,
    completedAt: operational.completedAt,
    ackDeadlineAt: operational.ackDeadlineAt,
    executionDeadlineAt: operational.executionDeadlineAt,
    payload: worldPayload(command.type, command.payload),
    result: command.result
      ? {
          outcome: command.result.outcome,
          result:
            command.result.result === null
              ? null
              : worldResult(
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
