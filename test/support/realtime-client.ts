// Minimal test client over Node's built-in WebSocket (no extra dependency).
export class RealtimeTestClient {
  readonly messages: Record<string, unknown>[] = [];
  closed: { code: number; reason: string } | null = null;
  opened = false;
  private readonly socket: WebSocket;
  private waiters: (() => void)[] = [];
  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.addEventListener('open', () => {
      this.opened = true;
      this.wake();
    });
    this.socket.addEventListener('message', (event) => {
      this.messages.push(JSON.parse(String(event.data)));
      this.wake();
    });
    this.socket.addEventListener('close', (event) => {
      this.closed = { code: event.code, reason: event.reason };
      this.wake();
    });
    this.socket.addEventListener('error', () => this.wake());
  }
  private wake() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }
  async until<T>(
    check: () => T | undefined | false,
    timeoutMs = 3000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = check();
      if (value) return value;
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error('Timed out waiting for realtime state');
      await new Promise<void>((resolve) => {
        // Poll too: server-side state (e.g. the registry) does not wake us.
        const timer = setTimeout(resolve, Math.min(remaining, 25));
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
  send(value: unknown) {
    this.socket.send(typeof value === 'string' ? value : JSON.stringify(value));
  }
  async open() {
    await this.until(() => this.opened || this.closed);
    if (!this.opened) throw new Error('Socket did not open');
  }
  async authenticate(surface: 'PLAYER' | 'STAFF', token: string) {
    await this.open();
    this.send({ type: 'AUTH', surface, token });
    return this.until(
      () =>
        this.messages.find((m) => m.type === 'AUTHENTICATED') ??
        (this.closed ? { closed: this.closed } : undefined),
    );
  }
  closedWith(timeoutMs?: number) {
    return this.until(() => this.closed ?? undefined, timeoutMs);
  }
  event(type: string, timeoutMs?: number) {
    return this.until(
      () => this.messages.find((m) => m.type === type),
      timeoutMs,
    );
  }
  events() {
    return this.messages.filter((m) => m.type !== 'AUTHENTICATED');
  }
  close() {
    this.socket.close(1000);
    return this.closedWith();
  }
}
