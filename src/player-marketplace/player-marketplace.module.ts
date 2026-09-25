import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { EconomyModule } from '../economy/economy.module.js';
import { PlayerAuthModule } from '../player-auth/player-auth.module.js';
import { MarketEscrowService } from './market-escrow.service.js';
import { MarketplaceCustodyService } from './marketplace-custody.service.js';
import { MarketplaceReleaseService } from './marketplace-release.service.js';
import { MarketplaceWorkSource } from './marketplace-work.source.js';
import { MarketplaceSettlementService } from './marketplace-settlement.service.js';
import {
  CharacterMarketplaceController,
  PlayerMarketplaceController,
} from './player-marketplace.controller.js';
import { PlayerMarketplaceService } from './player-marketplace.service.js';

// GOLD moves only on the backend ledger (MARKET_ESCROW). The GAME_ITEM is
// held and moved by the trusted Agent through the internal custody and
// settlement contracts (exported for Etapa 11); no game command is used.
// Realtime goes through the global event bus.
@Module({
  imports: [AuditModule, EconomyModule, PlayerAuthModule],
  providers: [
    PlayerMarketplaceService,
    MarketEscrowService,
    MarketplaceCustodyService,
    MarketplaceSettlementService,
    MarketplaceReleaseService,
    MarketplaceWorkSource,
  ],
  controllers: [PlayerMarketplaceController, CharacterMarketplaceController],
  exports: [
    MarketplaceCustodyService,
    MarketplaceSettlementService,
    MarketEscrowService,
    MarketplaceReleaseService,
    MarketplaceWorkSource,
  ],
})
export class PlayerMarketplaceModule {}
