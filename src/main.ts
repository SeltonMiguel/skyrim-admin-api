import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module.js';
import type { ApplicationConfig } from './config/environment.js';
import { setupApp } from './setup-app.js';
import { AppExpressAdapter } from './common/http/app-express.adapter.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, new AppExpressAdapter());
  setupApp(app);
  const config = app
    .get(ConfigService)
    .getOrThrow<ApplicationConfig>('application');
  await app.listen(config.port);
}
await bootstrap();
