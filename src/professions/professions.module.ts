import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { PlayerAuthModule } from '../player-auth/player-auth.module.js';
import { ProfessionController } from './profession.controller.js';
import { ProfessionExperienceService } from './profession-experience.service.js';
import { ProfessionService } from './profession.service.js';

// ProfessionExperienceService.grantFromAgent is exported for the Etapa 11
// Agent transport; players have no XP route and no GameCommand is involved.
@Module({
  imports: [AuditModule, PlayerAuthModule],
  providers: [ProfessionService, ProfessionExperienceService],
  controllers: [ProfessionController],
  exports: [ProfessionExperienceService],
})
export class ProfessionsModule {}
