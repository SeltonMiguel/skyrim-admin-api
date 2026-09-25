import { PlayerSettingsModule } from '../player-settings/player-settings.module.js';
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { PlayerAuthModule } from '../player-auth/player-auth.module.js';
import {
  CharacterGroupController,
  PlayerGroupController,
  PlayerGroupInviteController,
} from './player-group.controller.js';
import { PlayerGroupService } from './player-group.service.js';

// Publishes through RealtimeEventBus (global); no WebSocket dependency.
@Module({
  imports: [AuditModule, PlayerAuthModule, PlayerSettingsModule],
  providers: [PlayerGroupService],
  controllers: [
    PlayerGroupController,
    PlayerGroupInviteController,
    CharacterGroupController,
  ],
})
export class PlayerGroupsModule {}
