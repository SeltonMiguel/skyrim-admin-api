import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ApplicationConfig } from '../config/environment.js';
import { GameCommandDispatcher } from '../game-bridge/game-command-dispatcher.js';
import { GameCommandReceiver } from '../game-bridge/game-command-receiver.js';
import { supportedCommandTypes } from './agent-capabilities.js';
import { isRuntimeReady } from './agent-protocol.contracts.js';
import { AgentSessionRegistry } from './agent-session.registry.js';

const MAX_LOGGED = 1000;

// Production caller of the Game Bridge lifecycle (11.2). One periodic tick,
// never overlapping, no timer per command:
// 1. expire commands past their deadlines, and PENDING commands that never
//    became deliverable (FAILED/DISPATCH_EXPIRED);
// 2. for each ACTIVE Host Agent session whose runtime is ready (process
//    RUNNING and SKSE ready), dispatch due retries and new PENDING commands
//    of the types it supports, within the per-server in-flight budget.
// Eligibility is checked before any reservation, so an offline, not-ready
// or incompatible Agent never consumes attempts. The check can race with
// the Agent going away; the reserved attempt then fails as usual.
@Injectable()
export class GameCommandWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(GameCommandWorker.name);
  private readonly intervalMs: number;
  private readonly maxInFlight: number;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private stopped = false;
  // Log each blocked command and each not-ready state once.
  private readonly blocked = new Set<string>();
  private readonly notReady = new Map<string, string>();
  constructor(
    private readonly sessions: AgentSessionRegistry,
    private readonly dispatcher: GameCommandDispatcher,
    private readonly receiver: GameCommandReceiver,
    config: ConfigService<{ application: ApplicationConfig }, true>,
  ) {
    const application = config.get('application', { infer: true });
    this.intervalMs = application.gameBridge.workerIntervalMs;
    this.maxInFlight = application.agent.maxInFlightCommands;
  }
  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }
  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }
  // Returns how many commands were handed to the dispatcher.
  async tick(): Promise<number> {
    if (this.running || this.stopped) return 0;
    this.running = true;
    try {
      await this.receiver.expireCommands();
      const expired = await this.receiver.expirePending();
      if (expired)
        this.logger.warn(
          `Game commands expired without an eligible Agent [count=${expired}]`,
        );
      let handled = 0;
      for (const session of this.sessions.activeSessions())
        handled += await this.serve(session.gameServerId);
      return handled;
    } catch {
      this.logger.error('Game command worker tick failed');
      return 0;
    } finally {
      this.running = false;
    }
  }
  private async serve(gameServerId: string): Promise<number> {
    const session = this.sessions.getSession(gameServerId);
    if (!session) return 0;
    const state = `${session.runtime.gameProcessState}:${session.runtime.skseReady}`;
    if (!isRuntimeReady(session.runtime)) {
      if (this.notReady.get(gameServerId) !== state)
        this.logger.log(
          `Game commands held: runtime not ready [gameServerId=${gameServerId} connectionId=${session.connectionId} gameProcessState=${session.runtime.gameProcessState} skseReady=${session.runtime.skseReady}]`,
        );
      this.notReady.set(gameServerId, state);
      return 0;
    }
    this.notReady.delete(gameServerId);
    const types = supportedCommandTypes(session.capabilities);
    await this.logBlocked(gameServerId, types);
    const budget =
      this.maxInFlight - (await this.dispatcher.inFlight(gameServerId));
    const handled = await this.dispatcher.dispatchEligible(
      gameServerId,
      types,
      budget,
    );
    return handled.length;
  }
  private async logBlocked(
    gameServerId: string,
    types: ReturnType<typeof supportedCommandTypes>,
  ): Promise<void> {
    for (const command of await this.dispatcher.blockedPending(
      gameServerId,
      types,
    )) {
      if (this.blocked.has(command.id)) continue;
      if (this.blocked.size >= MAX_LOGGED) this.blocked.clear();
      this.blocked.add(command.id);
      this.logger.warn(
        `Game command held: Agent capability missing [commandId=${command.id} gameServerId=${gameServerId} commandType=${command.type}]`,
      );
    }
  }
}
