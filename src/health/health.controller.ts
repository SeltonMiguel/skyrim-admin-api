import { Controller, Get } from '@nestjs/common';
import {
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { HttpErrorDto } from '../common/filters/http-error.dto.js';
import { HealthService } from './health.service.js';

@ApiTags('health')
@ApiHeader({
  name: 'x-request-id',
  required: false,
  description: 'Request correlation ID',
})
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @ApiOperation({ summary: 'Check API and PostgreSQL availability' })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['status', 'database'],
      properties: {
        status: { type: 'string', enum: ['ok'] },
        database: { type: 'string', enum: ['up'] },
      },
    },
    headers: { 'x-request-id': { schema: { type: 'string' } } },
  })
  @ApiServiceUnavailableResponse({ type: HttpErrorDto })
  check() {
    return this.health.check();
  }
}
