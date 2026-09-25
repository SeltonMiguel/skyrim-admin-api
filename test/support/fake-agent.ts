import { randomUUID } from 'node:crypto';
import { RealtimeTestClient } from './realtime-client.js';

export type Frame = Record<string, unknown> & {
  type?: string;
  messageId?: string;
  payload?: Record<string, unknown>;
};
type Journal = {
  state: 'RECEIVED' | 'FORWARDED' | 'COMPLETED';
  result?: Record<string, unknown>;
};
// Server Control journal (at-most-once): EXECUTING without an outcome can
// only ever be reported as UNCERTAIN, never executed again.
type OperationJournal = {
  state: 'RECEIVED' | 'EXECUTING' | 'COMPLETED';
  outcome?: Record<string, unknown>;
};

// Host Agent simulator for e2e tests. It speaks the real v1 protocol over
// the real socket and implements the durable journal contract the backend
// relies on for mutations (docs/integration-architecture.md §8.2):
// commandId is the execution identity, a COMPLETED command is never
// executed again and its result is replayed. The journal outlives a socket
// (reuse it across reconnects) to model a restart-safe Agent.
export class FakeAgent {
  readonly client: RealtimeTestClient;
  connectionId?: string;
  constructor(
    url: string,
    private readonly gameServerId: string,
    readonly journal = new Map<string, Journal>(),
    // Side effects actually applied per commandId.
    readonly executions = new Map<string, number>(),
    readonly operations = new Map<string, OperationJournal>(),
    // Process actions actually performed per operationId.
    readonly performed = new Map<string, number>(),
  ) {
    this.client = new RealtimeTestClient(`${url}/api/v1/agent`);
  }
  frame(type: string, payload: Record<string, unknown>): Frame {
    return {
      protocolVersion: '1',
      type,
      messageId: randomUUID(),
      gameServerId: this.gameServerId,
      occurredAt: new Date().toISOString(),
      payload,
    };
  }
  send(type: string, payload: Record<string, unknown>): Frame {
    const frame = this.frame(type, payload);
    this.client.send(frame);
    return frame;
  }
  async hello(
    key: { credentialId: string; credentialSecret: string },
    capabilities: string[],
    runtime = { gameProcessState: 'RUNNING', skseReady: true },
  ): Promise<void> {
    await this.client.open();
    this.send('HELLO', {
      credentialId: key.credentialId,
      credentialSecret: key.credentialSecret,
      agentVersion: '1.0.0',
      capabilities,
      ...runtime,
    });
    const authenticated = (await this.client.until(
      () =>
        this.client.messages.find((m) => m.type === 'AUTHENTICATED') ??
        (this.client.closed ? { closed: this.client.closed } : undefined),
    )) as Frame;
    if (!authenticated.payload)
      throw new Error(`HELLO refused: ${JSON.stringify(authenticated)}`);
    this.connectionId = authenticated.payload.connectionId as string;
  }
  async heartbeat(
    gameProcessState: string,
    skseReady: boolean,
    capabilities?: string[],
  ): Promise<Frame> {
    const frame = this.send('HEARTBEAT', {
      gameProcessState,
      skseReady,
      ...(capabilities ? { capabilities } : {}),
    });
    return this.reply(frame);
  }
  commands(commandId?: string): Frame[] {
    return this.client.messages.filter(
      (m) =>
        m.type === 'COMMAND' &&
        (!commandId ||
          (m.payload as Frame['payload'])?.commandId === commandId),
    ) as Frame[];
  }
  async command(commandId: string, attempt = 1, timeoutMs = 5000) {
    return this.client.until(
      () =>
        this.commands(commandId).find((m) => m.payload!.attempt === attempt),
      timeoutMs,
    );
  }
  ack(command: Frame, attempt = command.payload!.attempt as number) {
    return this.send('COMMAND_ACK', {
      commandId: command.payload!.commandId,
      correlationId: command.payload!.correlationId,
      attempt,
    });
  }
  result(
    ids: Record<string, unknown>,
    outcome: Record<string, unknown>,
  ): Frame {
    return this.send('COMMAND_RESULT', {
      commandId: ids.commandId,
      correlationId: ids.correlationId,
      ...outcome,
    });
  }
  // Journal-driven execution: runs the effect at most once per commandId
  // and (re)sends the stored result on every delivery.
  execute(
    command: Frame,
    produce: (payload: Record<string, unknown>) => Record<string, unknown>,
  ): Frame {
    const { commandId, payload } = command.payload as {
      commandId: string;
      payload: Record<string, unknown>;
    };
    let entry = this.journal.get(commandId);
    if (!entry) {
      entry = { state: 'RECEIVED' };
      this.journal.set(commandId, entry);
      entry.state = 'FORWARDED';
      this.executions.set(commandId, (this.executions.get(commandId) ?? 0) + 1);
      entry.result = produce(payload);
      entry.state = 'COMPLETED';
    }
    return this.result(command.payload as never, {
      outcome: 'SUCCEEDED',
      result: entry.result,
    });
  }
  controls(operationId?: string): Frame[] {
    return this.client.messages.filter(
      (m) =>
        m.type === 'SERVER_CONTROL' &&
        (!operationId ||
          (m.payload as Frame['payload'])?.operationId === operationId),
    ) as Frame[];
  }
  async control(operationId: string, timeoutMs = 5000): Promise<Frame> {
    return this.client.until(() => this.controls(operationId)[0], timeoutMs);
  }
  controlResult(
    ids: Record<string, unknown>,
    outcome: Record<string, unknown>,
  ): Frame {
    return this.send('SERVER_CONTROL_RESULT', {
      operationId: ids.operationId,
      correlationId: ids.correlationId,
      type: ids.type,
      ...outcome,
    });
  }
  // Journal-driven, at most once per operationId: refuses after notAfter,
  // records EXECUTING before acting, and replays the stored outcome. With
  // report=false it acts and "crashes" before sending the result.
  perform(
    control: Frame,
    outcome: Record<string, unknown> = { outcome: 'SUCCEEDED' },
    report = true,
  ): Frame | undefined {
    const { operationId, notAfter } = control.payload as {
      operationId: string;
      notAfter: string;
    };
    let entry = this.operations.get(operationId);
    if (!entry) {
      entry = { state: 'RECEIVED' };
      this.operations.set(operationId, entry);
      if (Date.now() > Date.parse(notAfter))
        entry.outcome = { outcome: 'FAILED', errorCode: 'DELIVERY_EXPIRED' };
      else {
        entry.state = 'EXECUTING';
        this.performed.set(
          operationId,
          (this.performed.get(operationId) ?? 0) + 1,
        );
        entry.outcome = outcome;
      }
      entry.state = 'COMPLETED';
    }
    return report
      ? this.controlResult(control.payload!, entry.outcome!)
      : undefined;
  }
  // After a reconnect: resend what the journal knows, never re-execute.
  replay(control: Frame): Frame {
    const entry = this.operations.get(control.payload!.operationId as string);
    return this.controlResult(
      control.payload!,
      entry?.state === 'COMPLETED' ? entry.outcome! : { outcome: 'UNCERTAIN' },
    );
  }
  // DOMAIN_EVENT with a durable eventId (reuse it to retry).
  event(
    kind: string,
    data: Record<string, unknown>,
    eventId: string = randomUUID(),
  ): Frame {
    return this.send('DOMAIN_EVENT', { eventId, kind, data });
  }
  async sync(request: Record<string, unknown> = {}): Promise<Frame> {
    return this.reply(this.send('WORK_SYNC', request));
  }
  // Every page of a full WORK_SYNC pass.
  async syncAll(request: Record<string, unknown> = {}): Promise<Frame[]> {
    const pages: Frame[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await this.sync({
        ...request,
        ...(cursor ? { cursor } : {}),
      });
      pages.push(page);
      cursor = page.payload!.nextCursor as string | null;
    } while (cursor);
    return pages;
  }
  pushes(): Frame[] {
    return this.client.messages.filter(
      (m) =>
        m.type === 'WORK_ITEMS' &&
        (m.payload as Frame['payload'])?.inReplyTo === null,
    ) as Frame[];
  }
  reply(frame: Frame, timeoutMs = 5000): Promise<Frame> {
    return this.client.until(
      () =>
        this.client.messages.find(
          (m) => (m.payload as Frame['payload'])?.inReplyTo === frame.messageId,
        ) as Frame | undefined,
      timeoutMs,
    );
  }
  close() {
    return this.client.closed ? this.client.closed : this.client.close();
  }
}

