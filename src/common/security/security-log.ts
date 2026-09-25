import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

type Field = string | number | boolean | null | undefined;

// Structured security events (12.1): throttling, refresh reuse, connection
// caps, RBAC metadata failures. Values are identifiers only and are
// sanitized against log injection. Never pass passwords, tokens, secrets,
// challenges or raw credentials: identifiers that are personal (usernames)
// go through fingerprint().
@Injectable()
export class SecurityLog {
  private readonly logger = new Logger('Security');
  warn(event: string, fields: Record<string, Field> = {}): void {
    this.logger.warn(format(event, fields));
  }
  error(event: string, fields: Record<string, Field> = {}): void {
    this.logger.error(format(event, fields));
  }
}
// Short, non-reversible correlation id for a personal identifier.
export function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
export function format(event: string, fields: Record<string, Field>): string {
  const pairs = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${clean(String(value))}`);
  return `${clean(event)} [${pairs.join(' ')}]`;
}
const clean = (value: string) =>
  value.slice(0, 128).replace(/[^\w.:@/-]/g, '_');
