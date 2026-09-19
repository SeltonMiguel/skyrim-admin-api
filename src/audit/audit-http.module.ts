import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AuditController } from './audit.controller.js';
import { AuditQueryService } from './audit-query.service.js';

@Module({
  imports: [AuthModule],
  controllers: [AuditController],
  providers: [AuditQueryService],
})
export class AuditHttpModule {}
