import type { LookupAddress } from 'node:dns';
import { lookup as systemLookup } from 'node:dns/promises';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { isIP, type LookupFunction, type Socket } from 'node:net';
import { addressAllowed, bareHost } from '../core/backup-endpoint.js';

/** Every address a name resolves to. */
export type ResolveAll = (hostname: string) => Promise<LookupAddress[]>;

const resolveAll: ResolveAll = (hostname) =>
  systemLookup(hostname, { all: true, order: 'verbatim' });

/** Why the backup service may not connect to `address`, or undefined when it may. */
export function refusal(
  address: string,
  host: string,
  allowPrivate: boolean,
): string | undefined {
  if (addressAllowed(address, allowPrivate)) return undefined;
  const at =
    host === address
      ? `The S3 endpoint ${host} is`
      : `The S3 endpoint ${host} is at ${address},`;
  return addressAllowed(address, true)
    ? `${at} a private or loopback address: allowed only with CCMS_BACKUP_S3_ALLOW_PRIVATE=true.`
    : `${at} an address backups never reach (link-local or a cloud metadata service).`;
}

/** Refused by the guard: names the host and the address, never a credential. */
class BlockedAddressError extends Error {
  readonly code = 'EBLOCKEDADDRESS';
}

/**
 * The `lookup` of the S3 client's connections (#529): resolves the endpoint's host on every
 * connection and refuses it when **any** address it resolves to is one a backup may not reach
 * (`addressAllowed`), so a name that resolves, or rebinds, to a metadata, link-local or (without
 * `allowPrivate`) private address is never connected to. The connection then goes to an address
 * checked: the one answered, never a second lookup.
 */
export function guardedLookup(options: {
  readonly allowPrivate: boolean;
  readonly resolve?: ResolveAll;
}): LookupFunction {
  const resolve = options.resolve ?? resolveAll;
  return (hostname, lookupOptions, callback) => {
    const host = bareHost(hostname);
    const literal = isIP(host);
    const found: Promise<LookupAddress[]> =
      literal !== 0
        ? Promise.resolve([{ address: host, family: literal }])
        : resolve(host);
    found.then(
      (addresses) => {
        if (addresses.length === 0) {
          const error = new Error(
            `${host} resolves to no address.`,
          ) as Error & {
            code: string;
          };
          error.code = 'ENOTFOUND';
          callback(error, '', 0);
          return;
        }
        const refused = addresses.find(
          (a) => !addressAllowed(a.address, options.allowPrivate),
        );
        if (refused) {
          callback(
            new BlockedAddressError(
              refusal(refused.address, host, options.allowPrivate)!,
            ),
            '',
            0,
          );
          return;
        }
        if ((lookupOptions as { all?: boolean }).all) {
          (
            callback as unknown as (
              error: null,
              addresses: LookupAddress[],
            ) => void
          )(null, addresses);
        } else {
          const first = addresses[0]!;
          callback(null, first.address, first.family);
        }
      },
      (error: unknown) =>
        callback(
          error instanceof Error ? error : new Error(String(error)),
          '',
          0,
        ),
    );
  };
}

/**
 * Checks the address a socket actually connected to (`remoteAddress`), on its `connect`, before
 * anything is written: covers what never passes the lookup (an IP literal host, which Node
 * connects to without one).
 */
function guardSocket(
  socket: Socket,
  host: string,
  allowPrivate: boolean,
): Socket {
  // First among the listeners: TLS writes its ClientHello on `connect` too.
  socket.prependOnceListener('connect', () => {
    try {
      const address = socket.remoteAddress;
      const why =
        address === undefined
          ? `The S3 endpoint ${host}: the address connected to is unknown.`
          : refusal(address, host, allowPrivate);
      if (why !== undefined) socket.destroy(new BlockedAddressError(why));
    } catch (error) {
      socket.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  });
  return socket;
}

/**
 * The S3 client's agents (#529): every connection resolves its host through `guardedLookup`,
 * and every socket is checked again on connecting (`guardSocket`), so neither a name nor an IP
 * literal reaches an address backups may not reach.
 */
export function guardedAgents(options: {
  readonly allowPrivate: boolean;
  readonly resolve?: ResolveAll;
}): { httpAgent: HttpAgent; httpsAgent: HttpsAgent } {
  const lookup = guardedLookup(options);
  class GuardedHttpAgent extends HttpAgent {
    override createConnection(
      ...args: Parameters<HttpAgent['createConnection']>
    ): ReturnType<HttpAgent['createConnection']> {
      const socket = super.createConnection(...args) as Socket;
      const host = String((args[0] as { host?: string }).host ?? '');
      return guardSocket(socket, host, options.allowPrivate);
    }
  }
  class GuardedHttpsAgent extends HttpsAgent {
    override createConnection(
      ...args: Parameters<HttpsAgent['createConnection']>
    ): ReturnType<HttpsAgent['createConnection']> {
      const socket = super.createConnection(...args) as Socket;
      const host = String((args[0] as { host?: string }).host ?? '');
      return guardSocket(socket, host, options.allowPrivate);
    }
  }
  return {
    httpAgent: new GuardedHttpAgent({ keepAlive: true, lookup }),
    httpsAgent: new GuardedHttpsAgent({ keepAlive: true, lookup }),
  };
}
