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
  ],
})
export class AppModule {}
