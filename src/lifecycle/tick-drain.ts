// Tracks the tick a worker is running, so a graceful shutdown can stop
// scheduling and then await it (12.2). Ticks never overlap, so one slot is
// enough; semantics of the tick itself are untouched.
export class TickDrain {
  private current?: Promise<void>;
  private release?: () => void;
  begin(): void {
    this.current = new Promise((resolve) => {
      this.release = resolve;
    });
  }
  end(): void {
    this.release?.();
    this.current = undefined;
    this.release = undefined;
  }
  get active(): boolean {
    return this.current !== undefined;
  }
  wait(): Promise<void> {
    return this.current ?? Promise.resolve();
  }
}
