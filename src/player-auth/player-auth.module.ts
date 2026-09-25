import { Module } from '@nestjs/common';
import { PlayerAccountsModule } from '../player-accounts/player-accounts.module.js';
import { AuditModule } from '../audit/audit.module.js';
import {
  DiscordIdentityProvider,
  PROVIDER_FETCH,
} from './discord-identity.provider.js';
import {
  PlayerAuthController,
  PlayerMeController,
} from './player-auth.controller.js';
import { PlayerAuthGuard } from './player-auth.guard.js';
import { PlayerActionRateLimitGuard } from './player-action-rate-limit.js';
import {
  PlayerAuthRateLimiter,
  PlayerAuthRateLimitGuard,
} from './player-auth-rate-limit.js';
import { PlayerAuthService } from './player-auth.service.js';
import { PlayerTokenService } from './player-token.service.js';

// Independent of AuthModule: no staff guard, session, token service or RBAC.
@Module({
  imports: [PlayerAccountsModule, AuditModule],
  providers: [
    PlayerTokenService,
    PlayerAuthService,
    PlayerAuthGuard,
    PlayerAuthRateLimiter,
    PlayerAuthRateLimitGuard,
    PlayerActionRateLimitGuard,
    DiscordIdentityProvider,
    { provide: PROVIDER_FETCH, useValue: globalThis.fetch.bind(globalThis) },
  ],
  controllers: [PlayerAuthController, PlayerMeController],
  exports: [
    PlayerAuthService,
    PlayerAuthGuard,
    PlayerAuthRateLimiter,
    PlayerAuthRateLimitGuard,
    PlayerActionRateLimitGuard,
  ],
})
export class PlayerAuthModule {}
