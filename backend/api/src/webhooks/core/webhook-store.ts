import type { PageRequest, Paginated } from '../../base/core/paging.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import type {
  Delivery,
  DeliveryError,
  DeliveryFilter,
  DeliveryStatus,
  DeliverySummary,
  DeliveryTarget,
  NewDelivery,
  NewWebhook,
  Webhook,
  WebhookChanges,
  WebhookEvent,
  WebhookOwner,
} from './webhook.js';
import type { StoredHeader } from './webhook-headers.js';

/**
 * Which subscribers a list holds: every one, or those of `owner` and, with
 * `orWithout`, also those not subscribed to that event.
 */
export type WebhookVisibility =
  'all' | { readonly owner: WebhookOwner; readonly orWithout?: WebhookEvent };

/** A claim to send: its token, or when to try again. */
export type SendClaim = { readonly token: Date } | { readonly retryAt: Date };

/** How an attempt ended, as recorded on its delivery. */
export interface AttemptRecord {
  readonly at: Date;
  /** The receiver's status code, when it answered. */
  readonly statusCode: number | null;
  readonly error: DeliveryError | null;
  /** `pending`: another attempt follows; anything else settles the delivery. */
  readonly status: Exclude<DeliveryStatus, 'skipped'>;
  /** The names of the headers sent, never a value; null when nothing was sent. */
  readonly sentHeaders: readonly string[] | null;
}

/**
 * Port: subscribers (`webhooks`) and their deliveries
 * (`webhook_deliveries`). Secrets are only ever stored sealed
 * (`WebhookSecrets`), and only `target` and `storedHeaders` read them
 * back.
 */
export abstract class WebhookStore {
  /** One page of the subscribers `visible` lets through, oldest first. */
  abstract list(
    page: PageRequest,
    visible: WebhookVisibility,
  ): Promise<Paginated<Webhook>>;

  /** One subscriber; undefined when there is none. Inside `tx` when given (and locked for it). */
  abstract find(id: string, tx?: Transaction): Promise<Webhook | undefined>;

  /**
   * The custom headers of `id` (which exists) as stored, secret values
   * sealed, inside `tx` (which holds it locked, `find`): for changing them.
   */
  abstract storedHeaders(
    tx: Transaction,
    id: string,
  ): Promise<readonly StoredHeader[]>;

  /**
   * Adds a subscriber, unless there are `max` already (undefined then):
   * counted under a lock, so two requests at once never pass the limit.
   */
  abstract insert(
    tx: Transaction,
    webhook: NewWebhook,
    max: number,
  ): Promise<Webhook | undefined>;

  /** Changes the subscriber `id` (which exists); `active: true` also clears its disabled state and failure count. */
  abstract update(
    tx: Transaction,
    id: string,
    changes: WebhookChanges,
  ): Promise<Webhook>;

  /** Deletes a subscriber and its deliveries; false when there was none. */
  abstract delete(tx: Transaction, id: string): Promise<boolean>;

  /**
   * Replaces the secret of `id` (which exists) with `sealed`; the current
   * one becomes the previous, signing beside it until `previousUntil`.
   */
  abstract rotateSecret(
    tx: Transaction,
    id: string,
    sealed: string,
    previousUntil: Date,
  ): Promise<Webhook>;

  /** Every active subscriber, oldest first (at most `MAX_WEBHOOKS`). */
  abstract active(): Promise<Webhook[]>;

  /** A subscriber with its sealed secrets, for delivering; undefined when there is none. */
  abstract target(id: string): Promise<DeliveryTarget | undefined>;

  /**
   * Adds deliveries; one whose subscriber and idempotency key are taken
   * already (the same event read again), or whose subscriber is gone, is
   * left out. Answers the IDs of those added.
   */
  abstract addDeliveries(
    tx: Transaction,
    deliveries: readonly NewDelivery[],
  ): Promise<string[]>;

  /** The latest delivery of each of these subscribers that has one (none of a body). */
  abstract lastDeliveries(
    webhookIds: readonly string[],
  ): Promise<ReadonlyMap<string, DeliverySummary>>;

  /** One delivery; undefined when there is none. */
  abstract delivery(id: string): Promise<Delivery | undefined>;

  /** One page of a subscriber's deliveries, newest first. */
  abstract listDeliveries(
    webhookId: string,
    filter: DeliveryFilter,
    page: PageRequest,
  ): Promise<Paginated<Delivery>>;

  /**
   * Records an attempt on a delivery still `pending` (compare-and-swap):
   * one more attempt, its time, status code and error, and its new status
   * (`deliveredAt` too for `succeeded`). False when it was not pending
   * (settled meanwhile): nothing is written.
   */
  abstract recordAttempt(
    tx: Transaction,
    id: string,
    attempt: AttemptRecord,
  ): Promise<boolean>;

  /**
   * Puts a `failed` delivery back to `pending` (compare-and-swap), for a
   * retry by hand: its attempts so far stay counted. Answers its
   * put-offs so far (the next job's `deferrals`), or undefined when it was
   * not `failed` (nothing is written).
   */
  abstract requeue(
    tx: Transaction,
    id: string,
  ): Promise<{ readonly deferrals: number } | undefined>;

  /** Settles a pending delivery as `skipped` (not sent); false when it was not pending. */
  abstract skip(tx: Transaction, id: string): Promise<boolean>;

  /**
   * Settles as `skipped` every pending delivery of a subscriber made for an
   * owner other than `owner`, or under another audience limit than
   * `maxAudience` (its owner or its limit changed). Answers how many.
   */
  abstract skipPendingNotFor(
    tx: Transaction,
    webhookId: string,
    owner: WebhookOwner,
    maxAudience: string | null,
  ): Promise<number>;

  /**
   * Claims the one attempt in flight a subscriber may have, for `sendMs`,
   * judged by the database's clock: refused while another attempt to it
   * holds its claim, while it waits after a failure, or while its owner's
   * subscribers hold `perOwner` claims already. Answers the claim's token,
   * or when to try again.
   */
  abstract claimSend(
    webhookId: string,
    owner: WebhookOwner,
    sendMs: number,
    perOwner: number,
  ): Promise<SendClaim>;

  /**
   * Counts a put-off of a pending delivery, from `deferrals` to one more
   * (compare-and-swap); false when it was counted already (the same job
   * run again) or the delivery is settled: then no new job is made.
   */
  abstract noteDeferral(
    tx: Transaction,
    deliveryId: string,
    deferrals: number,
  ): Promise<boolean>;

  /** Lets a claim go (no-op once it lapsed or another took over). */
  abstract releaseSend(webhookId: string, token: Date): Promise<void>;

  /** An attempt failed at the receiver: one more in a row; none before `waitMs` from now. */
  abstract noteAttemptFailure(
    tx: Transaction,
    webhookId: string,
    waitMs: number,
  ): Promise<void>;

  /** A delivery succeeded: the deliveries and attempts failed in a row start again at 0, with no wait. */
  abstract noteSuccess(tx: Transaction, webhookId: string): Promise<void>;

  /**
   * A delivery failed for good: one more failure in a row; at
   * `disableAfter` the subscriber is turned off (`disabledReason:
   * 'failing'`). Answers whether this disabled it.
   */
  abstract noteFailure(
    tx: Transaction,
    webhookId: string,
    disableAfter: number,
  ): Promise<boolean>;

  /** Deletes up to `limit` settled deliveries made before `before`; answers how many. */
  abstract pruneDeliveries(before: Date, limit: number): Promise<number>;
}
