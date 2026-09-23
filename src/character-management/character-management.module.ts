import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { GameBridgeModule } from '../game-bridge/game-bridge.module.js';
import {
  CharacterController,
  CharacterOperationController,
} from './character.controller.js';
import { CharacterService } from './character.service.js';

@Module({
  imports: [AuthModule, AuditModule, GameBridgeModule],
  providers: [CharacterService],
  controllers: [CharacterController, CharacterOperationController],
})
export class CharacterManagementModule {}
