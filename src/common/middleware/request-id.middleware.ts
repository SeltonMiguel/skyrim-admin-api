import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { RequestContext } from '../request-context/request-context.service.js';

export function requestIdMiddleware(context: RequestContext): RequestHandler {
  return (request, response, next) => {
    const incoming = request.headers['x-request-id'];
    const requestId =
      typeof incoming === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(incoming)
        ? incoming
        : randomUUID();

    response.setHeader('x-request-id', requestId);
    context.run(requestId, next, {
      method: request.method,
      // Never persist query parameters, which can contain credentials.
      path: request.path,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });
  };
}
