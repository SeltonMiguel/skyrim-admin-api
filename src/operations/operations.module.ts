import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { EconomyModule } from '../economy/economy.module.js';
import { GameAgentModule } from '../game-agent/game-agent.module.js';
import { OperationsController } from './operations.controller.js';
import { OperationsQueryService } from './operations-query.service.js';
import { OperatorActionService } from './operator-action.service.js';
import { PlayerModerationService } from './player-moderation.service.js';
import { RecoveryService } from './recovery.service.js';

// Operational recovery (12.4): Staff queues and narrow, audited operator
// actions over the existing domains, so that no incident needs manual SQL.
@Module({
  imports: [AuthModule, AuditModule, EconomyModule, GameAgentModule],
  providers: [
    OperatorActionService,
    OperationsQueryService,
    RecoveryService,
    PlayerModerationService,
  ],
  controllers: [OperationsController],
})
export class OperationsModule {}
