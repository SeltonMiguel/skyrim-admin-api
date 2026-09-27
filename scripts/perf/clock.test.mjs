import test from 'node:test';
import assert from 'node:assert/strict';
import { monotonicMs } from './clock.mjs';
import { until } from './client.mjs';
test('duration and state polling do not consult a stepping civil clock', async () => {
  const original = Date.now;
  Date.now = () => { throw new Error('Civil clock must not drive duration'); };
  try {
    const before = monotonicMs();
    let checks = 0;
    assert.equal(await until(async () => ++checks === 3 && 'ready', 2000), 'ready');
    assert.ok(monotonicMs() >= before);
    await assert.rejects(until(async () => false, 1), /deadline exceeded/);
  } finally { Date.now = original; }
});