// Simulated durable physical journal, retained across socket reconnects.
// Each transfer is recorded by workId + line before the final event is sent.
export class FakeTradeJournal {
  readonly transfers = new Map<string, Set<number>>();
  readonly effects = new Map<string, number>();
  readonly eventIds = new Map<string, string>();
  fulfill(
    agent: FakeAgent,
    work: { workId: string; data: unknown },
    limit = Infinity,
  ): Frame | undefined {
    const terms = work.data as {
      initiatorItems: unknown[];
      targetItems: unknown[];
    };
    const lines = [...terms.initiatorItems, ...terms.targetItems];
    const done = this.transfers.get(work.workId) ?? new Set<number>();
    this.transfers.set(work.workId, done);
    for (let i = 0; i < lines.length; i++) {
      if (done.has(i)) continue;
      if (limit-- <= 0) return undefined;
      done.add(i);
      const key = `${work.workId}:${i}`;
      this.effects.set(key, (this.effects.get(key) ?? 0) + 1);
    }
    const eventId = this.eventIds.get(work.workId) ?? randomUUID();
    this.eventIds.set(work.workId, eventId);
    return agent.event(
      'TRADE_SETTLEMENT',
      { workId: work.workId, outcome: 'SUCCEEDED' },
      eventId,
    );
  }
}
