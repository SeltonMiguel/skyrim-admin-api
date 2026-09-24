import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AdministrativeOperationsModule } from '../administrative-operations/administrative-operations.module.js';
import { WorldService } from './world.service.js';
import {
  WorldController,
  WorldOperationController,
} from './world.controller.js';
@Module({
  imports: [AuthModule, AdministrativeOperationsModule],
  providers: [WorldService],
  controllers: [WorldController, WorldOperationController],
})
export class WorldModule {}
