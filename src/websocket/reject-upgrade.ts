import type { Duplex } from 'node:stream';

// Refuses a WebSocket upgrade with a plain HTTP status before any WebSocket
// state is created (no body: nothing about the reason leaks beyond the code).
export function rejectUpgrade(
  socket: Duplex,
  status: 403 | 429 | 503,
  retryAfterSeconds?: number,
): void {
  const text = {
    403: 'Forbidden',
    429: 'Too Many Requests',
    503: 'Service Unavailable',
  }[status];
  const retry = retryAfterSeconds
    ? `Retry-After: ${retryAfterSeconds}\r\n`
    : '';
  socket.write(
    `HTTP/1.1 ${status} ${text}\r\n${retry}Connection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}
