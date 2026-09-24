import type { AuditMetadata } from '../audit/audit.types.js';
import type { GameCommand } from '../game-bridge/entities/game-command.entity.js';
import {
  isModerationCommand,
  moderationPayload,
} from './moderation-command.contracts.js';
export function moderationAuditMetadata(command: GameCommand): AuditMetadata {
  if (!isModerationCommand(command.type))
    throw new Error('Moderation command required');
  const payload = moderationPayload(command.type, command.payload);
  return {
    gameServerId: command.gameServerId,
    commandId: command.id,
    correlationId: command.correlationId,
    ...('playerId' in payload ? { playerId: payload.playerId } : {}),
    ...('actorStaffId' in payload
      ? { actorStaffId: payload.actorStaffId }
      : {}),
    ...('targetPlayerId' in payload
      ? { targetPlayerId: payload.targetPlayerId }
      : {}),
    ...('enabled' in payload ? { enabled: payload.enabled } : {}),
  };
}
