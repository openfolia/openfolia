import { Injectable } from '@nestjs/common';
import type { UnguardedAction } from '../../../access/core/policy.js';
import { allowsUnrestricted } from '../../../access/core/allows.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import { BOUNDED, UnitOfWork } from '../../../base/core/unit-of-work.js';
import { JobQueue } from '../../../jobs/core/job-queue.js';
import {
  DISABLE_AFTER_FAILURES,
  PING,
  type Delivery,
  type DeliveryError,
  type DeliveryTarget,
} from '../webhook.js';
import { WEBHOOK_READER } from '../webhook-events.js';
import { isSecret } from '../webhook-headers.js';
import { DELIVER_WEBHOOK, DELIVERY_HEADERS } from '../webhook-job.js';
import {
  type SendResult,
  WebhookOwners,
  WebhookSecrets,
  WebhookSender,
  WebhookSettings,
} from '../webhook-ports.js';
import { SIGNATURE_HEADER, signatureHeader } from '../webhook-signature.js';
import type { AttemptRecord } from '../webhook-store.js';
import { WebhookStore } from '../webhook-store.js';
import { allowedScheme } from '../webhook-url.js';

/** Sent as `User-Agent`. */
export const USER_AGENT = 'openfolia-webhooks/1';

/**
 * Errors no retry mends: the address or URL is refused, or the secret
 * cannot be opened. The delivery fails at once.
 */
const FINAL: ReadonlySet<DeliveryError> = new Set([
  'blocked-address',
  'blocked-url',
  'secret-unreadable',
]);

/**
 * An attempt that failed and is tried again (the job's retry). Its
 * message names the delivery and why, never the URL, a header or a
 * secret: the job keeps it.
 */
export class DeliveryAttemptFailed extends Error {
  constructor(deliveryId: string, error: DeliveryError, status: number | null) {
    super(
      `Delivery ${deliveryId} failed (${error}${status === null ? '' : ` ${status}`}); retried.`,
    );
    this.name = 'DeliveryAttemptFailed';
  }
}

/**
 * An attempt not made: the subscriber's one attempt at a time is taken,
 * or it waits after a failure. Thrown, so the job tries again later.
 */
export class DeliveryDeferred extends Error {
  constructor(deliveryId: string) {
    super(`Delivery ${deliveryId} waits: its receiver has been failing.`);
    this.name = 'DeliveryDeferred';
  }
}

/** How long past an attempt's timeout its claim holds (a crashed attempt's lapses then). */
export const CLAIM_MARGIN_MS = 30_000;

/** Attempts in flight at once to one owner's subscribers, across servers. */
export const SENDING_PER_OWNER = 2;

/** Times one delivery is put off before a put-off spends an attempt. */
export const MAX_DEFERRALS = 1_000;

/**
 * How long after it was made a delivery may still be put off for free:
 * past it, put-offs spend attempts, so it fails for good within about
 * twice the retries' two hours.
 */
export const MAX_PUT_OFF_MS = 2 * 60 * 60 * 1000;

/** The least wait of the `n`th put-off: 1 s, doubled, at most 5 minutes. */
export const putOffDelay = (n: number): number =>
  Math.min(1_000 * 2 ** Math.min(n, 9), 300_000);

/** At most this much is added at random to a put-off, so a crowd never wakes at once. */
const PUT_OFF_JITTER_MS = 5_000;

/** The wait after the `n`th attempt in a row failed: 30 s, doubled, at most 10 min. */
export const waitAfter = (n: number): number =>
  Math.min(30_000 * 2 ** Math.min(Math.max(n - 1, 0), 5), 600_000);

/** What one attempt did, for the log and tests. */
export type AttemptOutcome =
  'succeeded' | 'retry' | 'failed' | 'skipped' | 'settled' | 'deferred';

