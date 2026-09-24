import { Module } from '@nestjs/common';
import { PlayerAccountsModule } from '../player-accounts/player-accounts.module.js';
import {
  DiscordIdentityProvider,
  PROVIDER_FETCH,
} from './discord-identity.provider.js';
import {
  PlayerAuthController,
  PlayerMeController,
} from './player-auth.controller.js';
import { PlayerAuthGuard } from './player-auth.guard.js';
import {
  PlayerAuthRateLimiter,
  PlayerAuthRateLimitGuard,
} from './player-auth-rate-limit.js';
import { PlayerAuthService } from './player-auth.service.js';
import { PlayerTokenService } from './player-token.service.js';

// Independent of AuthModule: no staff guard, session, token service or RBAC.
@Module({
  imports: [PlayerAccountsModule],
  providers: [
    PlayerTokenService,
    PlayerAuthService,
    PlayerAuthGuard,
    PlayerAuthRateLimiter,
    PlayerAuthRateLimitGuard,
    DiscordIdentityProvider,
    { provide: PROVIDER_FETCH, useValue: globalThis.fetch.bind(globalThis) },
  ],
  controllers: [PlayerAuthController, PlayerMeController],
  exports: [PlayerAuthService, PlayerAuthGuard],
})
export class PlayerAuthModule {}
