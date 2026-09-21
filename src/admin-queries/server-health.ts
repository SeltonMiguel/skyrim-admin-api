import type { GameConnection } from '../game-bridge/entities/game-connection.entity.js';

export enum ServerHealth {
  ONLINE = 'ONLINE',
  STALE = 'STALE',
  OFFLINE = 'OFFLINE',
  DISABLED = 'DISABLED',
}

export function serverHealth(
  enabled: boolean,
  connection: Pick<GameConnection, 'status' | 'lastHeartbeatAt'> | null,
  cutoff: Date,
): ServerHealth {
  if (!enabled) return ServerHealth.DISABLED;
  if (!connection || connection.status !== 'CONNECTED')
    return ServerHealth.OFFLINE;
  return connection.lastHeartbeatAt > cutoff
    ? ServerHealth.ONLINE
    : ServerHealth.STALE;
}

// Both SQL consumers join only the current CONNECTED connection. Same boundary
// as serverHealth and the operational bridge: equality is already STALE.
export const SERVER_HEALTH_SQL = `CASE
  WHEN NOT server.enabled THEN 'DISABLED'
  WHEN connection.id IS NULL THEN 'OFFLINE'
  WHEN connection.lastHeartbeatAt > :cutoff THEN 'ONLINE'
  ELSE 'STALE' END`;
