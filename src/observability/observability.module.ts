import { Global, Module } from '@nestjs/common';
import { AppLogger } from './app-logger.js';
import { BacklogCollector } from './backlog.collector.js';
import { Metrics } from './metrics.js';
import { MetricsController } from './metrics.controller.js';
import { RuntimeMetrics } from './runtime-metrics.js';

// Signals only (12.3): metrics registry and /api/v1/metrics, the
// structured logger, DB-backed backlog gauges. No collector, tracer or
// vendor integration lives in the application.
@Global()
@Module({
  providers: [Metrics, AppLogger, RuntimeMetrics, BacklogCollector],
  controllers: [MetricsController],
  exports: [Metrics, AppLogger],
})
export class ObservabilityModule {}
