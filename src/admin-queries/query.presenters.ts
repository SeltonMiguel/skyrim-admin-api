import type { GameServer } from '../game-bridge/entities/game-server.entity.js';
import type { GameConnection } from '../game-bridge/entities/game-connection.entity.js';
import type { GameCommand } from '../game-bridge/entities/game-command.entity.js';
import type { GameCommandResult } from '../game-bridge/entities/game-command-result.entity.js';
import { serverHealth } from './server-health.js';
import type {
  CurrentConnectionDto,
  ConnectionDto,
  GameServerDto,
  CommandListDto,
  CommandDetailDto,
} from './dto/response.dto.js';

export function currentConnection(
  connection: GameConnection,
): CurrentConnectionDto {
  return {
    id: connection.id,
    externalConnectionId: connection.externalConnectionId,
    status: connection.status,
    bridgeVersion: connection.bridgeVersion,
    protocolVersion: connection.protocolVersion,
    connectedAt: connection.connectedAt,
    lastHeartbeatAt: connection.lastHeartbeatAt,
  };
}
export function connectionHistory(connection: GameConnection): ConnectionDto {
  return {
    ...currentConnection(connection),
    gameServerId: connection.gameServerId,
    disconnectedAt: connection.disconnectedAt,
    disconnectReason: connection.disconnectReason,
    createdAt: connection.createdAt,
  };
}
export type ServerWithConnection = GameServer & {
  currentConnection: GameConnection | null;
};
export function publicServer(
  server: ServerWithConnection,
  cutoff: Date,
): GameServerDto {
  return {
    id: server.id,
    code: server.code,
    name: server.name,
    enabled: server.enabled,
    health: serverHealth(server.enabled, server.currentConnection, cutoff),
    currentConnection: server.currentConnection
      ? currentConnection(server.currentConnection)
      : null,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
  };
}
export function commandSummary(command: GameCommand): CommandListDto {
  return {
    id: command.id,
    gameServerId: command.gameServerId,
    type: command.type,
    status: command.status,
    correlationId: command.correlationId,
    requestId: command.requestId,
    requestedByStaffId: command.requestedByStaffId,
    dispatchAttempts: command.dispatchAttempts,
    lastDispatchAt: command.lastDispatchAt,
    acknowledgedAt: command.acknowledgedAt,
    completedAt: command.completedAt,
    createdAt: command.createdAt,
  };
}
export type CommandWithResult = GameCommand & {
  result: GameCommandResult | null;
};
export function commandDetail(command: CommandWithResult): CommandDetailDto {
  const result = command.result;
  return {
    ...commandSummary(command),
    ackDeadlineAt: command.ackDeadlineAt,
    executionDeadlineAt: command.executionDeadlineAt,
    result: result
      ? {
          outcome: result.outcome,
          errorCode: result.errorCode,
          receivedAt: result.receivedAt,
        }
      : null,
  };
}
