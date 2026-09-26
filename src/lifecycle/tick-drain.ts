// Tracks the tick a worker is running, so a graceful shutdown can stop
// scheduling and then await it (12.2). Ticks never overlap, so one slot is
// enough; semantics of the tick itself are untouched. An optional observer
// (12.3) receives start, outcome, duration and skipped ticks for metrics.
export interface TickObserver {
  started(): void;
  finished(ok: boolean, seconds: number): void;
  skipped(): void;
}
export class TickDrain {
  private current?: Promise<void>;
  private release?: () => void;
  private startedAt = 0;
  private failed = false;
  constructor(private readonly observer?: TickObserver) {}
  begin(): void {
    this.failed = false;
    this.startedAt = performance.now();
    this.observer?.started();
    this.current = new Promise((resolve) => {
      this.release = resolve;
    });
  }
  // The tick caught and logged an error: it counts as failed.
  fail(): void {
    this.failed = true;
  }
  skip(): void {
    this.observer?.skipped();
  }
  end(): void {
    this.observer?.finished(
      !this.failed,
      (performance.now() - this.startedAt) / 1000,
    );
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
