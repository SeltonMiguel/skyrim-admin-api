import { Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { LifecycleService } from './lifecycle.service.js';

// Graceful shutdown sequence (12.2):
//  1. readiness turns false (GET /ready answers 503);
//  2. app.close():
//     a. onModuleDestroy: upgrade router stops accepting WebSockets, every
//        worker stops scheduling and awaits its running tick, the Agent
//        heartbeat sweep stops;
//     b. beforeApplicationShutdown: Player/Staff realtime closes (1001),
//        Agent sessions are persisted as SHUTDOWN and closed (1001);
//     c. onApplicationShutdown: single-instance lock released, database
//        pool closed;
//     d. the HTTP server closes;
//  3. the process exits; after `timeoutMs` it is forced to exit (code 1).
// GameCommand and Server Control state is all in PostgreSQL, so a forced
// exit never breaks their guarantees (at-least-once / at-most-once).
export function gracefulShutdown(
  app: INestApplication,
  timeoutMs: number,
  reason: string,
  onTimeout: () => void = () => process.exit(1),
): Promise<boolean> {
  const logger = new Logger('Shutdown');
  logger.log(`Graceful shutdown started [reason=${reason}]`);
  app.get(LifecycleService).beginShutdown();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      logger.error(`Graceful shutdown timed out [timeoutMs=${timeoutMs}]`);
      onTimeout();
      resolve(false);
    }, timeoutMs);
    timer.unref();
  });
  const closing = app.close().then(
    () => {
      logger.log('Graceful shutdown complete');
      return true;
    },
    () => {
      logger.error('Graceful shutdown failed');
      return false;
    },
  );
  return Promise.race([closing, timeout]).finally(() => clearTimeout(timer));
}

// Production entrypoint only: SIGTERM/SIGINT (and a lost single-instance
// lock) run the sequence once, then exit with its outcome.
export function installGracefulShutdown(
  app: INestApplication,
  timeoutMs: number,
): void {
  let started = false;
  const run = (reason: string, failure = false) => {
    if (started) return;
    started = true;
    void gracefulShutdown(app, timeoutMs, reason).then((clean) =>
      process.exit(clean && !failure ? 0 : 1),
    );
  };
  process.once('SIGTERM', () => run('SIGTERM'));
  process.once('SIGINT', () => run('SIGINT'));
  app.get(LifecycleService).onLockLost(() => run('LOCK_LOST', true));
}