/**
 * One attempt of a delivery (`webhook.deliver`). Reads the delivery
 * again and does nothing unless it is still `pending`, so one that
 * succeeded is never sent again. A subscriber paused, disabled, deleted
 * or no longer subscribed to the event, a delivery made for another owner
 * than its owner now, or one whose owner no longer acts or manages
 * webhooks: `skipped`, not sent. A receiver whose attempts have been
 * failing gets one attempt at a time, with a wait after each failure
 * (`waitAfter`; others are deferred: thrown, tried again). Otherwise
 * signs the stored body anew (`X-Ccms-Signature`, a fresh timestamp, every
 * secret that signs now) and sends it (`WebhookSender`) with the
 * subscriber's custom headers as they are now (#457; a secret one's value
 * opened for the attempt, never logged; the names sent are recorded). A 2xx answer:
 * `succeeded`, and the subscriber's failures in a row start again. A
 * refused address or URL, or a secret that cannot be opened: `failed` at
 * once. Anything else is recorded and thrown, so the job tries again;
 * on the last attempt it is `failed`, and after `DISABLE_AFTER_FAILURES`
 * deliveries in a row failed for good the subscriber is turned off
 * (audited as `webhook.disable`, by `service:webhooks`).
 *
 * At least once, as every job: an attempt cut off after the receiver
 * answered but before that was recorded sends again, with the same
 * `Idempotency-Key`, which a receiver uses to ignore it.
 */
@Injectable()
export class DeliverWebhookAction implements UnguardedAction {
  readonly policy = 'internal';
  now: () => number = Date.now;
  jitter: () => number = Math.random;

  constructor(
    private readonly store: WebhookStore,
    private readonly secrets: WebhookSecrets,
    private readonly sender: WebhookSender,
    private readonly settings: WebhookSettings,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
    private readonly owners: WebhookOwners,
    private readonly jobs: JobQueue,
  ) {}

  async handle({
    deliveryId,
    deferrals = 0,
    lastAttempt,
    signal,
  }: {
    deliveryId: string;
    /** How often this delivery was put off already. */
    deferrals?: number;
    lastAttempt: boolean;
    signal?: AbortSignal;
  }): Promise<AttemptOutcome> {
    const delivery = await this.store.delivery(deliveryId);
    if (delivery?.status !== 'pending') return 'settled';
    const target = await this.store.target(delivery.webhookId);
    // Made for an earlier owner: its body follows that owner's scope, so it
    // is never sent once someone else owns the subscriber. A test event is
    // sent once, by `test`, never by a job.
    if (
      !target ||
      !target.active ||
      delivery.event === PING ||
      !target.events.includes(delivery.event) ||
      target.owner.kind !== delivery.owner.kind ||
      target.owner.id !== delivery.owner.id ||
      // Built under another audience limit than the one set now (#254).
      target.maxAudience !== delivery.maxAudience
    ) {
      await this.unit.run((tx) => this.store.skip(tx, deliveryId), BOUNDED);
      return 'skipped';
    }
    // An owner who no longer acts, or no longer manages webhooks: what was
    // made for them is not sent.
    const owner = await this.owners.find(delivery.owner);
    if (!owner || !allowsUnrestricted(owner, 'webhook.manage')) {
      await this.unit.run((tx) => this.store.skip(tx, deliveryId), BOUNDED);
      return 'skipped';
    }
    // One attempt in flight per subscriber, a few per owner, and a wait
    // after a failure at the receiver, so a slow or failing receiver, or
    // one manager's many, never hold every sender.
    const claim = await this.store.claimSend(
      target.id,
      target.owner,
      this.settings.timeoutMs + CLAIM_MARGIN_MS,
      SENDING_PER_OWNER,
    );
    if ('retryAt' in claim) {
      return this.defer(delivery, deferrals, claim.retryAt);
    }
    try {
      return await this.attempt(delivery, target, lastAttempt, signal);
    } finally {
      await this.store.releaseSend(target.id, claim.token);
    }
  }

  /**
   * The one attempt of a test event (`ping`, #254), at once, under a send
   * claim the caller holds: signed and sent exactly as a delivery is
   * (the same address checks, signature and timeout), never retried. A
   * failure at the receiver makes the next attempt to it wait, as any
   * does, but never counts toward turning the subscriber off; a success
   * leaves its counts as they are.
   */
  async test(
    delivery: Delivery,
    target: DeliveryTarget,
  ): Promise<Exclude<AttemptOutcome, 'retry'>> {
    const outcome = await this.attempt(delivery, target, true, undefined, {
      counts: false,
    });
    return outcome === 'retry' ? 'failed' : outcome;
  }

