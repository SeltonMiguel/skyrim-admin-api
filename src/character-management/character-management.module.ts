import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AdministrativeOperationsModule } from '../administrative-operations/administrative-operations.module.js';
import {
  CharacterController,
  CharacterOperationController,
} from './character.controller.js';
import { CharacterService } from './character.service.js';

@Module({
  imports: [AuthModule, AdministrativeOperationsModule],
  providers: [CharacterService],
  controllers: [CharacterController, CharacterOperationController],
})
export class CharacterManagementModule {}
