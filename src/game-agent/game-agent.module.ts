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
import { PlayerCharactersModule } from '../player-characters/player-characters.module.js';
import { PlayerMarketplaceModule } from '../player-marketplace/player-marketplace.module.js';
import { PlayerTradesModule } from '../player-trades/player-trades.module.js';
import { ProfessionsModule } from '../professions/professions.module.js';
import { AgentDomainEventAdapter } from './agent-domain.adapter.js';
import { AgentDomainEventService } from './agent-domain-events.service.js';
import { AgentWorkNotifier } from './agent-work.notifier.js';
import { AgentWorkService } from './agent-work.service.js';

// Host Agent transport + authentication (11.1), GameCommand execution
// (11.2), Server Control results (11.3) and domain events + gameplay work
// (11.4): credentials managed by Staff, the /api/v1/agent WebSocket, the
// session registry, the message router with its typed adapters, the
// GameCommand worker and the work notifier. Domain modules are reached
// only through their exported Agent entry points and work projections.
@Module({
  imports: [
    AuthModule,
    AuditModule,
    GameBridgeModule,
    AgentSessionModule,
    ServerControlModule,
    PlayerCharactersModule,
    ProfessionsModule,
    PlayerTradesModule,
    PlayerMarketplaceModule,
    WebSocketModule,
  ],
  providers: [
    AgentAuthService,
    AgentCredentialService,
    AgentMessageRouter,
    AgentCommandAdapter,
    AgentServerControlAdapter,
    AgentDomainEventService,
    AgentDomainEventAdapter,
    AgentWorkService,
    AgentWorkNotifier,
    AgentGateway,
    GameCommandWorker,
  ],
  controllers: [AgentCredentialController],
  // AgentWorkNotifier: operator REQUEUE_SAME_WORK (12.4) forgets a push hint.
  exports: [AgentSessionModule, AgentWorkNotifier],
})
export class GameAgentModule {}
