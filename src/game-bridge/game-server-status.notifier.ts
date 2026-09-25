import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { ApplicationConfig } from '../config/environment.js';
import { isRuntimeReady } from '../game-agent/agent-protocol.contracts.js';
import { RealtimeEventBus } from '../realtime-events/realtime-event-bus.js';
import { Permission } from '../rbac/permissions.js';
import { BridgeClock } from './bridge-clock.js';
import type { GameConnection } from './entities/game-connection.entity.js';

// Same freshness rule as GameConnectionService.healthy and the Admin health.
export const connectionFresh = (
  connection: Pick<GameConnection, 'status' | 'lastHeartbeatAt'> | null,
  now: Date,
  timeoutMs: number,
): boolean =>
  !!connection &&
  connection.status === 'CONNECTED' &&
  connection.lastHeartbeatAt.getTime() + timeoutMs > now.getTime();

interface Row {
  enabled: boolean;
  connection_id: string | null;
  status: 'CONNECTED' | null;
  last_heartbeat_at: Date | null;
  game_process_state: GameConnection['gameProcessState'];
  skse_ready: boolean | null;
}

// STAFF_GAME_SERVER_UPDATED (11.6): a best-effort wake-up for the Admin Web
// when the operational state of a server really changed (Agent connected,
// disconnected, superseded, stale, revoked, runtime or SKSE change). Callers
// signal "may have changed" after their commit; the state is re-read from
// the database (the source of truth, as GET /game-servers/:id) and published
// only when it differs from the last one published by this instance, so an
// unchanged heartbeat never produces an event. Reads are serialized per
// server so that a later state is never overtaken by an earlier one.
@Injectable()
export class GameServerStatusNotifier {
  private readonly logger = new Logger(GameServerStatusNotifier.name);
  private readonly timeoutMs: number;
  private readonly last = new Map<string, string>();
  private readonly chains = new Map<string, Promise<void>>();
  constructor(
    private readonly database: DataSource,
    private readonly clock: BridgeClock,
    private readonly events: RealtimeEventBus,
    config: ConfigService<{ application: ApplicationConfig }, true>,
  ) {
    this.timeoutMs = config.get('application', {
      infer: true,
    }).gameBridge.heartbeatTimeoutMs;
  }
  // Never throws and never blocks the caller's outcome.
  changed(gameServerId: string): Promise<void> {
    const next = (this.chains.get(gameServerId) ?? Promise.resolve()).then(() =>
      this.publish(gameServerId),
    );
    const tail = next.catch(() => {
      this.logger.error(
        `Game server status not published [gameServerId=${gameServerId}]`,
      );
    });
    this.chains.set(gameServerId, tail);
    void tail.then(() => {
      if (this.chains.get(gameServerId) === tail)
        this.chains.delete(gameServerId);
    });
    return tail;
  }
  private async publish(gameServerId: string): Promise<void> {
    const [row] = (await this.database.query(
      `SELECT s.enabled, c.id AS connection_id, c.status, c.last_heartbeat_at,
              c.game_process_state, c.skse_ready
       FROM game_servers s
       LEFT JOIN game_connections c ON c.game_server_id = s.id
         AND c.status = 'CONNECTED' AND c.credential_id IS NOT NULL
       WHERE s.id = $1`,
      [gameServerId],
    )) as Row[];
    if (!row) return;
    const now = this.clock.now();
    const agentConnected =
      row.enabled &&
      connectionFresh(
        row.connection_id
          ? { status: 'CONNECTED', lastHeartbeatAt: row.last_heartbeat_at! }
          : null,
        now,
        this.timeoutMs,
      );
    const data = {
      gameServerId,
      enabled: row.enabled,
      agentConnected,
      gameProcessState: agentConnected ? row.game_process_state : null,
      gameReady:
        agentConnected &&
        isRuntimeReady({
          gameProcessState: row.game_process_state!,
          skseReady: row.skse_ready!,
        }),
    };
    // The session identity is compared (a supersede is a change) but never
    // published: the Admin reads connection details over HTTP.
    const signature = JSON.stringify([
      data,
      agentConnected ? row.connection_id : null,
    ]);
    if (this.last.get(gameServerId) === signature) return;
    this.last.set(gameServerId, signature);
    this.events.publish(
      'STAFF_GAME_SERVER_UPDATED',
      { ...data, updatedAt: now.toISOString() },
      { staffPermission: Permission.GAME_BRIDGE_READ },
    );
  }
}
