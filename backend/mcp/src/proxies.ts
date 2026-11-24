import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/** How long a proxy's looked-up addresses are kept before they are looked up again. */
export const PROXY_LOOKUP_MS = 10_000;

/** A host name (`editor`, `proxy.internal`): letters, digits and hyphens between dots. */
const HOST_NAME =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

/** `::ffff:10.0.0.2` as `10.0.0.2`: a dual-stack socket's form of an IPv4 peer. */
function plain(address: string): string {
  return address.startsWith('::ffff:') && isIP(address.slice(7)) === 4
    ? address.slice(7)
    : address;
}

/**
 * Why `entry` is no proxy address (`CCMS_MCP_HTTP_PROXY_ADDRESSES`), or
 * undefined: an IP address, a subnet of at least /8 (IPv4) or /16 (IPv6), or
 * a host name, looked up while the server runs.
 */
export function proxyEntryProblem(entry: string): string | undefined {
  const [address = '', prefix, ...rest] = entry.split('/');
  const version = isIP(address);
  if (version === 0) {
    return prefix === undefined && HOST_NAME.test(entry)
      ? undefined
      : `"${entry}" is no address, subnet or host name`;
  }
  if (rest.length > 0) return `"${entry}" is no subnet`;
  if (prefix === undefined) return undefined;
  const bits = /^\d{1,3}$/.test(prefix) ? Number(prefix) : NaN;
  const [least, most] = version === 4 ? [8, 32] : [16, 128];
  return bits >= least && bits <= most
    ? undefined
    : `"${entry}": a subnet from /${least} to /${most}`;
}

/**
 * The peers whose `X-Forwarded-For` the server believes: fixed addresses and
 * subnets, and host names (the editor's service name on a Compose network),
 * looked up again every `PROXY_LOOKUP_MS` so a recreated proxy's new address
 * is found. A name that resolves to nothing (not running yet) trusts nothing
 * until a later lookup finds it: then its requests count by the proxy's own
 * address, never by what they claim.
 */
export class ProxyAddresses {
  readonly #fixed = new BlockList();
  readonly #names: string[] = [];
  #resolved = new Set<string>();
  #at = -Infinity;
  #pending: Promise<void> | undefined;

  constructor(
    entries: readonly string[],
    private readonly resolve: (name: string) => Promise<string[]> = (name) =>
      lookup(name, { all: true }).then((all) => all.map((a) => a.address)),
    private readonly now: () => number = Date.now,
  ) {
    for (const entry of entries) {
      const [address = '', prefix] = entry.split('/');
      const version = isIP(address);
      const type = version === 6 ? 'ipv6' : 'ipv4';
      if (version === 0) this.#names.push(entry);
      else if (prefix === undefined) this.#fixed.addAddress(address, type);
      else this.#fixed.addSubnet(address, Number(prefix), type);
    }
  }

  /** Looks the names up now (once at the start, and when due); never rejects. */
  refresh(): Promise<void> {
    if (this.#names.length === 0) return Promise.resolve();
    this.#pending ??= Promise.all(
      this.#names.map((name) => this.resolve(name).catch(() => [])),
    ).then((lists) => {
      this.#resolved = new Set(lists.flat().map(plain));
      this.#at = this.now();
      this.#pending = undefined;
    });
    return this.#pending;
  }

  /** Whether `address` is one of the proxies (looking the names up again in the background when due). */
  has(address: string): boolean {
    if (this.now() - this.#at >= PROXY_LOOKUP_MS) void this.refresh();
    const peer = plain(address);
    const version = isIP(peer);
    if (version === 0) return false;
    return (
      this.#fixed.check(peer, version === 6 ? 'ipv6' : 'ipv4') ||
      this.#resolved.has(peer)
    );
  }
}
