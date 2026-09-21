import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { GameBridgeModule } from '../game-bridge/game-bridge.module.js';
import { DashboardQueryService } from './dashboard-query.service.js';
import { GameServerQueryService } from './game-server-query.service.js';
import { GameCommandQueryService } from './game-command-query.service.js';
import {
  DashboardController,
  GameServerQueryController,
  GameCommandQueryController,
} from './query.controllers.js';

@Module({
  imports: [AuthModule, GameBridgeModule],
  controllers: [
    DashboardController,
    GameServerQueryController,
    GameCommandQueryController,
  ],
  providers: [
    DashboardQueryService,
    GameServerQueryService,
    GameCommandQueryService,
  ],
})
export class AdminQueriesModule {}
