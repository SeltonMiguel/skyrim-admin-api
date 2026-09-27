import { jest } from '@jest/globals';
import type { ArgumentsHost } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { HttpExceptionFilter } from './http-exception.filter.js';
import type { RequestContext } from '../request-context/request-context.service.js';

// F-DB7 (12.7B): an unmapped unique violation is a conflict, never a 500,
// and the client never learns the constraint, table or SQL.
describe('HttpExceptionFilter database errors', () => {
  const respond = (exception: unknown) => {
    let status = 0;
    let body: Record<string, unknown> = {};
    const response = {
      headersSent: false,
      setHeader: jest.fn(),
      status(code: number) {
        status = code;
        return this;
      },
      json(value: Record<string, unknown>) {
        body = value;
      },
    };
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ originalUrl: '/api/v1/x' }),
        getResponse: () => response,
      }),
    } as unknown as ArgumentsHost;
    new HttpExceptionFilter({ requestId: 'r1' } as RequestContext).catch(
      exception,
      host,
    );
    return { status, body };
  };
  const failure = (driverError: object) =>
    new QueryFailedError('INSERT INTO secret_table VALUES ($1)', ['v'], {
      message: 'duplicate key value violates unique constraint',
      ...driverError,
    } as Error);

  it('answers an unmapped 23505 with a generic 409', () => {
    const { status, body } = respond(
      failure({ code: '23505', constraint: 'secret_table_key' }),
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({
      statusCode: 409,
      error: 'Conflict',
      message: 'Conflict',
    });
    expect(JSON.stringify(body)).not.toMatch(/secret|INSERT|duplicate/);
  });
  it('keeps every other database failure as a generic 500', () => {
    const { status, body } = respond(failure({ code: '23503' }));
    expect(status).toBe(500);
    expect(body).toMatchObject({ message: 'Internal server error' });
    expect(JSON.stringify(body)).not.toMatch(/secret|INSERT/);
  });
});
