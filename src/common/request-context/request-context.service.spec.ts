import { setTimeout } from 'node:timers/promises';
import { RequestContext } from './request-context.service.js';

describe('RequestContext', () => {
  it('isolates overlapping asynchronous requests and clears the caller context', async () => {
    const context = new RequestContext();
    const run = (id: string, delay: number) =>
      new Promise<string | undefined>((resolve, reject) => {
        context.run(id, () => {
          void setTimeout(delay).then(() => resolve(context.requestId), reject);
        });
      });
    expect(context.requestId).toBeUndefined();
    expect(
      await Promise.all([run('first', 20), run('second', 1), run('third', 10)]),
    ).toEqual(['first', 'second', 'third']);
    expect(context.requestId).toBeUndefined();
  });
});
