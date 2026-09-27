// Opt-in diagnostic instrumentation, never imported by the application.
import type { INestApplication } from '@nestjs/common';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { appendFileSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { ActorCommandService } from '../../src/actor-operations/actor-command.service.js';
import { GameCommandBus } from '../../src/game-bridge/game-command-bus.js';
import { GameCommandDispatcher } from '../../src/game-bridge/game-command-dispatcher.js';
import { GameCommandReceiver } from '../../src/game-bridge/game-command-receiver.js';
import { GameGateway } from '../../src/game-bridge/game-gateway.js';
import { GameCommandWorker } from '../../src/game-agent/game-command.worker.js';
import { ServerControlWorker } from '../../src/server-control/server-control.worker.js';
import { ServerControlGateway } from '../../src/server-control/server-control-gateway.js';

export function startPerfTrace(app: INestApplication): () => void {
  const file = process.env.PERF_TRACE_FILE;
  if (!file) return () => {};
  const concurrency = Number(process.env.PERF_FLAKE_LOAD ?? 0);
  if (![0, 8, 32].includes(concurrency))
    throw new Error('PERF_FLAKE_LOAD must be 0, 8 or 32');
  let stopped = false,
    requests = 0,
    failures = 0;
  const httpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: concurrency || 1,
  });
  const address = app.getHttpServer().address() as AddressInfo;
  const next = () => {
    if (stopped) return;
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port: address.port,
        path: '/api/v1/ready',
        agent: httpAgent,
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          requests++;
          if (res.statusCode !== 200) failures++;
          setImmediate(next);
        });
      },
    );
    req.on('error', () => {
      if (!stopped) {
        failures++;
        setImmediate(next);
      }
    });
  };
  for (let lane = 0; lane < concurrency; lane++) next();
  const events: unknown[] = [],
    restores: (() => void)[] = [];
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  const pool = (
    app.get(DataSource).driver as unknown as {
      master: { waitingCount: number; totalCount: number };
    }
  ).master;
  let waitingPeak = 0,
    waitSamples = 0,
    samples = 0;
  const timer = setInterval(() => {
    samples++;
    waitingPeak = Math.max(waitingPeak, pool.waitingCount);
    if (pool.waitingCount) waitSamples++;
  }, 20);
  function trace(
    target: object,
    method: string,
    kind: string,
    interval?: number,
  ) {
    const object = target as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    const original = object[method];
    let previous = performance.now();
    object[method] = async function (this: object, ...args: unknown[]) {
      const start = performance.now(),
        wall = Date.now();
      const schedulingDelay = interval
        ? Math.max(0, start - previous - interval)
        : undefined;
      previous = start;
      let result: unknown, error: unknown;
      try {
        result = await original.apply(this, args);
        return result;
      } catch (caught) {
        error = caught;
        throw caught;
      } finally {
        const input = args[kind === 'frame-sent' ? 1 : 0] as
          | { commandId?: string; operationId?: string; attempt?: number }
          | undefined;
        const output = result as
          | { id?: string; command?: { id: string; dispatchAttempts: number } }
          | undefined;
        if (events.length < 10000)
          events.push({
            kind,
            start,
            end: performance.now(),
            wall,
            schedulingDelay,
            id:
              output?.id ??
              output?.command?.id ??
              input?.commandId ??
              input?.operationId,
            attempt: output?.command?.dispatchAttempts ?? input?.attempt,
            error: error instanceof Error ? error.message : undefined,
          });
      }
    };
    restores.push(() => {
      object[method] = original;
    });
  }
  trace(app.get(ActorCommandService), 'create', 'created');
  trace(app.get(GameCommandBus), 'submit', 'created');
  trace(app.get(GameCommandDispatcher), 'reserve', 'reserved');
  trace(app.get(GameGateway), 'send', 'frame-sent');
  trace(app.get(GameCommandReceiver), 'acknowledge', 'ack-persisted');
  trace(app.get(ServerControlGateway), 'send', 'control-frame-sent');
  const config = app.get(ConfigService).get('application');
  trace(
    app.get(GameCommandWorker),
    'tick',
    'command-tick',
    config.gameBridge.workerIntervalMs,
  );
  trace(
    app.get(ServerControlWorker),
    'tick',
    'control-tick',
    config.serverControl.workerIntervalMs,
  );
  return () => {
    stopped = true;
    httpAgent.destroy();
    clearInterval(timer);
    lag.disable();
    for (const restore of restores) restore();
    appendFileSync(
      file,
      JSON.stringify({
        concurrency,
        requests,
        failures,
        events,
        lagP99Ms: lag.percentile(99) / 1e6,
        lagMaxMs: lag.max / 1e6,
        waitingPeak,
        waitSamples,
        samples,
        connections: pool.totalCount,
      }) + '\n',
    );
  };
}