  /**
   * Puts an attempt off without spending one: a new job, later (backing
   * off, with jitter), made with the put-off counted, in one transaction,
   * so a job run twice never starts a second chain. A delivery older than
   * `MAX_PUT_OFF_MS`, or put off `MAX_DEFERRALS` times, spends its
   * attempts instead, so it fails for good on time.
   */
  private async defer(
    delivery: Delivery,
    deferrals: number,
    retryAt: Date,
  ): Promise<AttemptOutcome> {
    const now = this.now();
    if (
      deferrals >= MAX_DEFERRALS ||
      now - delivery.createdAt.getTime() > MAX_PUT_OFF_MS
    ) {
      throw new DeliveryDeferred(delivery.id);
    }
    const startAfter = new Date(
      Math.max(retryAt.getTime(), now + putOffDelay(deferrals)) +
        Math.floor(this.jitter() * PUT_OFF_JITTER_MS),
    );
    await this.unit.run(async (tx) => {
      if (!(await this.store.noteDeferral(tx, delivery.id, deferrals))) return;
      await this.jobs.enqueue(
        DELIVER_WEBHOOK,
        { deliveryId: delivery.id, deferrals: deferrals + 1 },
        { key: `${delivery.id}:${deferrals + 1}`, tx, startAfter },
      );
    }, BOUNDED);
    return 'deferred';
  }

  private async attempt(
    delivery: Delivery,
    target: DeliveryTarget,
    lastAttempt: boolean,
    signal: AbortSignal | undefined,
    { counts = true }: { counts?: boolean } = {},
  ): Promise<AttemptOutcome> {
    let result: SendResult;
    let sentHeaders: string[] | null = null;
    // Ours, not the receiver's: webhooks off, or a secret that cannot be
    // opened (the key changed) fail the delivery but never count toward
    // turning the subscriber off.
    let ours = !this.settings.enabled;
    if (
      !this.settings.enabled ||
      !allowedScheme(new URL(target.url), this.settings.rules)
    ) {
      result = { ok: false, error: 'blocked-url', statusCode: null };
    } else {
      const secrets = this.openSecrets(
        target.id,
        target.secrets,
        target.previousSecretUntil,
      );
      const custom = this.openHeaders(target);
      if (!secrets || !custom) {
        ours = true;
        result = { ok: false, error: 'secret-unreadable', statusCode: null };
      } else {
        const timestamp = Math.floor(this.now() / 1000);
        // The subscriber's custom headers first (#457): none can be one the
        // server sets (`refusedHeaderName`), and the server's come after, so
        // they would win in any case.
        const headers: Record<string, string> = {
          ...custom,
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
          [DELIVERY_HEADERS.delivery]: delivery.id,
          [DELIVERY_HEADERS.event]: delivery.event,
          [DELIVERY_HEADERS.idempotencyKey]: delivery.idempotencyKey,
          [SIGNATURE_HEADER]: signatureHeader(
            secrets,
            timestamp,
            delivery.body,
          ),
        };
        sentHeaders = Object.keys(headers);
        result = await this.sender.send({
          url: target.url,
          headers,
          body: delivery.body,
          ...(signal && { signal }),
        });
      }
    }
    // Refused before a request went out: nothing was sent.
    if (
      !result.ok &&
      (result.error === 'blocked-address' || result.error === 'blocked-url')
    ) {
      sentHeaders = null;
    }
    return this.settle(
      delivery,
      result,
      lastAttempt,
      ours,
      target.attemptFailures,
      counts,
      sentHeaders,
    );
  }

