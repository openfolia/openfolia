import { BlockList, isIP } from 'node:net';
import { z } from 'zod';

/** The most hops `CCMS_TRUST_PROXY` may name, and the most addresses or subnets. */
export const MAX_TRUST_PROXY_HOPS = 10;
export const MAX_TRUST_PROXY_ENTRIES = 100;

/** The address ranges Express names: `127.0.0.0/8` and `::1`; `169.254.0.0/16` and `fe80::/10`; the private ranges and `fc00::/7`. */
const NAMED = ['loopback', 'linklocal', 'uniquelocal'] as const;

/**
 * Express's `trust proxy`: `false` (trust no proxy: `req.ip` is the socket's address), a hop
 * count, or the addresses and subnets of the proxies to trust.
 */
export type TrustProxy = false | number | readonly string[];

/** IPv4 addresses mapped into IPv6 (`::ffff:0:0/96`), however they are written. */
const MAPPED = new BlockList();
MAPPED.addSubnet('::ffff:0:0', 96, 'ipv6');

/** An address (`10.0.0.2`, `::1`), a subnet (`172.16.0.0/12`, `fd00::/16`) or a named range. */
const isProxyEntry = (entry: string): boolean => {
  if ((NAMED as readonly string[]).includes(entry)) return true;
  const [address = '', prefix, ...rest] = entry.split('/');
  if (rest.length > 0) return false;
  const version = isIP(address);
  if (version === 0) return false;
  if (prefix === undefined) return true;
  // A mapped IPv4 address (`::ffff:10.0.0.1`) only as one address: Express takes its ranges
  // as IPv4 ones (`::ffff:0:0/96` as every address) or not at all.
  if (version === 6 && MAPPED.check(address, 'ipv6')) return false;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  // At least a /8 (IPv4) or a /16 (IPv6): `0.0.0.0/0` would trust every hop, as `true` would.
  const bits = Number(prefix);
  return version === 4 ? bits >= 8 && bits <= 32 : bits >= 16 && bits <= 128;
};

/**
 * `CCMS_TRUST_PROXY` (#574): which proxies in front of the API to believe about the client's
 * address (`X-Forwarded-For`), for the limits keyed by it (the stable addresses' rate limit,
 * failed authentications). `none` (the default) trusts none: the client is the socket's
 * address, and a forged header changes nothing. A whole number from 1 trusts that many hops
 * nearest the API, whoever they are, so only where nothing else can reach the API. Otherwise
 * comma-separated addresses, subnets (`172.16.0.0/12`; at least a /8, or a /16 for IPv6) or
 * `loopback`, `linklocal`, `uniquelocal`. `true` or a subnet of everything (trust every hop, so
 * any client could name any address) is refused.
 */
export const trustProxy = z
  .string()
  .trim()
  .transform((value, ctx): TrustProxy => {
    if (value.toLowerCase() === 'none') return false;
    if (/^\d+$/.test(value)) {
      const hops = Number(value);
      if (hops < 1 || hops > MAX_TRUST_PROXY_HOPS) {
        ctx.addIssue({
          code: 'custom',
          message: `a hop count must be from 1 to ${MAX_TRUST_PROXY_HOPS} (none: trust no proxy)`,
        });
        return z.NEVER;
      }
      return hops;
    }
    const entries = value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
    if (entries.length === 0 || entries.length > MAX_TRUST_PROXY_ENTRIES) {
      ctx.addIssue({
        code: 'custom',
        message: `must be none, a hop count, or 1 to ${MAX_TRUST_PROXY_ENTRIES} addresses or subnets`,
      });
      return z.NEVER;
    }
    const bad = entries.find((entry) => !isProxyEntry(entry));
    if (bad !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message:
          'must be none, a hop count, or comma-separated IP addresses, subnets (10.0.0.0/8) or loopback, linklocal, uniquelocal',
      });
      return z.NEVER;
    }
    return entries;
  });
