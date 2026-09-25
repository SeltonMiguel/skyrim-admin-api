import { Global, Module } from '@nestjs/common';
import { RealtimeEventBus } from './realtime-event-bus.js';
import { RealtimeSessionControl } from './realtime-session-control.js';

// Global so any domain can publish without importing the transport.
@Global()
@Module({
  providers: [RealtimeEventBus, RealtimeSessionControl],
  exports: [RealtimeEventBus, RealtimeSessionControl],
})
export class RealtimeEventsModule {}
