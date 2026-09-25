import { Module } from '@nestjs/common';
import { GameBridgeModule } from '../game-bridge/game-bridge.module.js';
import { PlayerAuthModule } from '../player-auth/player-auth.module.js';
import { PlayerGameServerController } from './player-game-server.controller.js';
import { PlayerGameServerService } from './player-game-server.service.js';

@Module({
  imports: [GameBridgeModule, PlayerAuthModule],
  controllers: [PlayerGameServerController],
  providers: [PlayerGameServerService],
})
export class PlayerGameServersModule {}
