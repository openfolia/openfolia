// Who a request is from: the peer, or the client a trusted proxy names, and the key the limits
// count it by. An IPv6 visitor usually holds a whole /64 or more (an ISP hands out /56 to /48),
// so an IPv6 address counts by its /56.
import { type BlockList, isIPv4, isIPv6 } from 'node:net';

/**
 * The client's address: the peer's, or with `trustProxy` proxies in front, the address the
 * outermost of them saw (that many entries from the right of X-Forwarded-For, which each proxy
 * appends to). Entries left of it are the client's own word and never read. Undefined when the
 * header has fewer entries than proxies trusted, and when the peer is not one of the proxies
 * (`proxies`): then the request did not come through them, and its X-Forwarded-For is anyone's
 * word (a sandbox, say, which shares a network with the launcher).
 */
export function clientAddress(
  peer: string | undefined,
  forwardedFor: string | string[] | undefined,
  trustProxy: number,
  proxies?: BlockList,
): string | undefined {
  if (trustProxy === 0) return normalise(peer);
  const from = normalise(peer);
  if (!from || !proxies?.check(from, isIPv4(from) ? 'ipv4' : 'ipv6'))
    return undefined;
  const header = Array.isArray(forwardedFor)
    ? forwardedFor.join(',')
    : (forwardedFor ?? '');
  const hops = header
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (hops.length < trustProxy) return undefined;
  return normalise(hops[hops.length - trustProxy]);
}

function normalise(address: string | undefined): string | undefined {
  if (!address) return undefined;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const plain = mapped?.[1] ?? address;
  return isIPv4(plain) || isIPv6(plain) ? plain : undefined;
}

/** The key the limits count by: an IPv4 address as it is, an IPv6 address by its /56. */
export function addressKey(address: string): string {
  if (isIPv4(address)) return address;
  const groups = expandIPv6(address);
  const [a, b, c, d = '0000'] = groups;
  return `${a}:${b}:${c}:${d.slice(0, 2)}00::/56`;
}

/** The eight groups of an IPv6 address, each four hex digits, lowercase. */
function expandIPv6(address: string): string[] {
  const [head = '', tail] = address.toLowerCase().split('::');
  const part = (s: string) => (s ? s.split(':') : []);
  let left = part(head);
  let right = tail === undefined ? [] : part(tail);
  // An embedded IPv4 tail (::ffff:1.2.3.4 is handled before; others are rare): two groups.
  const last = right.length ? right : left;
  const v4 = last[last.length - 1];
  if (v4 && v4.includes('.')) {
    const bytes = v4.split('.').map(Number);
    const groups = [
      (((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0)).toString(16),
      (((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)).toString(16),
    ];
    if (right.length) right = [...right.slice(0, -1), ...groups];
    else left = [...left.slice(0, -1), ...groups];
  }
  const missing = 8 - left.length - right.length;
  const all =
    tail === undefined
      ? left
      : [...left, ...Array<string>(Math.max(0, missing)).fill('0'), ...right];
  return all.map((g) => g.padStart(4, '0'));
}
