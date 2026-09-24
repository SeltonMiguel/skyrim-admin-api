import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { VipAdminService } from './vip-admin.service.js';
import { VipCatalogService } from './vip-catalog.service.js';
import {
  VipAdminController,
  VipCatalogController,
} from './vip-store.controller.js';
@Module({
  imports: [AuthModule, AuditModule],
  providers: [VipAdminService, VipCatalogService],
  controllers: [VipAdminController, VipCatalogController],
})
export class VipStoreModule {}
