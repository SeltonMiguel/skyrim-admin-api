import { RealtimeEventsModule } from '../realtime-events/realtime-events.module.js';
import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module.js';
import { BridgeClock } from './bridge-clock.js';
import { GameCommandBus } from './game-command-bus.js';
import { GameCommandDispatcher } from './game-command-dispatcher.js';
import { GameCommandReceiver } from './game-command-receiver.js';
import { GameCommandStore } from './game-command-store.js';
import { GameConnectionService } from './game-connection.service.js';
import { GameGateway } from './game-gateway.js';
import { AgentGameGateway } from '../game-agent/agent-game.gateway.js';
import { AgentSessionModule } from '../game-agent/agent-session.module.js';
import { GameServerService } from './game-server.service.js';
import { GameServerStatusNotifier } from './game-server-status.notifier.js';

@Module({
  imports: [RealtimeEventsModule, CommonModule, AgentSessionModule],
  providers: [
    BridgeClock,
    GameServerService,
    GameServerStatusNotifier,
    GameConnectionService,
    GameCommandBus,
    GameCommandStore,
    GameCommandDispatcher,
    GameCommandReceiver,
    // Real Host Agent transport (11.2). DisconnectedGameGateway remains
    // available for tests and as an explicit fallback.
    { provide: GameGateway, useClass: AgentGameGateway },
  ],
  exports: [
    BridgeClock,
    GameServerService,
    GameServerStatusNotifier,
    GameConnectionService,
    GameCommandBus,
    GameCommandDispatcher,
    GameCommandReceiver,
  ],
})
export class GameBridgeModule {}
