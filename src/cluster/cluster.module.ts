import { Global, Module } from '@nestjs/common';
import { ClusterBus } from './cluster-bus.js';
import { ClusterRelay } from './cluster-relay.js';
import { RealtimeLeaseService } from './realtime-leases.js';

// Multi-instance coordination (12.5): PostgreSQL LISTEN/NOTIFY bus, the
// realtime relay and cluster-wide realtime leases. Inert in SINGLE. The
// shared RateLimiter is provided by CommonModule; InstanceIdentity by
// LifecycleModule.
@Global()
@Module({
  providers: [ClusterBus, ClusterRelay, RealtimeLeaseService],
  exports: [ClusterBus, RealtimeLeaseService],
})
export class ClusterModule {}
