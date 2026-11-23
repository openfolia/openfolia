import { ConfigKey } from '@openfolia/content-model';
import { z } from 'zod';
import {
  isChangeSetId,
  newChangeSetId,
} from '../../change-sets/core/change-set.js';
import type { StoredHeader, WebhookHeader } from './webhook-headers.js';

/**
 * The events a subscriber may subscribe to (#42). Only released or
 * imported content fires one: drafts, reviews and the workflow never do.
 *
 * - `manual.released`: a manual a release changed (one per manual, with
 *   its languages), from the outbox row `release.published`.
 * - `module.released`: a module a release changed, per language, from the
 *   same row.
 * - `module.deprecated`: a module deprecated on `main`, from the outbox row
 *   `module.deprecated` (written once deprecation exists, #266).
 * - `manual.deprecated`: a manual deprecated on `main`, from the outbox row
 *   `manual.deprecated` (#266, sent since #558).
 * - `release.withdrawn`: a release withdrawn, from `release.withdrawn`.
 * - `translation.imported`: a translation import committed, from
 *   `translation.imported` (written by a translation import, #51).
 */
export const WEBHOOK_EVENTS = [
  'manual.released',
  'module.released',
  'module.deprecated',
  'manual.deprecated',
  'release.withdrawn',
  'translation.imported',
] as const;
export const WebhookEvent = z.enum(WEBHOOK_EVENTS);
export type WebhookEvent = z.infer<typeof WebhookEvent>;

/**
 * What a delivery may be of: an event a subscriber subscribes to, or
 * `ping`, the test event (#254) sent at once when a manager asks for one
 * (`POST /webhooks/{id}/test`), to every subscriber whatever its events,
 * never from the outbox and never retried.
 */
export const DELIVERY_EVENTS = [...WEBHOOK_EVENTS, 'ping'] as const;
export const DeliveryEvent = z.enum(DELIVERY_EVENTS);
export type DeliveryEvent = z.infer<typeof DeliveryEvent>;

/** The test event's type. */
export const PING = 'ping' satisfies DeliveryEvent;

/** The most subscribers there may be. */
export const MAX_WEBHOOKS = 100;

/** The longest URL a subscriber may have. */
export const MAX_URL_LENGTH = 2_000;

/**
 * A subscriber is disabled (`disabledReason: 'failing'`) once this many
 * deliveries in a row failed for good (each after all its retries), with
 * no successful one in between.
 */
export const DISABLE_AFTER_FAILURES = 5;

/** How long the secret before a rotation still signs deliveries, beside the new one. */
export const PREVIOUS_SECRET_GRACE_MS = 24 * 60 * 60 * 1000;

export const WebhookDescription = z.string().trim().min(1).max(500);

/**
 * A subscriber's audience limit (#254): an audience level of the
 * configuration (`openfolia.yaml`, `audiences`); it hears only of content at
 * that level or a less restricted one, within what its owner may read.
 * A level the configuration does not hold matches nothing.
 */
export const WebhookAudience = ConfigKey;

/** Who owns a subscriber: whoever made it. Its events are what they may read. */
export interface WebhookOwner {
  readonly kind: 'user' | 'service';
  readonly id: string;
}

/** Why a subscriber stopped receiving deliveries by itself. */
export type DisabledReason = 'failing';

/** A subscriber as stored and shown: never its secret. */
export interface Webhook {
  /** A UUID version 7. */
  readonly id: string;
  readonly url: string;
  readonly description: string | null;
  /** Sorted, without duplicates. */
  readonly events: readonly WebhookEvent[];
  /**
   * The most restricted audience level it hears of (`WebhookAudience`);
   * null: whatever its owner may read.
   */
  readonly maxAudience: string | null;
  /** Whether new events are delivered to it: false while paused or disabled. */
  readonly active: boolean;
  /** Why it was turned off by itself; null when not (paused by hand, or active). */
  readonly disabledReason: DisabledReason | null;
  readonly disabledAt: Date | null;
  /** Deliveries that failed for good in a row. */
  readonly consecutiveFailures: number;
  readonly owner: WebhookOwner;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly secretRotatedAt: Date;
  /** Until when the secret before the last rotation still signs, beside the current one; null when none does. */
  readonly previousSecretUntil: Date | null;
  /** Its custom headers (#457), in order; a secret one without its value. */
  readonly headers: readonly WebhookHeader[];
}

/** The secrets a delivery is signed with, opened from the store. */
export interface SealedSecrets {
  /** The current secret, sealed (`WebhookSecrets.seal`). */
  readonly current: string;
  /** The one before the last rotation, while it still signs. */
  readonly previous: string | null;
}

/** A subscriber with its sealed secrets, for delivering. */
export interface DeliveryTarget extends Webhook {
  readonly secrets: SealedSecrets;
  /** Attempts in a row that failed at the receiver (any delivery): how long the next waits. */
  readonly attemptFailures: number;
  /** Its custom headers as stored: a secret one's value sealed (`WebhookSecrets.sealHeader`). */
  readonly storedHeaders: readonly StoredHeader[];
}

