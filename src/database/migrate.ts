import 'reflect-metadata';
import { loadEnvironment } from '../config/environment.js';
import { InstanceLockHeldError } from '../lifecycle/instance-lock.js';
import {
  MigrationPrerequisiteError,
  runMigrations,
} from '../ops/migration-runner.js';

// `npm run migration:run:prod`: compiled, no rebuild, forward-only.
async function main(): Promise<void> {
  try {
    const applied = await runMigrations(loadEnvironment(), {}, (message) =>
      console.log(message),
    );
    console.log(
      applied.length
        ? `Applied ${applied.length} migration(s): ${applied.join(', ')}`
        : 'No pending migrations.',
    );
  } catch (error) {
    // Never print driver errors, SQL, connection options or credentials.
    console.error(
      error instanceof InstanceLockHeldError ||
        error instanceof MigrationPrerequisiteError
        ? error.message
        : 'Migration failed and was rolled back. Check the database, the migration timeouts (DB_MIGRATION_*) and the logs of this run.',
    );
    process.exitCode = 1;
  }
}
await main();
