import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { allowsUnrestricted } from '../../../access/core/allows.js';
import type { UnguardedAction } from '../../../access/core/policy.js';
import { DomainError, UnavailableError } from '../../../base/core/errors.js';
import { BOUNDED, UnitOfWork } from '../../../base/core/unit-of-work.js';
import { JobQueue } from '../../../jobs/core/job-queue.js';
import {
  BLOCKED,
  type OutboxEvent,
  OutboxFeed,
  type OutboxPosition,
  samePosition,
} from '../../../outbox/core/outbox-feed.js';
import { newWebhookId, type NewDelivery, type Webhook } from '../webhook.js';
import { WebhookEventBuilder } from '../webhook-events.js';
import { DELIVER_WEBHOOK, deliveryBody } from '../webhook-job.js';
import { WebhookOwners, WebhookSettings } from '../webhook-ports.js';
import { WebhookStore } from '../webhook-store.js';

/** The webhooks' outbox consumer (`outbox_consumers.name`). */
export const CONSUMER = 'webhooks';

/** How many outbox rows one batch reads. */
export const BATCH_SIZE = 50;

/** At most this many batches per run; the rest wait for the next run. */
export const MAX_BATCHES_PER_RUN = 10;

/** How many deliveries (and their jobs) one transaction writes. */
export const WRITE_CHUNK = 200;

/**
 * How often a row whose events fail for an unexpected reason is tried
 * (runs in this process) before it is passed over; a domain error passes
 * it over at once, an outage (`UnavailableError`) is tried again however
 * often (as the notifications do).
 */
export const MAX_ATTEMPTS = 5;

/** A row passed over, and why. */
export interface Skipped {
  readonly position: OutboxPosition;
  readonly topic: string;
  readonly reason: 'payload' | 'refused' | 'failing';
  /** Set when only this subscriber was passed over (its owner's reading was refused). */
  readonly webhookId?: string;
  readonly error?: unknown;
}

/** What a run did. */
export interface FanOutReport {
  /** Outbox rows read and recorded. */
  events: number;
  /** Deliveries made (new ones). */
  deliveries: number;
  readonly skipped: Skipped[];
  retry?: { position: OutboxPosition; topic: string; error: unknown };
  /** Another server recorded the batch first. */
  raced: boolean;
  /** Whether it stopped at its budget with more to read. */
  stopped: boolean;
  /**
   * Whether the consumer is held after a restore onto another database
   * server (`BLOCKED`): nothing was read, nothing is skipped meanwhile.
   */
  blocked: boolean;
}

/**
 * Reads the outbox from the webhooks' cursor (`OutboxFeed`, the second
 * consumer beside the notifications) and makes a delivery per event and
 * subscriber (`WebhookEventBuilder`, judged by what the subscriber's owner
 * may read), each with its job (`webhook.deliver`) in the same
 * transaction. Only active subscribers made before the row was written
 * hear of it.
 *
 * Deliveries are written before the cursor moves (by compare-and-swap):
 * a run cut off between the two, or two servers reading the same batch,
 * writes them again, and a delivery is unique per subscriber and
 * idempotency key, so the same event is delivered to a subscriber once.
 * A row whose events fail stops the batch there (see `MAX_ATTEMPTS`).
 *
 * Runs for nobody: `WebhooksConsumer` starts it.
 */
@Injectable()
export class FanOutWebhooksAction implements UnguardedAction {
  readonly policy = 'internal';

  /** Failed attempts per outbox row ID, in this process. */
  private readonly attempts = new Map<number, number>();

  constructor(
    private readonly feed: OutboxFeed,
    private readonly builder: WebhookEventBuilder,
    private readonly store: WebhookStore,
    private readonly owners: WebhookOwners,
    private readonly jobs: JobQueue,
    private readonly settings: WebhookSettings,
    private readonly unit: UnitOfWork,
  ) {}

