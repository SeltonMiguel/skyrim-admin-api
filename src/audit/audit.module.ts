import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module.js';
import { AuditService } from './audit.service.js';

// Persistence has no dependency on Auth; Auth can audit its own transactions.
@Module({
  imports: [CommonModule],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
