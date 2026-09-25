import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { PlayerAuthModule } from '../player-auth/player-auth.module.js';
import { PlayerSettingsController } from './player-settings.controller.js';
import { PlayerSettingsService } from './player-settings.service.js';

// Account-scoped preferences. Exports the service so Chat, Trade, Groups
// and Guilds can honour the interaction flags; depends on none of them.
@Module({
  imports: [AuditModule, PlayerAuthModule],
  providers: [PlayerSettingsService],
  controllers: [PlayerSettingsController],
  exports: [PlayerSettingsService],
})
export class PlayerSettingsModule {}
