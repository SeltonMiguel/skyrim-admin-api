import { parseTrustProxy, resolveClientIp } from './client-ip.js';

describe('Client IP behind proxies (12.1)', () => {
  const spoofed = '6.6.6.6';
  it('ignores X-Forwarded-For when no proxy is trusted', () => {
    const trust = parseTrustProxy('false');
    expect(resolveClientIp('203.0.113.9', spoofed, trust)).toBe('203.0.113.9');
    expect(resolveClientIp('::ffff:203.0.113.9', undefined, trust)).toBe(
      '203.0.113.9',
    );
  });
  it('uses the address appended by a trusted proxy, never the client-chosen prefix', () => {
    const trust = parseTrustProxy('loopback');
    expect(
      resolveClientIp('127.0.0.1', `${spoofed}, 198.51.100.7`, trust),
    ).toBe('198.51.100.7');
    // An untrusted peer cannot claim a forwarded address.
    expect(resolveClientIp('198.51.100.7', spoofed, trust)).toBe(
      '198.51.100.7',
    );
  });
  it('walks a chain of trusted proxies by CIDR or hop count', () => {
    const cidr = parseTrustProxy('10.0.0.0/8,127.0.0.1');
    expect(
      resolveClientIp('127.0.0.1', `${spoofed}, 198.51.100.7, 10.1.2.3`, cidr),
    ).toBe('198.51.100.7');
    const hops = parseTrustProxy('2');
    expect(
      resolveClientIp('127.0.0.1', `${spoofed}, 198.51.100.7, 10.1.2.3`, hops),
    ).toBe('198.51.100.7');
    expect(
      resolveClientIp('127.0.0.1', '198.51.100.7', parseTrustProxy('1')),
    ).toBe('198.51.100.7');
    expect(parseTrustProxy('uniquelocal')('fd00::1', 0)).toBe(true);
    expect(parseTrustProxy('uniquelocal')('8.8.8.8', 0)).toBe(false);
  });
  it('refuses trust-everything and malformed values', () => {
    for (const value of ['true', 'all', '10.0.0.0/40', 'a.b.c.d', '33'])
      expect(() => parseTrustProxy(value)).toThrow('TRUST_PROXY');
  });
});
