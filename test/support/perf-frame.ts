import { appendFileSync } from 'node:fs';
// IDs and monotonic timestamps only; never tokens or frame payloads.
export function perfFrame(
  direction: 'received' | 'sent',
  value: unknown,
): void {
  if (!process.env.PERF_TRACE_FILE || !value || typeof value !== 'object')
    return;
  const frame = value as {
    type?: string;
    payload?: { commandId?: string; operationId?: string; attempt?: number };
  };
  if (
    ![
      'COMMAND',
      'COMMAND_ACK',
      'SERVER_CONTROL',
      'SERVER_CONTROL_RESULT',
    ].includes(frame.type ?? '')
  )
    return;
  appendFileSync(
    process.env.PERF_TRACE_FILE,
    JSON.stringify({
      frame: frame.type,
      direction,
      mono: performance.now(),
      wall: Date.now(),
      id: frame.payload?.commandId ?? frame.payload?.operationId,
      attempt: frame.payload?.attempt,
    }) + '\n',
  );
}
