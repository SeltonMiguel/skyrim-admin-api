import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { GameBridgeModule } from '../game-bridge/game-bridge.module.js';
import { ActorCommandService } from './actor-command.service.js';

@Module({
  imports: [AuditModule, GameBridgeModule],
  providers: [ActorCommandService],
  exports: [ActorCommandService],
})
export class ActorOperationsModule {}
