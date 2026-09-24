import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AdministrativeOperationsModule } from '../administrative-operations/administrative-operations.module.js';
import { ModerationService } from './moderation.service.js';
import {
  ModerationController,
  ModerationOperationController,
} from './moderation.controller.js';
@Module({
  imports: [AuthModule, AdministrativeOperationsModule],
  providers: [ModerationService],
  controllers: [ModerationController, ModerationOperationController],
})
export class ModerationModule {}
