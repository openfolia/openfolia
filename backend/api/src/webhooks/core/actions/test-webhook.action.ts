import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import {
  ConflictError,
  NotFoundError,
  TooManyRequestsError,
} from '../../../base/core/errors.js';
import {
  BOUNDED,
  runContended,
  UnitOfWork,
} from '../../../base/core/unit-of-work.js';
import { JobQueue } from '../../../jobs/core/job-queue.js';
import { isWebhookId, newWebhookId, PING } from '../webhook.js';
import { idempotencyKey } from '../webhook-events.js';
import { DELIVER_WEBHOOK, deliveryBody } from '../webhook-job.js';
import { WebhookSettings } from '../webhook-ports.js';
import { WebhookStore } from '../webhook-store.js';
import {
  CLAIM_MARGIN_MS,
  DeliverWebhookAction,
  SENDING_PER_OWNER,
} from './deliver-webhook.action.js';
import {
  configured,
  existing,
  type LoggedDelivery,
  sameOwner,
  seesPayload,
} from './manage-webhooks.action.js';
import { Sandbox } from '../../../sandbox/core/sandbox.js';

/** Why a delivery cannot be retried (`meta.reason` of 409 `not-retryable`). */
export type NotRetryableReason =
  | 'status'
  | 'test-event'
  | 'inactive'
  | 'owner-changed'
  | 'audience-changed'
  | 'not-subscribed';

const notRetryable = (reason: NotRetryableReason, detail: string) =>
  new ConflictError('not-retryable', detail, { reason });

/** A delivery as the log shows it to `actor`. */
const logged = (
  actor: Actor,
  delivery: Awaited<ReturnType<WebhookStore['delivery']>> & object,
): LoggedDelivery => ({
  ...delivery,
  body: seesPayload(actor, delivery.owner, delivery.event)
    ? delivery.body
    : null,
});

/**
 * Sends a subscriber a test event (`ping`, #254) at once and answers the
 * delivery with its result: signed with its secret and sent through the
 * same sender as every delivery (the address checked after resolving the
 * host, no redirect, the timeout), under the same limits: one attempt in
 * flight per subscriber, a few per owner, and the wait after a failure at
 * the receiver. While one of those holds it is 429 `rate-limited` with
 * `Retry-After`, and nothing is sent or recorded. Sent whether the
 * subscriber is active or not (to try a receiver before resuming it), never
 * retried, and it never counts toward turning the subscriber off. Its body
 * names only the subscriber: `{ type: "ping", idempotencyKey, occurredAt,
 * data: { webhookId } }`. 404 `not-found`, `not-configured`. Recorded as
 * `webhook.test`. Needs `webhook.manage`.
 */
@Injectable()
export class TestWebhookAction extends ActorAction<
  { actor: Actor; id: string },
  LoggedDelivery
> {
  readonly policy = 'webhook.manage';
  now: () => number = Date.now;

  constructor(
    private readonly store: WebhookStore,
    private readonly settings: WebhookSettings,
    private readonly deliver: DeliverWebhookAction,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
    private readonly sandbox: Sandbox = Sandbox.OFF,
  ) {
    super();
  }

  protected async run({
    actor,
    id,
  }: {
    actor: Actor;
    id: string;
  }): Promise<LoggedDelivery> {
    this.sandbox.refuse('webhooks');
    configured(this.settings);
    const webhook = await existing(this.store, id, actor);
    const claim = await this.store.claimSend(
      webhook.id,
      webhook.owner,
      this.settings.timeoutMs + CLAIM_MARGIN_MS,
      SENDING_PER_OWNER,
    );
    if ('retryAt' in claim) {
      throw new TooManyRequestsError(
        'The receiver is busy with another attempt, or waits after a failed one; try again later.',
        Math.max(1, Math.ceil((claim.retryAt.getTime() - this.now()) / 1000)),
      );
    }
    try {
      const deliveryId = newWebhookId(this.now());
      const key = idempotencyKey(PING, deliveryId);
      await runContended(
        this.unit,
        async (tx) => {
          const added = await this.store.addDeliveries(tx, [
            {
              id: deliveryId,
              webhookId: webhook.id,
              event: PING,
              idempotencyKey: key,
              body: deliveryBody({
                type: PING,
                idempotencyKey: key,
                occurredAt: new Date(this.now()),
                data: { webhookId: webhook.id },
              }),
              owner: webhook.owner,
              maxAudience: webhook.maxAudience,
              outboxId: null,
            },
          ]);
          // Deleted meanwhile: as if it had never been there.
          if (added.length === 0)
            throw new NotFoundError(`No webhook "${id}".`);
          await this.auditLog.record(tx, actor, {
            action: 'webhook.test',
            subject: { type: 'webhook', id: webhook.id },
            data: { deliveryId },
          });
        },
        BOUNDED,
      );
      const [delivery, target] = await Promise.all([
        this.store.delivery(deliveryId),
        this.store.target(webhook.id),
      ]);
      if (!delivery || !target) throw new NotFoundError(`No webhook "${id}".`);
      try {
        await this.deliver.test(delivery, target);
      } catch (error) {
        // Never left pending (no job settles a ping, and pending rows are
        // kept): settled as skipped, so the log does not wait for it.
        await this.unit
          .run((tx) => this.store.skip(tx, deliveryId), BOUNDED)
          .catch(() => undefined);
        throw error;
      }
      const settled = await this.store.delivery(deliveryId);
      if (!settled) throw new NotFoundError(`No webhook "${id}".`);
      return logged(actor, settled);
    } finally {
      await this.store.releaseSend(webhook.id, claim.token);
    }
  }
}

