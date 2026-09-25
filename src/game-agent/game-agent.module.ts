import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { GameBridgeModule } from '../game-bridge/game-bridge.module.js';
import { WebSocketModule } from '../websocket/websocket.module.js';
import { AgentAuthService } from './agent-auth.service.js';
import { AgentCredentialController } from './agent-credential.controller.js';
import { AgentCredentialService } from './agent-credential.service.js';
import { AgentMessageRouter } from './agent-message.router.js';
import { AgentSessionRegistry } from './agent-session.registry.js';
import { AgentGateway } from './agent.gateway.js';

// Host Agent transport + authentication (11.1): credentials managed by
// Staff, the /api/v1/agent WebSocket, the session registry and the message
// router skeleton. Nothing here dispatches GameCommands, receives results,
// talks to Server Control or routes domain events (11.2+). The registry is
// exported for those substeps.
@Module({
  imports: [AuthModule, AuditModule, GameBridgeModule, WebSocketModule],
  providers: [
    AgentSessionRegistry,
    AgentAuthService,
    AgentCredentialService,
    AgentMessageRouter,
    AgentGateway,
  ],
  controllers: [AgentCredentialController],
  exports: [AgentSessionRegistry],
})
export class GameAgentModule {}
