import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { PlayerAuthModule } from '../player-auth/player-auth.module.js';
import { CharacterLinkController } from './character-link.controller.js';
import { CharacterLinkService } from './character-link.service.js';
import { CharacterOwnershipService } from './character-ownership.service.js';
import { PlayerCharacterController } from './player-character.controller.js';
import { PlayerCharacterDirectoryService } from './player-character-directory.service.js';

// CharacterLinkService.confirmFromAgent is exported for the Etapa 11 Agent
// transport; there is no Agent endpoint and no GameCommand in this module.
@Module({
  imports: [AuditModule, PlayerAuthModule],
  providers: [
    CharacterLinkService,
    CharacterOwnershipService,
    PlayerCharacterDirectoryService,
  ],
  controllers: [CharacterLinkController, PlayerCharacterController],
  exports: [CharacterLinkService, CharacterOwnershipService],
})
export class PlayerCharactersModule {}
