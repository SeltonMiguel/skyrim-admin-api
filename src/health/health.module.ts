import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import { ProbesController } from './probes.controller.js';
import { ReadinessService } from './readiness.service.js';

@Module({
  controllers: [HealthController, ProbesController],
  providers: [HealthService, ReadinessService],
})
export class HealthModule {}
