import type { AuditMetadata } from './audit.types.js';

// Defense in depth. Callers must still construct metadata explicitly; never pass
// request bodies, headers, DTOs, entities, error objects or token responses.
const sensitiveKey =
  /password|passwd|pwd|token|secret|authorization|cookie|credential|privatekey|apikey|connectionstring|databaseurl|hash|headers|requestbody/;
const databaseKey =
  /^(?:db|database)(?:host|port|user|username|name|database|url)?$/;
const unsafeKeys = new Set(['body', 'constructor', 'prototype', '__proto__']);
export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };

export function sanitizeMetadata(
  metadata?: AuditMetadata,
): Record<string, Json> | null {
  if (!metadata) return null;
  const seen = new WeakSet<object>();
  const clean = (value: unknown, depth: number): Json => {
    if (depth > 6) return null;
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') return value.slice(0, 512);
    if (typeof value !== 'object' || seen.has(value)) return null;
    seen.add(value);
    if (Array.isArray(value))
      return value.slice(0, 50).map((entry) => clean(entry, depth + 1));
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      return null;
    const result: Record<string, Json> = {};
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(value),
    ).slice(0, 50)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (
        key.length > 100 ||
        unsafeKeys.has(key.toLowerCase()) ||
        sensitiveKey.test(normalized) ||
        databaseKey.test(normalized) ||
        !('value' in descriptor)
      )
        continue;
      result[key] = clean(descriptor.value, depth + 1);
    }
    return result;
  };
  const sanitized = clean(metadata, 0);
  // Bound storage and response sizes; do not serialize the original input.
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized))
    return null;
  return Buffer.byteLength(JSON.stringify(sanitized), 'utf8') <= 8192
    ? sanitized
    : null;
}
