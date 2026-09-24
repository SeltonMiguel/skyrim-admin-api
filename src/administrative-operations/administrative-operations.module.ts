import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { GameBridgeModule } from '../game-bridge/game-bridge.module.js';
import { AdministrativeCommandService } from './administrative-command.service.js';

@Module({
  imports: [AuditModule, GameBridgeModule],
  providers: [AdministrativeCommandService],
  exports: [AdministrativeCommandService],
})
export class AdministrativeOperationsModule {}
