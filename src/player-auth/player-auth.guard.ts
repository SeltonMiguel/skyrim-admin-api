import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PlayerAuthService } from './player-auth.service.js';
import type { PlayerAuthRequest } from './player-auth.types.js';

// Accepts only player access tokens and re-reads the current player and
// session on every request, so status changes apply to live tokens.
@Injectable()
export class PlayerAuthGuard implements CanActivate {
  constructor(private readonly auth: PlayerAuthService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PlayerAuthRequest>();
    const match = /^Bearer ([^\s]+)$/i.exec(
      request.headers.authorization ?? '',
    );
    if (!match || match[1].length > 4096)
      throw new UnauthorizedException('Bearer token required');
    request.playerAuth = await this.auth.authenticate(match[1]);
    return true;
  }
}
export const CurrentPlayer = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const auth = context
      .switchToHttp()
      .getRequest<PlayerAuthRequest>().playerAuth;
    if (!auth) throw new UnauthorizedException();
    return auth;
  },
);
