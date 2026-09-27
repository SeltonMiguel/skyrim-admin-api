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
import { QueryFailedError } from 'typeorm';
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
    // A unique violation no domain mapped (F-DB7) is a conflict with the
    // current state: generic 409, the transaction already rolled back.
    const unique = known || parser ? undefined : uniqueViolation(exception);
    const statusCode = known
      ? exception.getStatus()
      : (parser ??
        (unique ? HttpStatus.CONFLICT : HttpStatus.INTERNAL_SERVER_ERROR));
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
              : unique
                ? 'Conflict'
                : 'Internal server error';

    if (unique)
      // Server log only: the constraint name keeps an unmapped path visible;
      // the client never sees SQL, constraint or table names.
      this.logger.warn({
        message: 'Unmapped unique violation',
        event: 'http_unique_conflict',
        requestId: this.context.requestId ?? 'unknown',
        constraint: unique.constraint ?? 'unknown',
      });
    else if (!known && !parser) {
      // Server log only (redacted by the logger): class and stack, never
      // the request payload; the client gets the generic 500 below.
      this.logger.error(
        {
          message: 'Unhandled exception',
          event: 'http_unhandled_exception',
          requestId: this.context.requestId ?? 'unknown',
          exception:
            exception instanceof Error ? exception.name : 'Unknown error',
        },
        exception instanceof Error ? exception.stack : undefined,
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

function uniqueViolation(
  exception: unknown,
): { constraint?: string } | undefined {
  if (!(exception instanceof QueryFailedError)) return undefined;
  const driver = exception.driverError as {
    code?: string;
    constraint?: string;
  };
  return driver?.code === '23505'
    ? { constraint: driver.constraint }
    : undefined;
}
