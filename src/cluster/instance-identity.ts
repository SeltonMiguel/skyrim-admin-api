import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

// Identity of this process execution (12.5): a random UUID generated at
// boot, never reused after a restart and never derived from the hostname.
// It owns Agent sessions and realtime leases in PostgreSQL. It appears in
// logs, never as a metric label (the scraper already has target/instance).
@Injectable()
export class InstanceIdentity {
  readonly id: string = randomUUID();
  readonly startedAt = new Date();
}
// Used only by services constructed without Nest (unit fixtures), so that
// all of them agree on one identity inside a single test process.
export const STANDALONE_INSTANCE = new InstanceIdentity();
