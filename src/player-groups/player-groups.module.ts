import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { PlayerAuthModule } from '../player-auth/player-auth.module.js';
import {
  PlayerGroupController,
  PlayerGroupInviteController,
} from './player-group.controller.js';
import { PlayerGroupService } from './player-group.service.js';

// Publishes through RealtimeEventBus (global); no WebSocket dependency.
@Module({
  imports: [AuditModule, PlayerAuthModule],
  providers: [PlayerGroupService],
  controllers: [PlayerGroupController, PlayerGroupInviteController],
})
export class PlayerGroupsModule {}
