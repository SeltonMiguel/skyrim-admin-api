import { AuditModule } from '../audit/audit.module.js';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { StaffService } from './staff.service.js';
import { StaffController } from './staff.controller.js';
import { BootstrapCoordinatorService } from './bootstrap-coordinator.service.js';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [StaffController],
  providers: [StaffService, BootstrapCoordinatorService],
  exports: [BootstrapCoordinatorService],
})
export class StaffModule {}
