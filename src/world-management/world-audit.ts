import type { AuditMetadata } from '../audit/audit.types.js';
import type { GameCommand } from '../game-bridge/entities/game-command.entity.js';
import { worldPayload } from './world-command.contracts.js';
export function worldAuditMetadata(command: GameCommand): AuditMetadata {
  const common = {
    gameServerId: command.gameServerId,
    commandId: command.id,
    correlationId: command.correlationId,
  };
  switch (command.type) {
    case 'WORLD_TIME_SET':
      return {
        ...common,
        gameHour: worldPayload(command.type, command.payload).gameHour,
      };
    case 'WORLD_WEATHER_SET':
      return {
        ...common,
        weatherId: worldPayload(command.type, command.payload).weatherId,
      };
    case 'WORLD_ENTITY_SPAWN': {
      const p = worldPayload(command.type, command.payload);
      return {
        ...common,
        actorStaffId: p.actorStaffId,
        baseFormId: p.baseFormId,
        quantity: p.quantity,
      };
    }
    default:
      throw new Error('World mutation required');
  }
}
