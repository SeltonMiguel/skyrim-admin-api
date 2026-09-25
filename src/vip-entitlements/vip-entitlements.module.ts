import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { PlayerAuthModule } from '../player-auth/player-auth.module.js';
import { AgentSessionModule } from '../game-agent/agent-session.module.js';
import { GameBridgeModule } from '../game-bridge/game-bridge.module.js';
import {
  CharacterVipController,
  PlayerVipController,
} from './vip-entitlement.controller.js';
import { VipDeliveryService } from './vip-delivery.service.js';
import { VipEntitlementService } from './vip-entitlement.service.js';

// Entitlements over the Stage 08 catalog (vip_offers). Grant/revoke are
// internal (STAFF/SYSTEM) and exported with the typed checks; players only
// read. CHARACTER rights are delivered in game through typed GameCommands
// (VipDeliveryService, 11.4). No payment or checkout.
@Module({
  imports: [
    AuditModule,
    PlayerAuthModule,
    GameBridgeModule,
    AgentSessionModule,
  ],
  providers: [VipEntitlementService, VipDeliveryService],
  controllers: [PlayerVipController, CharacterVipController],
  exports: [VipEntitlementService, VipDeliveryService],
})
export class VipEntitlementsModule {}
