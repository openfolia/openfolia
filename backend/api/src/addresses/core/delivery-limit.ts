import type { Actor } from '../../access/core/actor.js';
import { TooManyRequestsError } from '../../base/core/errors.js';
import { SlidingWindowLimit } from '../../base/core/rate-limit.js';

/**
 * Who asks a stable address, for its rate limit: a request with a token by its actor (so
 * signed-in readers never share the anonymous budget), one without by the client's address
 * (as the API sees it after `CCMS_TRUST_PROXY`).
 */
export type DeliveryClient =
  { readonly actor: Actor } | { readonly address: string };

const keyOf = (client: DeliveryClient): string =>
  'actor' in client
    ? `actor:${client.actor.kind}:${client.actor.id}`
    : `address:${client.address}`;

/**
 * The stable addresses' rate limit (#574): at most `perMinute` of the answers that make the
 * server work (a page rendered, a PDF streamed, a QR code drawn) per client and minute, on
 * this server (`SlidingWindowLimit`). `perMinute` 0 limits nothing. `check` refuses a client
 * already past it before anything is read; `take` counts one answer, once it is known to need
 * the work (a 304 revalidation counts nothing). Both throw `TooManyRequestsError`
 * (429 `rate-limited`, `Retry-After`).
 */
export class DeliveryLimit {
  private readonly window: SlidingWindowLimit | undefined;

  constructor(perMinute: number, now: () => number = Date.now) {
    this.window =
      perMinute > 0 ? new SlidingWindowLimit(perMinute, now) : undefined;
  }

  /** Refuses a client with nothing left this minute; counts nothing. */
  check(client: DeliveryClient): void {
    const wait = this.window?.retryAfter(keyOf(client));
    if (wait !== undefined) throw limited(wait);
  }

  /** Counts one answer for the client; refuses it when nothing is left this minute. */
  take(client: DeliveryClient): void {
    const taken = this.window?.take(keyOf(client));
    if (taken && !taken.ok) throw limited(taken.retryAfterSeconds);
  }
}

const limited = (retryAfterSeconds: number) =>
  new TooManyRequestsError(
    'Too many requests for stable addresses from this client this minute; try again later.',
    retryAfterSeconds,
  );
