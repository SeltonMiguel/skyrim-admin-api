import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { schemaStatus } from '../database/schema-status.js';
import { LifecycleService } from '../lifecycle/lifecycle.service.js';
import { REQUIRED_EXTENSIONS } from '../ops/migration-runner.js';

export interface Readiness {
  ready: boolean;
  checks: {
    bootstrapped: boolean;
    shuttingDown: boolean;
    singleInstanceLock: boolean;
    database: boolean;
    migrations: boolean;
    extensions: boolean;
  };
}

// GET /ready (12.2): may this instance receive traffic? Startup finished,
// not shutting down, single-instance lock held (when required), database
// reachable and every migration of this build applied. The Host Agent is
// deliberately not a dependency: an offline Agent never removes the API.
@Injectable()
export class ReadinessService {
  constructor(
    private readonly database: DataSource,
    private readonly lifecycle: LifecycleService,
  ) {}
  async check(): Promise<Readiness> {
    const state = this.lifecycle.state();
    let database = false;
    let migrations = false;
    let extensions = false;
    if (state.bootstrapped && !state.shuttingDown)
      try {
        const status = await schemaStatus(this.database);
        database = true;
        migrations = status.pending.length === 0;
        // Read-only: required extensions exist (never created here).
        const [row] = (await this.database.query(
          'SELECT count(*)::int AS installed FROM pg_extension WHERE extname = ANY($1)',
          [[...REQUIRED_EXTENSIONS]],
        )) as { installed: number }[];
        extensions = row.installed === REQUIRED_EXTENSIONS.length;
      } catch {
        database = false;
      }
    const checks = {
      bootstrapped: state.bootstrapped,
      shuttingDown: state.shuttingDown,
      singleInstanceLock: state.lock,
      database,
      migrations,
      extensions,
    };
    return {
      ready:
        checks.bootstrapped &&
        !checks.shuttingDown &&
        checks.singleInstanceLock &&
        checks.database &&
        checks.migrations &&
        checks.extensions,
      checks,
    };
  }
}
