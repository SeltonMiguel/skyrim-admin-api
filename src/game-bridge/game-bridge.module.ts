import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module.js';
import { BridgeClock } from './bridge-clock.js';
import { GameCommandBus } from './game-command-bus.js';
import { GameCommandDispatcher } from './game-command-dispatcher.js';
import { GameCommandReceiver } from './game-command-receiver.js';
import { GameCommandStore } from './game-command-store.js';
import { GameConnectionService } from './game-connection.service.js';
import { DisconnectedGameGateway, GameGateway } from './game-gateway.js';
import { GameServerService } from './game-server.service.js';

@Module({
  imports: [CommonModule],
  providers: [
    BridgeClock,
    GameServerService,
    GameConnectionService,
    GameCommandBus,
    GameCommandStore,
    GameCommandDispatcher,
    GameCommandReceiver,
    { provide: GameGateway, useClass: DisconnectedGameGateway },
  ],
  exports: [
    BridgeClock,
    GameServerService,
    GameConnectionService,
    GameCommandBus,
    GameCommandDispatcher,
    GameCommandReceiver,
  ],
})
export class GameBridgeModule {}
