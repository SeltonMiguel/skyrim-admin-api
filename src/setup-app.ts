import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Express, RequestHandler } from 'express';
import helmet from 'helmet';
import type { ApplicationConfig } from './config/environment.js';
import { ClientAddress } from './common/net/client-address.service.js';
import { requestIdMiddleware } from './common/middleware/request-id.middleware.js';
import { RequestContext } from './common/request-context/request-context.service.js';

export const SWAGGER_PATH = 'docs';
// Headers a browser client may send and read (Bearer tokens, no cookies).
const CORS_REQUEST_HEADERS = [
  'Authorization',
  'Content-Type',
  'Idempotency-Key',
  'X-Request-Id',
];
const CORS_EXPOSED_HEADERS = ['X-Request-Id', 'Retry-After', 'Location'];

export function setupApp(app: INestApplication): void {
  const config = app
    .get(ConfigService)
    .getOrThrow<ApplicationConfig>('application');
  const express = app.getHttpAdapter().getInstance() as Express;
  // One proxy policy (TRUST_PROXY) for request.ip, rate limits, Audit and
  // the WebSocket upgrades; never `true`.
  express.set('trust proxy', app.get(ClientAddress).trust);
  express.disable('x-powered-by');
  // Register before Nest's body parser so malformed JSON also gets a request ID.
  app.use(requestIdMiddleware(app.get(RequestContext)));
  app.use(securityHeaders(config));
  // CORS only for the configured browser origins. Requests without an Origin
  // (Electron main process, Host Agent, server-to-server) are unaffected.
  if (config.security.corsOrigins.length)
    app.enableCors({
      origin: config.security.corsOrigins,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: CORS_REQUEST_HEADERS,
      exposedHeaders: CORS_EXPOSED_HEADERS,
      credentials: false,
      maxAge: 600,
    });
  app.setGlobalPrefix('/api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  // Signals are handled by the production entrypoint (src/main.ts), which
  // turns readiness off before closing the application (12.2).

  // Off by default in production (SWAGGER_ENABLED); the document maps every
  // route, so enabling it there should sit behind a private network or proxy.
  if (!config.security.swaggerEnabled) return;
  const document = new DocumentBuilder()
    .setTitle('Skyrim Admin API')
    .setDescription('Administrative API for Skyrim Brasil / SkyMP')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup(
    SWAGGER_PATH,
    app,
    SwaggerModule.createDocument(app, document),
  );
}

// API headers: the backend serves JSON only, so the CSP forbids everything
// except on the (dev) Swagger UI, which keeps Helmet's defaults. HSTS is
// opt-in (SECURITY_HSTS_MAX_AGE_SECONDS) because TLS ends at the proxy.
function securityHeaders(config: ApplicationConfig): RequestHandler {
  const common = {
    crossOriginResourcePolicy: { policy: 'same-site' as const },
    referrerPolicy: { policy: 'no-referrer' as const },
    frameguard: { action: 'deny' as const },
    hsts: config.security.hstsMaxAgeSeconds
      ? { maxAge: config.security.hstsMaxAgeSeconds, includeSubDomains: true }
      : false,
  };
  const api = helmet({
    ...common,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
  });
  const docs = helmet(common);
  return (request, response, next) =>
    (request.path.startsWith(`/${SWAGGER_PATH}`) ? docs : api)(
      request,
      response,
      next,
    );
}
