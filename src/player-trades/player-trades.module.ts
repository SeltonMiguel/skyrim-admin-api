import { PlayerSettingsModule } from '../player-settings/player-settings.module.js';
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { EconomyModule } from '../economy/economy.module.js';
import { PlayerAuthModule } from '../player-auth/player-auth.module.js';
import {
  CharacterTradeController,
  PlayerTradeController,
} from './player-trade.controller.js';
import { PlayerTradeService } from './player-trade.service.js';
import { TradeEscrowService } from './trade-escrow.service.js';
import { TradeSettlementService } from './trade-settlement.service.js';

// Settles GOLD on the backend ledger. GAME_ITEM lines wait for the trusted
// Agent confirmation (TradeSettlementService, exported for Etapa 11); no
// game command is used. Realtime goes through the global event bus.
@Module({
  imports: [AuditModule, EconomyModule, PlayerAuthModule, PlayerSettingsModule],
  providers: [PlayerTradeService, TradeEscrowService, TradeSettlementService],
  controllers: [PlayerTradeController, CharacterTradeController],
  exports: [TradeSettlementService, TradeEscrowService],
})
export class PlayerTradesModule {}
