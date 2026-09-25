import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { GameBridgeModule } from '../game-bridge/game-bridge.module.js';
import { WebSocketModule } from '../websocket/websocket.module.js';
import { AgentAuthService } from './agent-auth.service.js';
import { AgentCredentialController } from './agent-credential.controller.js';
import { AgentCredentialService } from './agent-credential.service.js';
import { AgentMessageRouter } from './agent-message.router.js';
import { AgentSessionModule } from './agent-session.module.js';
import { AgentGateway } from './agent.gateway.js';
import { AgentCommandAdapter } from './agent-command.adapter.js';
import { GameCommandWorker } from './game-command.worker.js';
import { AgentServerControlAdapter } from './agent-server-control.adapter.js';
import { ServerControlModule } from '../server-control/server-control.module.js';

// Host Agent transport + authentication (11.1), GameCommand execution
// (11.2) and Server Control results (11.3): credentials managed by Staff,
// the /api/v1/agent WebSocket, the session registry, the message router
// with the GameCommand and Server Control adapters and the GameCommand
// worker. Domain events are not routed yet (11.4).
@Module({
  imports: [
    AuthModule,
    AuditModule,
    GameBridgeModule,
    AgentSessionModule,
    ServerControlModule,
    WebSocketModule,
  ],
  providers: [
    AgentAuthService,
    AgentCredentialService,
    AgentMessageRouter,
    AgentCommandAdapter,
    AgentServerControlAdapter,
    AgentGateway,
    GameCommandWorker,
  ],
  controllers: [AgentCredentialController],
  exports: [AgentSessionModule],
})
export class GameAgentModule {}