/** What a new subscriber is made of. */
export interface NewWebhook {
  readonly id: string;
  readonly url: string;
  readonly description: string | null;
  readonly events: readonly WebhookEvent[];
  readonly maxAudience: string | null;
  readonly owner: WebhookOwner;
  readonly sealedSecret: string;
  /** Its custom headers, checked (`checkHeaders`), secret values sealed. */
  readonly headers: readonly StoredHeader[];
}

/** What changing a subscriber changes; what is left out stays. */
export interface WebhookChanges {
  readonly url?: string;
  readonly description?: string | null;
  readonly events?: readonly WebhookEvent[];
  /** A new audience limit; null removes it. */
  readonly maxAudience?: string | null;
  /** `true` turns it on again (and clears a disabled reason and the failure count); `false` pauses it. */
  readonly active?: boolean;
  /**
   * A new owner: whoever points it at another URL takes it over, so
   * nobody points another's subscriber, and what they may read, at a
   * receiver of their own.
   */
  readonly owner?: WebhookOwner;
  /** Its custom headers, all of them (checked, secret values sealed): they replace the stored ones. */
  readonly headers?: readonly StoredHeader[];
}

/** A delivery's state. */
export const DELIVERY_STATUSES = [
  /** Waiting for its first or next attempt. */
  'pending',
  /** A 2xx answer: never sent again. */
  'succeeded',
  /** Every attempt failed, or the address was refused. */
  'failed',
  /** Not sent: its subscriber was paused, disabled or no longer subscribes to the event. */
  'skipped',
] as const;
export const DeliveryStatus = z.enum(DELIVERY_STATUSES);
export type DeliveryStatus = z.infer<typeof DeliveryStatus>;

/** Why an attempt failed (never a message from the receiver, never the URL). */
export const DELIVERY_ERRORS = [
  /** The receiver answered with a status that is not 2xx (redirects included: none is followed). */
  'http-status',
  /** No answer within the timeout. */
  'timeout',
  /** The connection failed or broke off (DNS, refused, reset, TLS). */
  'connection',
  /** The host resolved to an address deliveries may not go to (private, loopback, link-local, …). */
  'blocked-address',
  /** The URL is not one deliveries may go to (its scheme, since a setting changed). */
  'blocked-url',
  /** The secret could not be opened (the encryption key changed). */
  'secret-unreadable',
] as const;
export type DeliveryError = (typeof DELIVERY_ERRORS)[number];

/** One delivery of one event to one subscriber, with its attempts so far. */
export interface Delivery {
  /** A UUID version 7; sent as `X-Ccms-Delivery`. */
  readonly id: string;
  readonly webhookId: string;
  readonly event: DeliveryEvent;
  /** Unique per subscriber: an event with this key is delivered to it once. */
  readonly idempotencyKey: string;
  /** The JSON body sent, the same on every attempt. */
  readonly body: string;
  /**
   * Whose reading scope the body was built for: the subscriber's owner when
   * the delivery was made. It is sent only while that is still the owner.
   */
  readonly owner: WebhookOwner;
  /**
   * The subscriber's audience limit the body was built under (#254). It is
   * sent, or sent again, only while that is still the limit: a narrower one
   * set since must not let through what the wider one did.
   */
  readonly maxAudience: string | null;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  readonly lastAttemptAt: Date | null;
  /** The receiver's status code at the last attempt, when it answered. */
  readonly lastStatusCode: number | null;
  readonly lastError: DeliveryError | null;
  /** When it succeeded. */
  readonly deliveredAt: Date | null;
  /**
   * The names of the headers its last attempt sent (the server's and the
   * subscriber's custom ones, #457), never a value; null before an attempt
   * sent anything.
   */
  readonly sentHeaders: readonly string[] | null;
  readonly createdAt: Date;
}

/** A subscriber's latest delivery, as its list shows it: never its body. */
export type DeliverySummary = Pick<
  Delivery,
  | 'id'
  | 'event'
  | 'status'
  | 'attempts'
  | 'lastAttemptAt'
  | 'lastStatusCode'
  | 'lastError'
  | 'createdAt'
>;

/** A delivery to make, from an outbox row. */
export interface NewDelivery {
  readonly id: string;
  readonly webhookId: string;
  readonly event: DeliveryEvent;
  readonly idempotencyKey: string;
  readonly body: string;
  /** The subscriber's owner the body was built for. */
  readonly owner: WebhookOwner;
  /** The subscriber's audience limit the body was built under. */
  readonly maxAudience: string | null;
  /** The outbox row it was made from; null for a test event (`ping`). */
  readonly outboxId: number | null;
}

/** Which deliveries to list; every field optional. */
export interface DeliveryFilter {
  readonly status?: DeliveryStatus;
  readonly event?: DeliveryEvent;
}

/** A new subscriber's or delivery's ID (a UUID version 7). */
export const newWebhookId = (now = Date.now()): string => newChangeSetId(now);

/** Whether `id` can name a subscriber or a delivery. */
export const isWebhookId = isChangeSetId;

/** Sorted, without duplicates. */
export const normalEvents = (events: readonly WebhookEvent[]): WebhookEvent[] =>
  [...new Set(events)].sort();
