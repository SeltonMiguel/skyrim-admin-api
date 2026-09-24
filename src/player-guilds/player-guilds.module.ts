import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { PlayerAuthModule } from '../player-auth/player-auth.module.js';
import {
  CharacterGuildController,
  PlayerGuildController,
  PlayerGuildInviteController,
} from './player-guild.controller.js';
import { PlayerGuildService } from './player-guild.service.js';

// Backend-owned: no game command, Agent event or Skyrim faction. Publishes
// through RealtimeEventBus (global); no WebSocket dependency.
@Module({
  imports: [AuditModule, PlayerAuthModule],
  providers: [PlayerGuildService],
  controllers: [
    PlayerGuildController,
    PlayerGuildInviteController,
    CharacterGuildController,
  ],
})
export class PlayerGuildsModule {}