/**
 * Sends a failed delivery again (#254): back to `pending`, with a new job
 * and its full set of attempts (`webhook.deliver`), under every rule a
 * delivery follows (the subscriber's owner, state and events, the limits
 * per receiver and owner). Only a `failed` one, of a subscriber still
 * active, still subscribed to its event and owned by whom it was made for
 * (409 `not-retryable`, `meta.reason`: `status`, `test-event` (send
 * another), `inactive`, `owner-changed`, `audience-changed` (made under
 * another audience limit than the one set now) or `not-subscribed`). 404
 * `not-found` (the subscriber, or a delivery not of it),
 * `not-configured`. Recorded as `webhook.retry`. Needs `webhook.manage`.
 */
@Injectable()
export class RetryWebhookDeliveryAction extends ActorAction<
  { actor: Actor; id: string; deliveryId: string },
  LoggedDelivery
> {
  readonly policy = 'webhook.manage';

  constructor(
    private readonly store: WebhookStore,
    private readonly settings: WebhookSettings,
    private readonly jobs: JobQueue,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
    private readonly sandbox: Sandbox = Sandbox.OFF,
  ) {
    super();
  }

  protected async run({
    actor,
    id,
    deliveryId,
  }: {
    actor: Actor;
    id: string;
    deliveryId: string;
  }): Promise<LoggedDelivery> {
    this.sandbox.refuse('webhooks');
    configured(this.settings);
    // Read before the transaction (one connection may serve both); the
    // compare-and-swap below finds it still failed, or refuses.
    const delivery = isWebhookId(deliveryId)
      ? await this.store.delivery(deliveryId)
      : undefined;
    await runContended(
      this.unit,
      async (tx) => {
        const webhook = await existing(this.store, id, actor, tx);
        if (delivery?.webhookId !== webhook.id) {
          throw new NotFoundError(
            `No delivery "${deliveryId}" of this webhook.`,
          );
        }
        if (delivery.event === PING) {
          throw notRetryable(
            'test-event',
            'A test event is not sent again; send another.',
          );
        }
        if (delivery.status !== 'failed') {
          throw notRetryable('status', 'Only a failed delivery is sent again.');
        }
        if (!webhook.active) {
          throw notRetryable(
            'inactive',
            'The webhook is paused or disabled; resume it first.',
          );
        }
        if (!sameOwner(delivery.owner, webhook.owner)) {
          throw notRetryable(
            'owner-changed',
            'The delivery was made for an earlier owner of the webhook; it is not sent to its new receiver.',
          );
        }
        // Built under a wider (or another) audience limit than the one set
        // now: sending it again would let through what the limit holds back.
        if (delivery.maxAudience !== webhook.maxAudience) {
          throw notRetryable(
            'audience-changed',
            "The delivery was made under another audience limit than the webhook's now; it is not sent again.",
          );
        }
        if (!webhook.events.includes(delivery.event)) {
          throw notRetryable(
            'not-subscribed',
            'The webhook is no longer sent this event.',
          );
        }
        const requeued = await this.store.requeue(tx, delivery.id);
        if (!requeued) {
          throw notRetryable('status', 'Only a failed delivery is sent again.');
        }
        const job = await this.jobs.enqueue(
          DELIVER_WEBHOOK,
          { deliveryId: delivery.id, deferrals: requeued.deferrals },
          { key: `${delivery.id}:retry:${delivery.attempts}`, tx },
        );
        // A retry of this very attempt is queued already (sent twice at once).
        if (job === undefined) {
          throw notRetryable('status', 'This delivery is being sent again.');
        }
        await this.auditLog.record(tx, actor, {
          action: 'webhook.retry',
          subject: { type: 'webhook', id: webhook.id },
          data: { deliveryId: delivery.id, event: delivery.event },
        });
      },
      BOUNDED,
    );
    const requeued = await this.store.delivery(deliveryId);
    if (!requeued) {
      throw new NotFoundError(`No delivery "${deliveryId}" of this webhook.`);
    }
    return logged(actor, requeued);
  }
}
