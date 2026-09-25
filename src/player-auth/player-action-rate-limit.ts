import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { ApplicationConfig } from '../config/environment.js';
import { RateLimiter } from '../common/rate-limit/rate-limiter.js';
import { TooManyRequestsException } from '../common/rate-limit/too-many-requests.exception.js';
import type { PlayerAuthRequest } from './player-auth.types.js';

export type PlayerAction = keyof ApplicationConfig['security']['playerLimits'];
const PLAYER_ACTION = 'player-action-rate-limit';

// Per authenticated player, per minute (12.1), for Player mutations that
// create rows or GameCommands (character queries, trade/listing creation,
// purchase reservation, listing cancel/release). Keyed by the player, never
// by IP, and applied after PlayerAuthGuard. Per process until 12.5; the
// defaults are a baseline for the 12.6 load tests.
@Injectable()
export class PlayerActionRateLimitGuard implements CanActivate {
  private readonly limits: ApplicationConfig['security']['playerLimits'];
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimiter,
    config: ConfigService<{ application: ApplicationConfig }, true>,
  ) {
    this.limits = config.get('application', {
      infer: true,
    }).security.playerLimits;
  }
  canActivate(context: ExecutionContext): boolean {
    const action = this.reflector.get<PlayerAction>(
      PLAYER_ACTION,
      context.getHandler(),
    );
    const player = context.switchToHttp().getRequest<PlayerAuthRequest>()
      .playerAuth?.player.id;
    if (!action || !player) return true;
    const decision = this.limiter.consume(`player-${action}`, player, {
      limit: this.limits[action],
      windowMs: 60_000,
    });
    if (!decision.allowed)
      throw new TooManyRequestsException(decision.retryAfterSeconds);
    return true;
  }
}
export const PlayerRateLimit = (action: PlayerAction) =>
  applyDecorators(
    SetMetadata(PLAYER_ACTION, action),
    UseGuards(PlayerActionRateLimitGuard),
  );
