import { Global, Module } from '@nestjs/common';
import { InstanceIdentity } from '../cluster/instance-identity.js';
import { LifecycleService } from './lifecycle.service.js';

// One InstanceIdentity per application (12.5): two Nest apps in one process
// (the dual-instance e2e) are two instances.
@Global()
@Module({
  providers: [LifecycleService, InstanceIdentity],
  exports: [LifecycleService, InstanceIdentity],
})
export class LifecycleModule {}
