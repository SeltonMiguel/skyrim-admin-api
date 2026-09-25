import { Module } from '@nestjs/common';
import { PlayerAccountService } from './player-account.service.js';

// Persistence only: no controllers, guards, tokens or sessions (see 10.3).
@Module({
  providers: [PlayerAccountService],
  exports: [PlayerAccountService],
})
export class PlayerAccountsModule {}
