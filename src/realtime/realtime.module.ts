import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PlayerAuthModule } from '../player-auth/player-auth.module.js';
import { RealtimeConnectionRegistry } from './realtime-connection.registry.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { WebSocketModule } from '../websocket/websocket.module.js';

// Transport only: consumes RealtimeEventBus and authenticates each surface
// with its own service. Domains never import this module.
@Module({
  imports: [AuthModule, PlayerAuthModule, WebSocketModule],
  providers: [RealtimeConnectionRegistry, RealtimeGateway],
  exports: [RealtimeConnectionRegistry],
})
export class RealtimeModule {}
