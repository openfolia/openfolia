import type { Actor } from '../../access/core/actor.js';
import type { DeliveryError, WebhookOwner } from './webhook.js';
import type { UrlRules } from './webhook-url.js';

/**
 * The webhooks' settings (`CCMS_WEBHOOKS_*`): whether they are set up at
 * all (the instance secret key, which seals their secrets), where deliveries may go, how
 * long an attempt may take and how long deliveries are kept.
 */
export abstract class WebhookSettings {
  /** False without an instance secret key (generation turned off, none set): no subscriber can be made, and nothing is delivered. */
  abstract readonly enabled: boolean;
  abstract readonly rules: UrlRules;
  /** One attempt's whole time (connecting, sending, the answer's status line), in ms. */
  abstract readonly timeoutMs: number;
  /** How many days settled deliveries are kept. */
  abstract readonly keepDays: number;
}

/**
 * Port: seals subscribers' secrets for the database and opens them for
 * signing (authenticated encryption under the instance secret key,
 * `SecretSealer`), since a
 * signature needs the secret itself, which a hash would not give back.
 */
export abstract class WebhookSecrets {
  /**
   * The secret, encrypted and authenticated, bound to its subscriber's ID
   * (it opens for that subscriber only); never the same text twice.
   */
  abstract seal(secret: string, webhookId: string): string;

  /**
   * The secret sealed in `sealed` for `webhookId`; throws when it cannot be
   * opened (another key, a changed value, another subscriber's).
   */
  abstract open(sealed: string, webhookId: string): string;

  /**
   * A secret custom header's value (#457), sealed like the secret, bound to
   * its subscriber and to the header's name (in lower case): it opens for
   * that header of that subscriber only.
   */
  abstract sealHeader(value: string, webhookId: string, name: string): string;

  /** The value sealed in `sealed` for that header; throws when it cannot be opened. */
  abstract openHeader(sealed: string, webhookId: string, name: string): string;
}

/** One request to a subscriber. */
export interface OutgoingRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal?: AbortSignal;
}

/** How a request ended: a 2xx answer, or why not. */
export type SendResult =
  | { readonly ok: true; readonly statusCode: number }
  | {
      readonly ok: false;
      readonly error: DeliveryError;
      readonly statusCode: number | null;
    };

/**
 * Port: sends one webhook request. The adapter resolves the host and
 * refuses (`blocked-address`) when any address it resolves to is one
 * `UrlRules` block, then connects to the address it checked (never
 * resolving again, so DNS cannot point it elsewhere in between); follows
 * no redirect; reads no more of the answer than its status line; and
 * gives up after `WebhookSettings.timeoutMs`. Never throws for the
 * receiver's doing; never logs the URL, the headers or the body.
 */
export abstract class WebhookSender {
  abstract send(request: OutgoingRequest): Promise<SendResult>;
}

/**
 * Port: a subscriber's owner as an actor now (a user, or a service
 * account, with their roles); undefined when they no longer act
 * (deleted, deactivated). What a subscriber hears of is what they may read.
 */
export abstract class WebhookOwners {
  abstract find(owner: WebhookOwner): Promise<Actor | undefined>;
}
