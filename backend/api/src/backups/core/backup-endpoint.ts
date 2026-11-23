import { BlockList, isIP } from 'node:net';
import {
  blockedAddress,
  embeddedIpv4,
} from '../../webhooks/core/webhook-url.js';

/**
 * Addresses a backup never reaches, whatever the settings: link-local (the cloud metadata
 * services among them: 169.254.169.254, fd00:ec2::254), "this network" and the unspecified
 * address. An IPv6 address carrying an IPv4 one (mapped, NAT64, 6to4) is judged by that too.
 */
const NEVER = (() => {
  const list = new BlockList();
  list.addSubnet('0.0.0.0', 8, 'ipv4');
  list.addSubnet('169.254.0.0', 16, 'ipv4');
  list.addAddress('::', 'ipv6');
  list.addSubnet('fe80::', 10, 'ipv6');
  list.addAddress('fd00:ec2::254', 'ipv6');
  // Local-use NAT64, whose IPv4 part may sit at any offset: never reached at all.
  list.addSubnet('64:ff9b:1::', 48, 'ipv6');
  return list;
})();

/** Names of cloud metadata services. */
const NEVER_NAMES = new Set(['metadata', 'metadata.google.internal']);

/** A URL's host as an address or name: no IPv6 brackets, no zone, no trailing dots, lower case. */
export function bareHost(hostname: string): string {
  const bracketed = hostname.startsWith('[') && hostname.endsWith(']');
  const host = bracketed ? hostname.slice(1, -1) : hostname;
  return host.split('%')[0]!.replace(/\.+$/, '').toLowerCase();
}

/** Whether `address` (an IP address of either family) is one a backup never reaches. */
export function neverReached(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return NEVER.check(address, 'ipv4');
  if (family !== 6) return true;
  if (NEVER.check(address, 'ipv6')) return true;
  const embedded = embeddedIpv4(address) ?? compatibleIpv4(address);
  return embedded !== undefined && NEVER.check(embedded, 'ipv4');
}

/** The IPv4 part of a (deprecated) IPv4-compatible address `::a.b.c.d`; not `::` or `::1`. */
function compatibleIpv4(address: string): string | undefined {
  let normal: string;
  try {
    normal = new URL(`http://[${address.split('%')[0]}]`).hostname.slice(1, -1);
  } catch {
    return undefined;
  }
  const match = /^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normal);
  if (!match) return undefined;
  const hi = Number.parseInt(match[1]!, 16);
  const lo = Number.parseInt(match[2]!, 16);
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/**
 * Whether the backup service may connect to `address`: never to one `neverReached` names, and
 * to a private, loopback or other non-public one only with `allowPrivate`
 * (`CCMS_BACKUP_S3_ALLOW_PRIVATE`, for an S3 server on the same network). The address ranges
 * are the webhooks' (`blockedAddress`). Anything that is no IP address is refused.
 */
export function addressAllowed(
  address: string,
  allowPrivate: boolean,
): boolean {
  if (neverReached(address)) return false;
  return allowPrivate || !blockedAddress(address);
}

/**
 * Why `endpoint` cannot be an S3 endpoint, or undefined: an http or https URL, without
 * credentials, query or fragment, whose host is no metadata name and no address a backup never
 * reaches. With `allowPrivate` given, an IP literal host must be `addressAllowed` too (Node
 * connects to a literal without a lookup). A name is checked by the backup service on every
 * connection (`guardedAgents`), against every address the name resolves to then.
 */
export function endpointProblem(
  endpoint: string,
  allowPrivate?: boolean,
): string | undefined {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return 'Not a URL.';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'An S3 endpoint is an http or https URL.';
  }
  if (url.username || url.password) {
    return 'An S3 endpoint holds no user name or password: give the access key instead.';
  }
  if (url.search || url.hash) return 'An S3 endpoint has no query or fragment.';
  const host = bareHost(url.hostname);
  if (host === '') return 'Not a URL.';
  if (NEVER_NAMES.has(host) || (isIP(host) !== 0 && neverReached(host))) {
    return 'An S3 endpoint is no link-local or cloud metadata address.';
  }
  if (
    allowPrivate !== undefined &&
    isIP(host) !== 0 &&
    !addressAllowed(host, allowPrivate)
  ) {
    return 'An S3 endpoint on a private or loopback address needs CCMS_BACKUP_S3_ALLOW_PRIVATE=true on the backup service.';
  }
  return undefined;
}

/**
 * Where the backup service's heartbeat reports `CCMS_BACKUP_S3_ALLOW_PRIVATE`, among its
 * overrides (no setting the page shows, so the settings' overrides leave it out).
 */
export const S3_ALLOW_PRIVATE = 's3.allowPrivate';

/** Whether the reported overrides say `CCMS_BACKUP_S3_ALLOW_PRIVATE=true`; false otherwise. */
export function reportedAllowPrivate(reported: unknown): boolean {
  if (typeof reported !== 'object' || reported === null) return false;
  const entry = (reported as Record<string, unknown>)[S3_ALLOW_PRIVATE];
  return (
    typeof entry === 'object' &&
    entry !== null &&
    (entry as { value?: unknown }).value === true
  );
}
