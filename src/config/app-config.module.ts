import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnvironment } from './environment.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      skipProcessEnv: true,
      validate: (raw: Record<string, unknown>) => ({
        application: validateEnvironment(raw),
      }),
    }),
  ],
})
export class AppConfigModule {}
