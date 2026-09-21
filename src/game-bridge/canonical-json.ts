import { BadRequestException } from '@nestjs/common';

// Canonical JSON for already validated command data, also defensive at runtime.
// Sort object keys recursively; array positions remain significant. No toJSON,
// getters, undefined, non-finite numbers or other non-JSON coercions are allowed.
export function canonicalJson(value: unknown, maxBytes = 4096): string {
  const chunks: string[] = [];
  const ancestors = new WeakSet<object>();
  let bytes = 0;
  const append = (chunk: string): void => {
    bytes += Buffer.byteLength(chunk, 'utf8');
    if (bytes > maxBytes)
      throw new BadRequestException('JSON exceeds size limit');
    chunks.push(chunk);
  };
  const invalid = (): never => {
    throw new BadRequestException('Invalid JSON value');
  };
  const visit = (current: unknown, depth: number): void => {
    if (depth > 32) invalid();
    if (
      current === null ||
      typeof current === 'boolean' ||
      typeof current === 'string'
    ) {
      if (typeof current === 'string' && current.length > maxBytes) invalid();
      append(JSON.stringify(current));
      return;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) invalid();
      append(JSON.stringify(current));
      return;
    }
    if (
      typeof current !== 'object' ||
      current === null ||
      ancestors.has(current)
    )
      return invalid();
    const array = Array.isArray(current);
    if (
      !array &&
      Object.getPrototypeOf(current) !== Object.prototype &&
      Object.getPrototypeOf(current) !== null
    )
      invalid();
    const keys = Reflect.ownKeys(current);
    if (keys.length > maxBytes || keys.some((key) => typeof key !== 'string'))
      invalid();
    ancestors.add(current);
    const member = (key: string): void => {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
        return invalid();
      const child: unknown = descriptor.value;
      visit(child, depth + 1);
    };
    if (array) {
      if (keys.length !== current.length + 1) invalid();
      append('[');
      for (let index = 0; index < current.length; index++) {
        if (index) append(',');
        member(String(index));
      }
      append(']');
    } else {
      append('{');
      (keys as string[]).sort().forEach((key, index) => {
        if (index) append(',');
        if (key.length > maxBytes) invalid();
        append(JSON.stringify(key));
        append(':');
        member(key);
      });
      append('}');
    }
    ancestors.delete(current);
  };
  visit(value, 0);
  return chunks.join('');
}
