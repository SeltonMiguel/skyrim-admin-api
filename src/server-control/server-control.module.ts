import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AgentServerControlGateway } from '../game-agent/agent-server-control.gateway.js';
import { AgentSessionModule } from '../game-agent/agent-session.module.js';
import { GameBridgeModule } from '../game-bridge/game-bridge.module.js';
import { ServerControlDispatcher } from './server-control-dispatcher.js';
import { ServerControlGateway } from './server-control-gateway.js';
import { ServerControlReceiver } from './server-control-receiver.js';
import { ServerControlService } from './server-control.service.js';
import { ServerControlWorker } from './server-control.worker.js';
import {
  ServerControlController,
  ServerControlOperationController,
  ServerControlOperationListController,
} from './server-control.controller.js';
// GameBridgeModule supplies only the server registry, connections and clock;
// the gameplay GameCommandBus/GameGateway are deliberately not used here.
// The Host Agent session registry comes from AgentSessionModule (11.3).
@Module({
  imports: [AuthModule, AuditModule, GameBridgeModule, AgentSessionModule],
  providers: [
    ServerControlService,
    ServerControlDispatcher,
    ServerControlReceiver,
    ServerControlWorker,
    // Real Host Agent transport (11.3). DisconnectedServerControlGateway
    // remains available for tests and as an explicit fallback.
    { provide: ServerControlGateway, useClass: AgentServerControlGateway },
  ],
  controllers: [
    ServerControlController,
    ServerControlOperationController,
    ServerControlOperationListController,
  ],
  exports: [ServerControlDispatcher, ServerControlReceiver],
})
export class ServerControlModule {}
