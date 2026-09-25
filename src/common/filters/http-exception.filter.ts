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
    // Client errors raised by the body parser before Nest (oversized or
    // malformed body) keep their 4xx status with a generic message.
    const parser = known ? undefined : clientError(exception);
    const statusCode = known
      ? exception.getStatus()
      : (parser ?? HttpStatus.INTERNAL_SERVER_ERROR);
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
            : parser
              ? (STATUS_CODES[parser] ?? 'Bad request')
              : 'Internal server error';

    if (!known && !parser) {
      this.logger.error(
        `Unhandled exception [requestId=${this.context.requestId ?? 'unknown'}]`,
        exception instanceof Error ? exception.name : 'Unknown error',
      );
    }

    if (response.headersSent) return;
    // 429s carry the wait in seconds (never which limit was exhausted).
    const retryAfter = known
      ? (exception as { retryAfter?: unknown }).retryAfter
      : undefined;
    if (
      statusCode === HttpStatus.TOO_MANY_REQUESTS &&
      typeof retryAfter === 'number' &&
      Number.isFinite(retryAfter)
    )
      response.setHeader(
        'Retry-After',
        String(Math.max(1, Math.ceil(retryAfter))),
      );
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

// http-errors raised by body-parser: `expose` marks a safe client error.
function clientError(exception: unknown): number | undefined {
  if (typeof exception !== 'object' || exception === null) return undefined;
  const { status, expose } = exception as {
    status?: unknown;
    expose?: unknown;
  };
  return expose === true &&
    typeof status === 'number' &&
    status >= 400 &&
    status < 500
    ? status
    : undefined;
}
