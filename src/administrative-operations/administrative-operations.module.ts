import { Module } from '@nestjs/common';
import { ActorOperationsModule } from '../actor-operations/actor-operations.module.js';
import { AdministrativeCommandService } from './administrative-command.service.js';

@Module({
  imports: [ActorOperationsModule],
  providers: [AdministrativeCommandService],
  exports: [AdministrativeCommandService],
})
export class AdministrativeOperationsModule {}
