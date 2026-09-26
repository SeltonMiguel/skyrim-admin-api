// Central log redaction (12.3). Applied by AppLogger to every message,
// field and stack, whatever the caller did. Keys that name a secret are
// masked (identifiers ending in "Id" are kept: credentialId is not a
// secret); values that look like a token, a bearer header, a PEM block or a
// URL with a password are masked wherever they appear.
export const REDACTED = '[REDACTED]';
const SECRET_KEY =
  /pass(word|wd|phrase)?|secret|token|authorization|cookie|challenge|private.?key|certificate|\bca\b|api.?key|connection.?string|dsn|signature|hash/i;
const PATTERNS: [RegExp, string][] = [
  // JWT (three base64url segments).
  [/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}\b/g, REDACTED],
  // Authorization header values.
  [/\b(Bearer|Basic)\s+[\w.~+/=-]{6,}/gi, `$1 ${REDACTED}`],
  // PEM blocks (certificates, keys).
  [/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, REDACTED],
  // user:password@ in URLs.
  [/(\b[a-z][\w+.-]*:\/\/[^:/\s@]+:)[^@\s/]+@/gi, `$1${REDACTED}@`],
  // key=value pairs that name a secret, inside free text.
  [
    /\b([\w-]*(?:password|secret|token|challenge|authorization)[\w-]*)=([^\s\]]+)/gi,
    `$1=${REDACTED}`,
  ],
];
export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key) && !/(Id|Ids|_id|Count|Length)$/.test(key);
}
export function redactText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS)
    out = out.replace(pattern, replacement);
  return out;
}
// Deep copy with secret keys masked and string values scrubbed; bounded
// depth and size so a large object can never blow up a log line.
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value).slice(0, 4096);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 6) return '[TRUNCATED]';
  if (Array.isArray(value))
    return value.slice(0, 50).map((item) => redactValue(item, depth + 1));
  if (value instanceof Error)
    return { name: value.name, message: redactText(value.message) };
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 50))
    out[key] = isSecretKey(key) ? REDACTED : redactValue(item, depth + 1);
  return out;
}
