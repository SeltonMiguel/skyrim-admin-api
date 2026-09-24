import { PlayerAuthModule } from './player-auth/player-auth.module.js';
import { PlayerAccountsModule } from './player-accounts/player-accounts.module.js';
import { ServerControlModule } from './server-control/server-control.module.js';
import { VipStoreModule } from './vip-store/vip-store.module.js';
import { WorldModule } from './world-management/world.module.js';
import { ModerationModule } from './moderation/moderation.module.js';
import { CharacterManagementModule } from './character-management/character-management.module.js';
import { AdminQueriesModule } from './admin-queries/admin-queries.module.js';
import { GameBridgeModule } from './game-bridge/game-bridge.module.js';
import { AuditHttpModule } from './audit/audit-http.module.js';
import { AuthModule } from './auth/auth.module.js';
import { StaffModule } from './staff/staff.module.js';
import { Module } from '@nestjs/common';
import { CommonModule } from './common/common.module.js';
import { AppConfigModule } from './config/app-config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';

@Module({
  imports: [
    AppConfigModule,
    CommonModule,
    DatabaseModule,
    HealthModule,
    AuthModule,
    StaffModule,
    AuditHttpModule,
    GameBridgeModule,
    AdminQueriesModule,
    CharacterManagementModule,
    ModerationModule,
    WorldModule,
    VipStoreModule,
    ServerControlModule,
    PlayerAccountsModule,
    PlayerAuthModule,
  ],
})
export class AppModule {}
