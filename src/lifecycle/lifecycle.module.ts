import { Global, Module } from '@nestjs/common';
import { LifecycleService } from './lifecycle.service.js';

@Global()
@Module({ providers: [LifecycleService], exports: [LifecycleService] })
export class LifecycleModule {}
