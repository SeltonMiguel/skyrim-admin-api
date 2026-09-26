import {
  Controller,
  Get,
  Header,
  Headers,
  NotFoundException,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import type { ApplicationConfig } from '../config/environment.js';
import { Metrics } from './metrics.js';

export const METRICS_ROUTE = '/api/v1/metrics';
const digest = (value: string) => createHash('sha256').update(value).digest();

// Operational surface (12.3), not Admin Web: no Staff JWT/RBAC. Disabled
// (METRICS_ENABLED=false, the production default) it is a plain 404. With
// METRICS_BEARER_TOKEN (required in production) the token is compared in
// constant time (sha256 digests); a wrong or missing token gets a generic
// 401. The token is never logged.
@ApiExcludeController()
@Controller({ version: '1' })
export class MetricsController {
  private readonly enabled: boolean;
  private readonly token?: Buffer;
  constructor(
    private readonly metrics: Metrics,
    config: ConfigService<{ application: ApplicationConfig }, true>,
  ) {
    const observability = config.get('application', {
      infer: true,
    }).observability;
    this.enabled = observability.metricsEnabled;
    this.token = observability.metricsToken
      ? digest(observability.metricsToken)
      : undefined;
  }
  @Get('metrics')
  @Header('Cache-Control', 'no-store')
  async scrape(
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    if (!this.enabled) throw new NotFoundException();
    if (this.token) {
      const match = /^Bearer (\S{1,512})$/.exec(authorization ?? '');
      if (!match || !timingSafeEqual(digest(match[1]), this.token))
        throw new UnauthorizedException();
    }
    response.setHeader('Content-Type', this.metrics.registry.contentType);
    return this.metrics.render();
  }
}
