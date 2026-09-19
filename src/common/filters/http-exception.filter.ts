import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { STATUS_CODES } from 'node:http';
import type { Request, Response } from 'express';
import { RequestContext } from '../request-context/request-context.service.js';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  constructor(private readonly context: RequestContext) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const known = exception instanceof HttpException;
    const statusCode = known
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;
    const body = known ? exception.getResponse() : undefined;
    const details = typeof body === 'object' && body !== null ? body : {};
    const error =
      'error' in details && typeof details.error === 'string'
        ? details.error
        : (STATUS_CODES[statusCode] ?? 'Error');
    const message =
      typeof body === 'string'
        ? body
        : 'message' in details &&
            (typeof details.message === 'string' ||
              (Array.isArray(details.message) &&
                details.message.every(
                  (item: unknown) => typeof item === 'string',
                )))
          ? details.message
          : known
            ? exception.message
            : 'Internal server error';

    if (!known) {
      this.logger.error(
        `Unhandled exception [requestId=${this.context.requestId ?? 'unknown'}]`,
        exception instanceof Error ? exception.name : 'Unknown error',
      );
    }

    if (response.headersSent) return;
    response.status(statusCode).json({
      statusCode,
      error,
      message,
      path: request.originalUrl,
      requestId: this.context.requestId,
      timestamp: new Date().toISOString(),
    });
  }
}