  /**
   * Records an attempt. `counts` false (a test event): a success leaves
   * the subscriber's counts alone and a failure never counts toward
   * turning it off.
   */
  private async settle(
    delivery: Delivery,
    result: SendResult,
    lastAttempt: boolean,
    ours: boolean,
    failuresBefore: number,
    counts: boolean,
    sentHeaders: readonly string[] | null,
  ): Promise<AttemptOutcome> {
    const at = new Date(this.now());
    if (result.ok) {
      await this.unit.run(async (tx) => {
        const recorded = await this.store.recordAttempt(tx, delivery.id, {
          at,
          statusCode: result.statusCode,
          error: null,
          status: 'succeeded',
          sentHeaders,
        });
        if (recorded && counts)
          await this.store.noteSuccess(tx, delivery.webhookId);
      }, BOUNDED);
      return 'succeeded';
    }
    const final = lastAttempt || FINAL.has(result.error);
    const attempt: AttemptRecord = {
      at,
      statusCode: result.statusCode,
      error: result.error,
      status: final ? 'failed' : 'pending',
      sentHeaders,
    };
    await this.unit.run(async (tx) => {
      const recorded = await this.store.recordAttempt(tx, delivery.id, attempt);
      // The receiver's failures (not a refused URL or address, answered
      // at once): the next attempt to it waits.
      if (recorded && !ours && !FINAL.has(result.error)) {
        await this.store.noteAttemptFailure(
          tx,
          delivery.webhookId,
          waitAfter(failuresBefore + 1),
        );
      }
      if (recorded && final && !ours && counts)
        await this.failedForGood(tx, delivery.webhookId);
    }, BOUNDED);
    if (final) return 'failed';
    throw new DeliveryAttemptFailed(
      delivery.id,
      result.error,
      result.statusCode,
    );
  }

  /** Counts a delivery failed for good, and turns the subscriber off at the limit (audited). */
  async failedForGood(
    tx: Parameters<WebhookStore['noteFailure']>[0],
    webhookId: string,
  ): Promise<void> {
    const disabled = await this.store.noteFailure(
      tx,
      webhookId,
      DISABLE_AFTER_FAILURES,
    );
    if (disabled) {
      await this.auditLog.record(tx, WEBHOOK_READER, {
        action: 'webhook.disable',
        subject: { type: 'webhook', id: webhookId },
        data: { reason: 'failing', failures: DISABLE_AFTER_FAILURES },
      });
    }
  }

  /**
   * The subscriber's custom headers to send (#457), secret values opened;
   * undefined when one cannot be opened (the key changed): then nothing is
   * sent, rather than a request without the credential its receiver
   * expects. Never logged.
   */
  private openHeaders(
    target: DeliveryTarget,
  ): Record<string, string> | undefined {
    try {
      // As own properties whatever the name (`__proto__` is a token too).
      return Object.fromEntries(
        target.storedHeaders.map((h) => [
          h.name,
          isSecret(h)
            ? this.secrets.openHeader(h.sealed, target.id, h.name)
            : h.value,
        ]),
      );
    } catch {
      return undefined;
    }
  }

  /** The secrets that sign now, opened (current first); undefined when one cannot be opened. */
  private openSecrets(
    webhookId: string,
    sealed: { current: string; previous: string | null },
    previousUntil: Date | null,
  ): string[] | undefined {
    try {
      const out = [this.secrets.open(sealed.current, webhookId)];
      if (
        sealed.previous !== null &&
        previousUntil !== null &&
        previousUntil.getTime() > this.now()
      ) {
        out.push(this.secrets.open(sealed.previous, webhookId));
      }
      return out;
    } catch {
      return undefined;
    }
  }
}

/**
 * A delivery whose job failed for good without settling it (its last
 * attempt was cut off: a crash, a timeout): `failed`, counted against its
 * subscriber. Idempotent: one settled already stays as it is.
 */
@Injectable()
export class FailWebhookDeliveryAction implements UnguardedAction {
  readonly policy = 'internal';

  constructor(
    private readonly store: WebhookStore,
    private readonly deliver: DeliverWebhookAction,
    private readonly unit: UnitOfWork,
  ) {}

  async handle({ deliveryId }: { deliveryId: string }): Promise<void> {
    const delivery = await this.store.delivery(deliveryId);
    if (delivery?.status !== 'pending') return;
    await this.unit.run(async (tx) => {
      const recorded = await this.store.recordAttempt(tx, deliveryId, {
        at: new Date(),
        statusCode: delivery.lastStatusCode,
        error: delivery.lastError ?? 'timeout',
        status: 'failed',
        sentHeaders: delivery.sentHeaders,
      });
      if (recorded) await this.deliver.failedForGood(tx, delivery.webhookId);
    }, BOUNDED);
  }
}
