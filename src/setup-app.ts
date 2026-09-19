import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { requestIdMiddleware } from './common/middleware/request-id.middleware.js';
import { RequestContext } from './common/request-context/request-context.service.js';

export function setupApp(app: INestApplication): void {
  // Register before Nest's body parser so malformed JSON also gets a request ID.
  app.use(requestIdMiddleware(app.get(RequestContext)));
  app.setGlobalPrefix('/api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();

  const config = new DocumentBuilder()
    .setTitle('Skyrim Admin API')
    .setDescription('Administrative API for Skyrim Brasil / SkyMP')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
}
