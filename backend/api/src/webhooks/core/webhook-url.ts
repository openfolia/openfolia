import { BlockList, isIP } from 'node:net';
import { MAX_URL_LENGTH } from './webhook.js';

/**
 * Where deliveries may go: https only, and never to an address that is not
 * on the public internet. Both can be relaxed for local testing only
 * (`CCMS_WEBHOOKS_ALLOW_HTTP`, `CCMS_WEBHOOKS_ALLOW_PRIVATE`).
 */
export interface UrlRules {
  readonly allowHttp: boolean;
  readonly allowPrivate: boolean;
}

/** Why a URL is refused. */
export type UrlProblem =
  | 'not-a-url'
  | 'scheme'
  | 'credentials'
  | 'fragment'
  | 'too-long'
  | 'blocked-address';

/**
 * Addresses no delivery goes to unless `allowPrivate`: everything that is
 * not public unicast (RFC 6890 and the IANA special-purpose registries):
 * "this network", private, carrier-grade NAT, loopback, link-local
 * (cloud metadata services among them), documentation, benchmarking,
 * multicast, reserved and broadcast; for IPv6 also unique-local,
 * link-local, site-local, multicast, discard and the transition ranges,
 * whose embedded IPv4 address is checked as such (`blockedAddress`).
 */
const BLOCKED = (() => {
  const list = new BlockList();
  const v4: [string, number][] = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ];
  for (const [net, prefix] of v4) list.addSubnet(net, prefix, 'ipv4');
  const v6: [string, number][] = [
    ['::', 128],
    ['::1', 128],
    // IPv4-compatible (deprecated) and mapped: the IPv4 part is checked too.
    ['::', 96],
    ['100::', 64],
    ['2001::', 23],
    ['2001:db8::', 32],
    ['fc00::', 7],
    ['fe80::', 10],
    ['fec0::', 10],
    ['ff00::', 8],
    // Local-use NAT64, whose IPv4 part may sit anywhere; SIIT; documentation.
    ['64:ff9b:1::', 48],
    ['::ffff:0:0:0', 96],
    ['3fff::', 20],
  ];
  for (const [net, prefix] of v6) list.addSubnet(net, prefix, 'ipv6');
  return list;
})();

/**
 * Global unicast IPv6 (`2000::/3`), and the NAT64 and mapped forms judged
 * by their IPv4 part: anything else is never public.
 */
const PUBLIC_V6 = (() => {
  const list = new BlockList();
  list.addSubnet('2000::', 3, 'ipv6');
  list.addSubnet('64:ff9b::', 96, 'ipv6');
  list.addSubnet('::ffff:0:0', 96, 'ipv6');
  return list;
})();

/**
 * Whether deliveries may not go to the IP address `address` (either
 * family): not public unicast. An IPv6 address embedding an IPv4 one
 * (mapped `::ffff:a.b.c.d`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`) is
 * judged by the IPv4 address as well. Anything that is not an IP address
 * is blocked: fails closed.
 */
export function blockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return BLOCKED.check(address, 'ipv4');
  if (family !== 6) return true;
  if (BLOCKED.check(address, 'ipv6')) return true;
  if (!PUBLIC_V6.check(address, 'ipv6')) return true;
  const embedded = embeddedIpv4(address);
  return embedded !== undefined && BLOCKED.check(embedded, 'ipv4');
}

/** The IPv4 address an IPv6 one carries (mapped, NAT64, 6to4); undefined when none. */
export function embeddedIpv4(address: string): string | undefined {
  const words = ipv6Words(address);
  if (!words) return undefined;
  const v4 = (hi: number, lo: number) =>
    `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  const zero = (from: number, to: number) =>
    words.slice(from, to).every((w) => w === 0);
  // ::ffff:a.b.c.d
  if (zero(0, 5) && words[5] === 0xffff) return v4(words[6]!, words[7]!);
  // 64:ff9b::a.b.c.d (and the local-use 64:ff9b:1::/48)
  if (words[0] === 0x64 && words[1] === 0xff9b) return v4(words[6]!, words[7]!);
  // 2002:aabb:ccdd::/48
  if (words[0] === 0x2002) return v4(words[1]!, words[2]!);
  return undefined;
}

/** The eight 16-bit words of an IPv6 address (a dotted IPv4 tail allowed). */
function ipv6Words(address: string): number[] | undefined {
  let text = address.split('%')[0] ?? '';
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number) as [
      number,
      number,
      number,
      number,
    ];
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', rest] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = rest === undefined ? [] : rest ? rest.split(':') : [];
  const missing = 8 - left.length - right.length;
  if (rest === undefined ? missing !== 0 : missing < 0) return undefined;
  const words = [...left, ...Array<string>(missing).fill('0'), ...right].map(
    (w) => Number.parseInt(w, 16),
  );
  return words.length === 8 && words.every((w) => w >= 0 && w <= 0xffff)
    ? words
    : undefined;
}

/** A URL host's IP address, without IPv6 brackets; undefined for a name. */
export function hostAddress(hostname: string): string | undefined {
  const bare =
    hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
  return isIP(bare) ? bare : undefined;
}

/**
 * Checks a subscriber's URL against `rules`, without resolving its host
 * (the sender checks every address it resolves to, on every attempt):
 * an absolute `https:` URL (`http:` only with `allowHttp`), no user name or
 * password in it (a secret belongs in the signature), no fragment, at most
 * `MAX_URL_LENGTH` characters, and a host that is not a blocked IP
 * address or `localhost` (unless `allowPrivate`). Answers the URL as
 * parsed (`URL.href`), or the problem.
 */
export function checkWebhookUrl(
  raw: string,
  rules: UrlRules,
): { url: string } | { problem: UrlProblem } {
  if (raw.length > MAX_URL_LENGTH) return { problem: 'too-long' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { problem: 'not-a-url' };
  }
  if (
    url.protocol !== 'https:' &&
    !(rules.allowHttp && url.protocol === 'http:')
  ) {
    return { problem: 'scheme' };
  }
  if (url.username !== '' || url.password !== '') {
    return { problem: 'credentials' };
  }
  if (url.hash !== '' || raw.includes('#')) return { problem: 'fragment' };
  if (url.hostname === '') return { problem: 'not-a-url' };
  if (url.href.length > MAX_URL_LENGTH) return { problem: 'too-long' };
  if (!rules.allowPrivate && localName(url.hostname)) {
    return { problem: 'blocked-address' };
  }
  const address = hostAddress(url.hostname);
  if (address !== undefined && !rules.allowPrivate && blockedAddress(address)) {
    return { problem: 'blocked-address' };
  }
  return { url: url.href };
}

/** Whether a URL's scheme is one `rules` allow (a setting may have changed since it was stored). */
export function allowedScheme(url: URL, rules: UrlRules): boolean {
  return (
    url.protocol === 'https:' || (rules.allowHttp && url.protocol === 'http:')
  );
}

/** Names that always mean this machine or its network, whatever DNS says. */
function localName(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, '');
  return (
    name === 'localhost' ||
    name.endsWith('.localhost') ||
    name.endsWith('.local') ||
    name.endsWith('.internal')
  );
}
