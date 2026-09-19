import { AuditService } from '../audit/audit.service.js';
import { RequestContext } from '../common/request-context/request-context.service.js';
import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { loadEnvironment } from '../config/environment.js';
import { createDatabaseOptions } from '../database/database.options.js';
import { PasswordService } from '../auth/password.service.js';
import { BootstrapCoordinatorService } from './bootstrap-coordinator.service.js';

async function bootstrap(): Promise<void> {
  let database: DataSource | undefined;
  try {
    const config = loadEnvironment();
    database = new DataSource(createDatabaseOptions(config));
    await database.initialize();
    const result = await new BootstrapCoordinatorService(
      database,
      new PasswordService(),
      new AuditService(database, new RequestContext()),
    ).run(config.bootstrap);
    console.log(
      result === 'created'
        ? 'Coordinator created. Remove temporary bootstrap credentials.'
        : 'Coordinator already exists; no changes made.',
    );
  } catch (error) {
    // Never emit driver errors, DTO objects, connection options or credentials.
    console.error(
      error instanceof HttpException
        ? error.message
        : 'Coordinator bootstrap failed. Check configuration, database and migrations.',
    );
    process.exitCode = 1;
  } finally {
    if (database?.isInitialized) await database.destroy();
  }
}
await bootstrap();
