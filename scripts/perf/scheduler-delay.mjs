// Opt-in fault injection for the two historical test sleeps. Use only with
// the focused regression suites, never a production process or a capacity run.
// Node --import patches the scheduler before Jest starts. Existing deadlines
// and worker intervals are untouched. This models a late test continuation,
// not PostgreSQL slowness or a measured production event-loop stall.
const extra = Number(process.env.PERF_TIMER_DELAY_MS ?? 0);
if (!Number.isInteger(extra) || extra < 0 || extra > 2000)
  throw new Error('PERF_TIMER_DELAY_MS must be 0..2000');
if (extra) {
  if (process.env.TEST_DATABASE_INTEGRATION !== 'true')
    throw new Error('Scheduler injection is restricted to integration tests');
  const original = globalThis.setTimeout;
  globalThis.setTimeout = function (callback, delay, ...args) {
    if (delay !== 200 && delay !== 400) return original(callback, delay, ...args);
    const start = performance.now();
    return original((...values) => {
      process.stderr.write(JSON.stringify({ perfSchedulerInjection: true, requestedMs: delay,
        injectedMs: extra, actualMs: performance.now() - start }) + '\n');
      callback(...values);
    }, delay + extra, ...args);
  };
}
