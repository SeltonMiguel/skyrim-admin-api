import { Module } from '@nestjs/common';
import { WebSocketUpgradeRouter } from './websocket-upgrade.router.js';

// Shared by every WebSocket surface (Player/Staff realtime, Host Agent).
@Module({
  providers: [WebSocketUpgradeRouter],
  exports: [WebSocketUpgradeRouter],
})
export class WebSocketModule {}
