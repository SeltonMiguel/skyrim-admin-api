import pg from 'pg';
import type { ApplicationConfig } from '../config/environment.js';
import { pgClientConfig } from '../database/database.options.js';

// Stable, documented key of the single-instance guard (12.2): the two-int
// advisory lock (0x534B5952 'SKYR', 1 = backend singleton). Advisory locks
// are scoped to one database, so it protects every process pointed at the
// same database: the application and the migration runner.
export const INSTANCE_LOCK_KEY = [0x534b5952, 1] as const;

export class InstanceLockHeldError extends Error {
  constructor() {
    super(
      'Another backend instance or migration holds the single-instance lock on this database ' +
        `(pg_advisory_lock(${INSTANCE_LOCK_KEY.join(', ')})). Stop it first: ` +
        'more than one backend replica is not supported before Stage 12.5.',
    );
    this.name = 'InstanceLockHeldError';
  }
}

// Holds the lock on a dedicated connection, never a pool connection: the
// lock lives exactly as long as that session. A crash or kill drops the
// TCP session and PostgreSQL releases it; release() unlocks explicitly.
export class InstanceLock {
  private client?: pg.Client;
  private lostListener?: () => void;
  private released = false;
  constructor(private readonly database: ApplicationConfig['database']) {}
  // Never waits: pg_try_advisory_lock returns false at once when held.
  async acquire(): Promise<void> {
    const client = new pg.Client(pgClientConfig(this.database));
    await client.connect();
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1, $2) AS locked',
        [...INSTANCE_LOCK_KEY],
      );
      if (!rows[0]?.locked) throw new InstanceLockHeldError();
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
    this.client = client;
    const lost = () => {
      if (this.released) return;
      this.released = true;
      this.client = undefined;
      this.lostListener?.();
    };
    client.on('error', lost);
    client.on('end', lost);
  }
  get held(): boolean {
    return !!this.client && !this.released;
  }
  // Called once if the lock session dies while the process is alive.
  onLost(listener: () => void): void {
    this.lostListener = listener;
  }
  // Cheap liveness probe of the lock session.
  async verify(): Promise<boolean> {
    if (!this.client || this.released) return false;
    try {
      await this.client.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
  async release(): Promise<void> {
    const client = this.client;
    if (!client || this.released) return;
    this.released = true;
    this.client = undefined;
    try {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [
        ...INSTANCE_LOCK_KEY,
      ]);
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}
