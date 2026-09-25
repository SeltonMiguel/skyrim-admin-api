import { AuditModule } from '../audit/audit.module.js';
import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';
import { StaffAuthThrottle } from './staff-auth-throttle.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { PermissionGuard } from '../rbac/permission.guard.js';

@Module({
  imports: [AuditModule],
  controllers: [AuthController],
  providers: [
    StaffAuthThrottle,
    AuthService,
    PasswordService,
    TokenService,
    JwtAuthGuard,
    PermissionGuard,
  ],
  exports: [PasswordService, JwtAuthGuard, PermissionGuard, AuthService],
})
export class AuthModule {}
