import { BlockList, isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

// One proxy trust policy for HTTP (Express `trust proxy`) and for WebSocket
// upgrades, so rate limits, Audit and security logs see the same client IP.
// TRUST_PROXY accepts:
//   false            no proxy is trusted; X-Forwarded-For is ignored (default)
//   <n>              trust the n closest hops (n ≥ 1)
//   list             comma-separated loopback, linklocal, uniquelocal,
//                    IPv4/IPv6 addresses and CIDRs (e.g. 10.0.0.0/8)
// `true` (trust everything) is deliberately not accepted: any client could
// then choose its own address.
export type TrustProxy = (address: string, hop: number) => boolean;

const NAMED: Record<string, readonly string[]> = {
  loopback: ['127.0.0.0/8', '::1/128'],
  linklocal: ['169.254.0.0/16', 'fe80::/10'],
  uniquelocal: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
};

// IPv4-mapped IPv6 (::ffff:1.2.3.4) is compared as IPv4.
export function normalizeAddress(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return mapped ? mapped[1] : address;
}
function add(list: BlockList, entry: string): boolean {
  const [address, bits, extra] = entry.split('/');
  const family = isIP(address);
  if (!family || extra !== undefined) return false;
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (bits === undefined) {
    list.addAddress(address, type);
    return true;
  }
  const prefix = Number(bits);
  if (!/^\d+$/.test(bits) || prefix > (family === 4 ? 32 : 128)) return false;
  list.addSubnet(address, prefix, type);
  return true;
}
// Throws on an invalid value (validated at startup).
export function parseTrustProxy(raw: string): TrustProxy {
  const value = raw.trim().toLowerCase();
  if (value === '' || value === 'false' || value === '0') return () => false;
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (hops > 32) throw new Error('Invalid TRUST_PROXY');
    return (_address, hop) => hop < hops;
  }
  const list = new BlockList();
  for (const entry of value.split(',').map((item) => item.trim())) {
    const ranges = NAMED[entry] ?? [entry];
    for (const range of ranges)
      if (!add(list, range)) throw new Error('Invalid TRUST_PROXY');
  }
  return (address) => {
    const normalized = normalizeAddress(address);
    const family = isIP(normalized);
    return !!family && list.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
  };
}
// Same walk as Express/proxy-addr: from the socket peer towards the client,
// stop at the first address that is not a trusted proxy.
export function resolveClientIp(
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trust: TrustProxy,
): string {
  const header = Array.isArray(forwardedFor)
    ? forwardedFor.join(',')
    : (forwardedFor ?? '');
  const chain = [
    normalizeAddress(remoteAddress ?? 'unknown'),
    ...header
      .split(',')
      .map((item) => normalizeAddress(item.trim()))
      .filter(Boolean)
      .reverse(),
  ];
  for (let hop = 0; hop < chain.length - 1; hop++)
    if (!trust(chain[hop], hop)) return chain[hop];
  return chain[chain.length - 1];
}
export function requestClientIp(
  request: IncomingMessage,
  trust: TrustProxy,
): string {
  return resolveClientIp(
    request.socket.remoteAddress,
    request.headers['x-forwarded-for'],
    trust,
  );
}
