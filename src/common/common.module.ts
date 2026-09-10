import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { HttpExceptionFilter } from './filters/http-exception.filter.js';
import { RequestContext } from './request-context/request-context.service.js';

@Global()
@Module({
  providers: [
    RequestContext,
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
  exports: [RequestContext],
})
export class CommonModule {}
