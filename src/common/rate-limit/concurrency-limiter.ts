import { Injectable } from '@nestjs/common';

// Caps how many expensive operations of one kind run at once in this
// process (Argon2 verification, Agent HELLO verification). A saturated slot
// refuses immediately instead of queueing, so load never builds up memory.
@Injectable()
export class ConcurrencyLimiter {
  private readonly active = new Map<string, number>();
  // Returns a release function, or null when `max` are already running.
  tryAcquire(kind: string, max: number): (() => void) | null {
    const current = this.active.get(kind) ?? 0;
    if (current >= max) return null;
    this.active.set(kind, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.active.get(kind) ?? 1) - 1;
      if (left > 0) this.active.set(kind, left);
      else this.active.delete(kind);
    };
  }
  running(kind: string): number {
    return this.active.get(kind) ?? 0;
  }
}
