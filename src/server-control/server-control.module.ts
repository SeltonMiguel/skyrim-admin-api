import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { GameBridgeModule } from '../game-bridge/game-bridge.module.js';
import { ServerControlDispatcher } from './server-control-dispatcher.js';
import {
  DisconnectedServerControlGateway,
  ServerControlGateway,
} from './server-control-gateway.js';
import { ServerControlService } from './server-control.service.js';
import {
  ServerControlController,
  ServerControlOperationController,
} from './server-control.controller.js';

// GameBridgeModule supplies only the server registry and clock; the gameplay
// GameCommandBus/GameGateway are deliberately not used here.
@Module({
  imports: [AuthModule, AuditModule, GameBridgeModule],
  providers: [
    ServerControlService,
    ServerControlDispatcher,
    {
      provide: ServerControlGateway,
      useClass: DisconnectedServerControlGateway,
    },
  ],
  controllers: [ServerControlController, ServerControlOperationController],
  exports: [ServerControlDispatcher],
})
export class ServerControlModule {}
