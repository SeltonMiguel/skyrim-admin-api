import { Module } from '@nestjs/common';
import { ActorOperationsModule } from '../actor-operations/actor-operations.module.js';
import { PlayerAuthModule } from '../player-auth/player-auth.module.js';
import { PlayerCharactersModule } from '../player-characters/player-characters.module.js';
import {
  PlayerCharacterOperationController,
  PlayerCharacterQueryController,
} from './player-character-operation.controller.js';
import { PlayerCharacterOperationService } from './player-character-operation.service.js';

// Reuses the actor-aware core, GameCommandBus and dispatcher; no new pipeline.
@Module({
  imports: [ActorOperationsModule, PlayerAuthModule, PlayerCharactersModule],
  providers: [PlayerCharacterOperationService],
  controllers: [
    PlayerCharacterQueryController,
    PlayerCharacterOperationController,
  ],
})
export class PlayerCharacterOperationsModule {}
