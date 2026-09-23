import type { AuditMetadata } from '../audit/audit.types.js';
import type { GameCommand } from '../game-bridge/entities/game-command.entity.js';
import {
  characterPayload,
  isCharacterCommand,
} from './character-command.contracts.js';

export function characterAuditMetadata(command: GameCommand): AuditMetadata {
  if (!isCharacterCommand(command.type))
    throw new Error('Character command required');
  const payload = characterPayload(command.type, command.payload);
  const targetId =
    'itemId' in payload
      ? payload.itemId
      : 'propertyId' in payload
        ? payload.propertyId
        : 'holdId' in payload
          ? payload.holdId
          : 'horseId' in payload
            ? payload.horseId
            : 'titleId' in payload
              ? payload.titleId
              : 'spellId' in payload
                ? payload.spellId
                : 'factionId' in payload
                  ? payload.factionId
                  : undefined;
  return {
    gameServerId: command.gameServerId,
    commandId: command.id,
    correlationId: command.correlationId,
    characterId: payload.characterId,
    operation: command.type,
    ...(targetId === undefined ? {} : { targetId }),
    ...('quantity' in payload ? { quantity: payload.quantity } : {}),
  };
}
