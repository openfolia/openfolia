import { isIP, isIPv4, isIPv6 } from 'node:net';
import type { Request } from 'express';

/** An IPv4 address mapped into IPv6 (`::ffff:192.0.2.1`), as a dual-stack socket reports one. */
const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** The eight 16-bit groups of an IPv6 address (no zone), embedded IPv4 included. */
const groupsOf = (address: string): number[] | undefined => {
  let text = address;
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (v4?.[1] !== undefined) {
    const [a = 0, b = 0, c = 0, d = 0] = v4[1].split('.').map(Number);
    text = `${text.slice(0, -v4[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const part = (half: string | undefined) =>
    half === undefined || half === '' ? [] : half.split(':');
  const head = part(halves[0]);
  const tail = part(halves[1]);
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return undefined;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail].map(
    (group) => Number.parseInt(group, 16),
  );
  return groups.some((group) => Number.isNaN(group)) ? undefined : groups;
};

/** An IPv4 address of two 16-bit groups. */
const ipv4Of = (high: number, low: number) =>
  [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');

/**
 * The IPv4 address an IPv6 address stands for, if it is one of the forms that embed one: mapped
 * (`::ffff:a.b.c.d`, any spelling), NAT64 (`64:ff9b::/96`), 6to4 (`2002::/16`) and Teredo
 * (`2001::/32`, the client's address inverted in the last 32 bits). One IPv4 host has many
 * such IPv6 addresses, so each is keyed by that host.
 */
const embeddedIpv4 = (g: readonly number[]): string | undefined => {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  if ([g0, g1, g2, g3, g4].every((x) => x === 0) && g5 === 0xffff)
    return ipv4Of(g6, g7);
  if (g0 === 0x64 && g1 === 0xff9b && [g2, g3, g4, g5].every((x) => x === 0))
    return ipv4Of(g6, g7);
  if (g0 === 0x2002) return ipv4Of(g1, g2);
  if (g0 === 0x2001 && g1 === 0) return ipv4Of(g6 ^ 0xffff, g7 ^ 0xffff);
  return undefined;
};

/**
 * How wide a key an IPv6 client gets: `/64` (one host's network) for the limit on failed
 * authentications, which locks a key out, so a key must not hold other people's addresses;
 * `/56` (the block a provider commonly hands one home or site) for the anonymous reads under
 * `/d/`, where a shared budget only slows a neighbour down; `/48` (a whole site) for `networkAddress`.
 */
export type Ipv6Prefix = 48 | 56 | 64;

/**
 * The key of a client's address for a rate limit: an IPv4 address as it is, an IPv6 address
 * that embeds an IPv4 one (mapped, NAT64, 6to4, Teredo) as that IPv4 address, any other IPv6
 * address by its `prefix`, so a client cannot step around a limit by taking the next address
 * of its own block. Anything else (no address at all) as it is.
 */
export const addressKey = (ip: string, prefix: Ipv6Prefix): string => {
  const mapped = MAPPED_V4.exec(ip)?.[1];
  if (mapped !== undefined && isIPv4(mapped)) return mapped;
  const address = ip.split('%')[0] ?? ip;
  if (!isIPv6(address)) return ip;
  const groups = groupsOf(address);
  if (!groups) return ip;
  const embedded = embeddedIpv4(groups);
  if (embedded !== undefined) return embedded;
  const kept = groups.slice(0, prefix === 48 ? 3 : 4);
  if (prefix === 56) kept[3] = (kept[3] ?? 0) & 0xff00;
  return `${kept.map((group) => group.toString(16)).join(':')}::/${prefix}`;
};

/**
 * The client's address, as a key for a limit that counts per client (`addressKey`): `req.ip`,
 * which is the connection's address unless `CCMS_TRUST_PROXY` names the proxies in front (so a
 * client's own `X-Forwarded-For` changes nothing). Failed authentications key by `/64`, the
 * stable addresses' rate limit (#574) by `/56`.
 */
export const clientAddress = (req: Request, prefix: Ipv6Prefix): string =>
  addressKey(req.ip ?? req.socket.remoteAddress ?? 'unknown', prefix);

/**
 * The client's network, as a key for a limit on what many addresses of one network do together
 * (#965): an IPv4 address by its /24, an IPv6 one by its /48 (`addressKey`, so one that embeds an
 * IPv4 address counts as that address's /24).
 */
export const networkAddress = (req: Request): string => {
  const host = (req.ip ?? req.socket.remoteAddress ?? '').split('%')[0] ?? '';
  // Anything that is no address (a proxy's header passed on as it is): one bucket, never a key or a log line of its own.
  if (!isIP(host)) return 'unknown';
  const key = addressKey(host, 48);
  return isIPv4(key) ? key.replace(/\.\d+$/, '.0/24') : key;
};
