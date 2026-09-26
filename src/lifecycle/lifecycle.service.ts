import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ApplicationConfig } from '../config/environment.js';
import { InstanceLock } from './instance-lock.js';

const LOCK_PROBE_MS = 5000;

// Process lifecycle (12.2): the single-instance lock, taken before any
// worker or socket starts (onModuleInit runs before every
// onApplicationBootstrap) and released only after workers stopped and
// sockets closed (onApplicationShutdown runs last); and the readiness
// flags used by GET /ready.
@Injectable()
export class LifecycleService
  implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger('Lifecycle');
  private readonly lock?: InstanceLock;
  private bootstrapped = false;
  private shuttingDown = false;
  private lockLost = false;
  private probe?: ReturnType<typeof setInterval>;
  private lostHandler?: () => void;
  constructor(config: ConfigService<{ application: ApplicationConfig }, true>) {
    const application = config.get('application', { infer: true });
    if (application.deployment.singleInstanceLock)
      this.lock = new InstanceLock(application.database);
  }
  async onModuleInit(): Promise<void> {
    if (!this.lock) return;
    // Fails the startup (InstanceLockHeldError) when another instance runs.
    await this.lock.acquire();
    this.lock.onLost(() => this.lost());
    this.probe = setInterval(() => {
      void this.lock!.verify().then((ok) => {
        if (!ok) this.lost();
      });
    }, LOCK_PROBE_MS);
    this.probe.unref();
    this.logger.log('Single-instance lock acquired');
  }
  onApplicationBootstrap(): void {
    this.bootstrapped = true;
  }
  // First step of a graceful shutdown: stop advertising readiness.
  beginShutdown(): void {
    this.shuttingDown = true;
  }
  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.probe) clearInterval(this.probe);
    if (this.lock?.held) {
      await this.lock.release();
      this.logger.log('Single-instance lock released');
    }
  }
  // The instance must stop: another process could now take the lock.
  onLockLost(handler: () => void): void {
    this.lostHandler = handler;
  }
  private lost(): void {
    if (this.lockLost || this.shuttingDown) return;
    this.lockLost = true;
    this.logger.error('Single-instance lock lost; stopping this instance');
    this.lostHandler?.();
  }
  get lockRequired(): boolean {
    return !!this.lock;
  }
  state() {
    return {
      bootstrapped: this.bootstrapped,
      shuttingDown: this.shuttingDown,
      lock: !this.lock || (this.lock.held && !this.lockLost),
    };
  }
}
