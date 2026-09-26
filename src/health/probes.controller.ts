import { Controller, Get, Header, Res } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ReadinessService } from './readiness.service.js';

// Operational probes (12.2). Public, unauthenticated, tiny and bounded.
@ApiTags('health')
@Controller({ version: '1' })
export class ProbesController {
  constructor(private readonly readiness: ReadinessService) {}
  @Get('live')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Liveness: the process and its event loop answer. No I/O.',
  })
  @ApiOkResponse({ schema: { example: { status: 'live' } } })
  live() {
    return { status: 'live' };
  }
  @Get('ready')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Readiness: bootstrap done, not shutting down, single-instance lock held, database reachable, migrations current, required extensions present. Read-only; never depends on the Host Agent.',
  })
  @ApiOkResponse({ schema: { example: { status: 'ready' } } })
  @ApiServiceUnavailableResponse({
    schema: { example: { status: 'not_ready', checks: {} } },
  })
  async ready(@Res({ passthrough: true }) response: Response) {
    const result = await this.readiness.check();
    if (result.ready) return { status: 'ready' };
    response.status(503);
    return { status: 'not_ready', checks: result.checks };
  }
}
