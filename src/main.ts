import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module.js';
import type { ApplicationConfig } from './config/environment.js';
import { setupApp } from './setup-app.js';
import { AppExpressAdapter } from './common/http/app-express.adapter.js';
import { installGracefulShutdown } from './lifecycle/graceful-shutdown.js';
import { InstanceLockHeldError } from './lifecycle/instance-lock.js';

async function bootstrap() {
  // The server never runs in test mode: that mode accepts ephemeral
  // per-process secrets meant for the test suites only.
  if (process.env.NODE_ENV === 'test')
    throw new Error('NODE_ENV=test is not a valid mode for the server');
  const app = await NestFactory.create(AppModule, new AppExpressAdapter());
  setupApp(app);
  const config = app
    .get(ConfigService)
    .getOrThrow<ApplicationConfig>('application');
  installGracefulShutdown(app, config.deployment.shutdownTimeoutMs);
  if (config.nodeEnv !== 'production')
    new Logger('Bootstrap').warn(
      `Running with NODE_ENV=${config.nodeEnv}; production requires NODE_ENV=production`,
    );
  await app.listen(config.port);
}
try {
  await bootstrap();
} catch (error) {
  // A second instance is an operational error, reported without a stack.
  if (!(error instanceof InstanceLockHeldError)) throw error;
  new Logger('Bootstrap').error(error.message);
  process.exit(1);
}
