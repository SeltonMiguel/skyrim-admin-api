import { BadRequestException } from '@nestjs/common';
import { canonicalJson } from './canonical-json.js';

// Snapshot untrusted data without getters/toJSON and enforce both wire size and
// PostgreSQL jsonb::text size (one space after structural commas/colons).
export function commandJson(value: unknown, maxBytes: number): unknown {
  const json = canonicalJson(value, maxBytes);
  let bytes = Buffer.byteLength(json, 'utf8');
  let quoted = false;
  for (let i = 0; i < json.length; i++) {
    if (quoted && json[i] === '\\') {
      i++;
      continue;
    }
    if (json[i] === '"') quoted = !quoted;
    else if (!quoted && (json[i] === ',' || json[i] === ':')) bytes++;
  }
  if (bytes > maxBytes)
    throw new BadRequestException('JSON exceeds size limit');
  const snapshot: unknown = JSON.parse(json);
  return snapshot;
}
