import { Global, Module } from '@nestjs/common';
import { RealtimeEventBus } from './realtime-event-bus.js';

// Global so any domain can publish without importing the transport.
@Global()
@Module({ providers: [RealtimeEventBus], exports: [RealtimeEventBus] })
export class RealtimeEventsModule {}
