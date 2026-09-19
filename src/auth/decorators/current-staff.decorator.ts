import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthRequest } from '../auth.types.js';

export const CurrentStaff = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const auth = context.switchToHttp().getRequest<AuthRequest>().auth;
    if (!auth) throw new UnauthorizedException();
    return auth;
  },
);
