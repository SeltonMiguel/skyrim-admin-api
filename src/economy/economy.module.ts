import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { PlayerAuthModule } from '../player-auth/player-auth.module.js';
import { EconomyLedgerService } from './economy-ledger.service.js';
import { EconomyReconciliationService } from './economy-reconciliation.service.js';
import { EconomyService } from './economy.service.js';
import { WalletController } from './wallet.controller.js';
import { WalletService } from './wallet.service.js';

// Backend-owned ledger: no game command, Agent transport or Skyrim gold sync.
// The ledger and system movements are exported for Trade/Marketplace and
// the future Agent transport; players only read.
@Module({
  imports: [AuditModule, PlayerAuthModule],
  providers: [
    EconomyLedgerService,
    EconomyService,
    EconomyReconciliationService,
    WalletService,
  ],
  controllers: [WalletController],
  exports: [EconomyLedgerService, EconomyService, EconomyReconciliationService],
})
export class EconomyModule {}