  async handle(
    budget: { readonly deadline?: number; readonly now?: () => number } = {},
  ): Promise<FanOutReport> {
    const now = budget.now ?? Date.now;
    const report: FanOutReport = {
      events: 0,
      deliveries: 0,
      skipped: [],
      raced: false,
      stopped: false,
      blocked: false,
    };
    // Off: the cursor stays where it is, so nothing is lost meanwhile.
    if (!this.settings.enabled) return report;
    const owners = new Map<string, Promise<Actor | undefined>>();
    const ownerOf = (w: Webhook) => {
      const key = `${w.owner.kind}/${w.owner.id}`;
      let found = owners.get(key);
      if (!found) {
        // An owner who no longer manages webhooks hears of nothing.
        found = this.owners
          .find(w.owner)
          .then((o) =>
            o && allowsUnrestricted(o, 'webhook.manage') ? o : undefined,
          );
        owners.set(key, found);
      }
      return found;
    };
    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
      if (budget.deadline !== undefined && now() >= budget.deadline) {
        report.stopped = true;
        break;
      }
      const read = await this.feed.read(CONSUMER, BATCH_SIZE);
      if (read === BLOCKED) {
        report.blocked = true;
        break;
      }
      const { from, events } = read;
      if (events.length === 0) break;
      // Read after the rows, per batch: a subscriber made or changed
      // meanwhile hears of what came after it.
      const subscribers = await this.store.active();
      let to = from;
      let taken = 0;
      const skipped: Skipped[] = [];
      for (const event of events) {
        // The budget holds per event too: what is done so far is kept.
        if (
          taken > 0 &&
          budget.deadline !== undefined &&
          now() >= budget.deadline
        ) {
          report.stopped = true;
          break;
        }
        try {
          const made = await this.deliveriesOf(
            event,
            subscribers,
            ownerOf,
            (webhookId, error) =>
              report.skipped.push({
                ...where(event),
                reason: 'refused',
                webhookId,
                error,
              }),
          );
          if (made === undefined) {
            skipped.push({ ...where(event), reason: 'payload' });
          } else {
            report.deliveries += await this.write(made);
          }
          this.attempts.delete(event.position.id);
        } catch (error) {
          const passOver = this.passOver(event.position.id, error);
          if (!passOver) {
            report.retry = { ...where(event), error };
            break;
          }
          skipped.push({ ...where(event), reason: passOver, error });
        }
        to = event.position;
        taken++;
      }
      if (!samePosition(from, to)) {
        const moved = await this.unit.run(
          (tx) => this.feed.advance(tx, CONSUMER, from, to),
          BOUNDED,
        );
        if (!moved) {
          report.raced = true;
          break;
        }
        report.events += taken;
        report.skipped.push(...skipped);
        for (const s of skipped) this.attempts.delete(s.position.id);
      }
      if (report.retry || report.stopped || events.length < BATCH_SIZE) break;
      if (batch === MAX_BATCHES_PER_RUN - 1) report.stopped = true;
    }
    return report;
  }

  /** The deliveries an outbox row makes; undefined when its payload is not what its topic writes. */
  private async deliveriesOf(
    event: OutboxEvent,
    subscribers: readonly Webhook[],
    ownerOf: (w: Webhook) => Promise<Actor | undefined>,
    refused: (webhookId: string, error: unknown) => void,
  ): Promise<NewDelivery[] | undefined> {
    const out: NewDelivery[] = [];
    for (const webhook of subscribers) {
      // Made after the event: it was not there to hear of it.
      if (webhook.createdAt.getTime() > event.createdAt.getTime()) continue;
      const owner = await ownerOf(webhook);
      if (!owner) continue;
      let made: Awaited<ReturnType<WebhookEventBuilder['of']>>;
      try {
        made = await this.builder.of(
          event,
          owner,
          new Set(webhook.events),
          webhook.maxAudience,
        );
      } catch (error) {
        // Refused for this owner only (content it cannot read): the others
        // still hear of it. An outage, or anything unknown, retries the row.
        if (
          error instanceof UnavailableError ||
          !(error instanceof DomainError)
        )
          throw error;
        refused(webhook.id, error);
        continue;
      }
      if (made === undefined) return undefined;
      for (const e of made) {
        if (!webhook.events.includes(e.type)) continue;
        out.push({
          id: newWebhookId(),
          webhookId: webhook.id,
          event: e.type,
          idempotencyKey: e.idempotencyKey,
          body: deliveryBody({ ...e, occurredAt: event.createdAt }),
          owner: webhook.owner,
          maxAudience: webhook.maxAudience,
          outboxId: event.position.id,
        });
      }
    }
    return out;
  }

  /** Writes deliveries and their jobs, `WRITE_CHUNK` per transaction; answers how many were new. */
  private async write(deliveries: readonly NewDelivery[]): Promise<number> {
    let added = 0;
    for (let i = 0; i < deliveries.length; i += WRITE_CHUNK) {
      const chunk = deliveries.slice(i, i + WRITE_CHUNK);
      added += await this.unit.run(async (tx) => {
        const ids = await this.store.addDeliveries(tx, chunk);
        for (const deliveryId of ids) {
          await this.jobs.enqueue(
            DELIVER_WEBHOOK,
            { deliveryId },
            { key: deliveryId, tx },
          );
        }
        return ids.length;
      }, BOUNDED);
    }
    return added;
  }

  private passOver(
    id: number,
    error: unknown,
  ): 'refused' | 'failing' | undefined {
    if (error instanceof UnavailableError) return undefined;
    if (error instanceof DomainError) return 'refused';
    const attempts = (this.attempts.get(id) ?? 0) + 1;
    this.attempts.set(id, attempts);
    if (this.attempts.size > 1_000) {
      const oldest = this.attempts.keys().next().value;
      if (oldest !== undefined) this.attempts.delete(oldest);
    }
    return attempts >= MAX_ATTEMPTS ? 'failing' : undefined;
  }
}

function where(event: { position: OutboxPosition; topic: string }) {
  return { position: event.position, topic: event.topic };
}
