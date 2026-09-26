import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { Metrics } from './metrics.js';
import { METRICS_ROUTE } from './metrics.controller.js';

const PROBES = new Set(['/api/v1/live', '/api/v1/ready', '/api/v1/health']);

// HTTP metrics and the request log (12.3), one of each per request, on
// 'finish'. The route label is the matched Express route template
// (e.g. /api/v1/player/trades/:tradeId), never the concrete URL; unmatched
// requests are "unmatched". No body, no query string. The scrape itself
// is not measured. Probes log at debug to keep the log quiet.
export function httpObserver(metrics: Metrics) {
  const logger = new Logger('Http');
  return (request: Request, response: Response, next: NextFunction) => {
    const started = process.hrtime.bigint();
    response.on('finish', () => {
      const matched = request.route as { path?: string } | undefined;
      const route =
        typeof matched?.path === 'string'
          ? `${request.baseUrl ?? ''}${matched.path}`
          : 'unmatched';
      if (route === METRICS_ROUTE) return;
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const labels = {
        method: request.method,
        route,
        status: String(response.statusCode),
      };
      metrics.httpRequests.inc(labels);
      metrics.httpDuration.observe(labels, seconds);
      const record = {
        message: 'HTTP request completed',
        event: 'http_request',
        method: request.method,
        route,
        status: response.statusCode,
        durationMs: Math.round(seconds * 1000),
        ip: request.ip,
        userAgent: request.headers['user-agent']?.slice(0, 128),
        requestId: response.getHeader('x-request-id'),
      };
      if (PROBES.has(route)) logger.debug(record);
      else if (response.statusCode >= 500) logger.warn(record);
      else logger.log(record);
    });
    next();
  };
}
