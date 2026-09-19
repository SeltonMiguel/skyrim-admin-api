import { ApiProperty } from '@nestjs/swagger';

export class HttpErrorDto {
  @ApiProperty({ example: 503 })
  statusCode: number;

  @ApiProperty({ example: 'Service Unavailable' })
  error: string;

  @ApiProperty({
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    example: 'Database unavailable',
  })
  message: string | string[];

  @ApiProperty({ example: '/api/v1/health' })
  path: string;

  @ApiProperty()
  requestId: string;

  @ApiProperty({ format: 'date-time' })
  timestamp: string;
}
