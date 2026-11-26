import { Injectable } from '@nestjs/common';
import type { UnguardedAction } from '../../../access/core/policy.js';
import { DomainError, UnavailableError } from '../../../base/core/errors.js';
import { BOUNDED, UnitOfWork } from '../../../base/core/unit-of-work.js';
import {
  BLOCKED,
  OutboxFeed,
  type OutboxPosition,
  samePosition,
} from '../../../outbox/core/outbox-feed.js';
import { FanOut } from '../fan-out.js';
import type { NewNotification } from '../notification.js';
import { NotificationStore } from '../notification-store.js';
import { NotificationRouting } from '../notification-routing.js';

/** The notifications' outbox consumer (`outbox_consumers.name`). */
export const CONSUMER = 'notifications';

/** How many outbox rows one batch reads. */
export const BATCH_SIZE = 100;

/** At most this many batches per run; the rest wait for the next run. */
export const MAX_BATCHES_PER_RUN = 10;

/**
 * How often a row whose fan-out fails for an unexpected reason is tried
 * (runs in this process) before it is passed over, so one row cannot hold
 * up everyone's notifications for good. A domain error (a commit or
 * change set that is not there, too many changes) passes it over at once;
 * an outage (`UnavailableError`) is tried again however often.
 */
export const MAX_ATTEMPTS = 5;

/** A row passed over, and why. */
export interface Skipped {
  readonly position: OutboxPosition;
  readonly topic: string;
  readonly reason: 'payload' | 'refused' | 'failing';
  readonly error?: unknown;
}

/** What a run did. */
export interface DeliveryReport {
  /** Outbox rows read and recorded. */
  events: number;
  /** Notifications stored (new ones). */
  stored: number;
  readonly skipped: Skipped[];
  /** A row whose fan-out failed and will be tried again, with why. */
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
 * Reads the outbox from the notifications' cursor (`OutboxFeed`), works
 * out who each row concerns (`FanOut`), applies each person's choices
 * (`NotificationRouting`, #884: a kind turned off is not stored) and stores
 * their notifications, with the emails they choose scheduled beside them, in
 * batches of `BATCH_SIZE`. Each batch's notifications and the cursor move
 * are one transaction, the cursor moved by compare-and-swap: a run that
 * stops or fails mid-batch (a restart) writes nothing of it, the next one
 * reads it again, and a notification is unique per outbox row and
 * recipient, so nobody is notified twice. Servers side by side may each
 * run it: the one whose cursor move lands records the batch, the other's
 * is dropped.
 *
 * The fan-out of a batch runs outside the transaction (it reads Git and
 * the user directory); a row whose fan-out fails stops the batch there,
 * after recording the rows before it (see `MAX_ATTEMPTS`).
 *
 * Runs for nobody: `NotificationsConsumer` starts it.
 */
@Injectable()
export class DeliverNotificationsAction implements UnguardedAction {
  readonly policy = 'internal';

  /** Failed attempts per outbox row ID, in this process. */
  private readonly attempts = new Map<number, number>();

  constructor(
    private readonly feed: OutboxFeed,
    private readonly fanOut: FanOut,
    private readonly store: NotificationStore,
    private readonly unit: UnitOfWork,
    private readonly routing: NotificationRouting,
  ) {}

  async handle(
    budget: {
      /** When to stop (epoch milliseconds); no time limit when left out. */
      readonly deadline?: number;
      readonly now?: () => number;
    } = {},
  ): Promise<DeliveryReport> {
    const now = budget.now ?? Date.now;
    const report: DeliveryReport = {
      events: 0,
      stored: 0,
      skipped: [],
      raced: false,
      stopped: false,
      blocked: false,
    };
    const people = this.fanOut.people();
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
      const made: NewNotification[] = [];
      const skipped: Skipped[] = [];
      let to = from;
      let taken = 0;
      for (const event of events) {
        try {
          const notifications = await this.fanOut.of(event, people);
          if (notifications === undefined) {
            skipped.push({ ...where(event), reason: 'payload' });
          } else {
            made.push(...notifications);
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
        // Read outside the transaction, like the fan-out: the choices as they are now.
        const routed = await this.routing.route(made);
        const recorded = await this.unit.run(async (tx) => {
          if (!(await this.feed.advance(tx, CONSUMER, from, to))) {
            return undefined;
          }
          const stored = await this.store.add(tx, routed.keep);
          await this.routing.schedule(tx, routed.email);
          return stored;
        }, BOUNDED);
        if (recorded === undefined) {
          report.raced = true;
          break;
        }
        report.stored += recorded;
        report.events += taken;
        report.skipped.push(...skipped);
        for (const s of skipped) this.attempts.delete(s.position.id);
      }
      if (report.retry || events.length < BATCH_SIZE) break;
      if (batch === MAX_BATCHES_PER_RUN - 1) report.stopped = true;
    }
    return report;
  }

  /**
   * Whether a row whose fan-out threw is passed over now (and why), or
   * tried again by a later run.
   */
  private passOver(
    id: number,
    error: unknown,
  ): 'refused' | 'failing' | undefined {
    if (error instanceof UnavailableError) return undefined;
    if (error instanceof DomainError) return 'refused';
    const attempts = (this.attempts.get(id) ?? 0) + 1;
    this.attempts.set(id, attempts);
    if (this.attempts.size > 1_000) {
      // Bounded: only the oldest entries go, which rows already passed.
      const oldest = this.attempts.keys().next().value;
      if (oldest !== undefined) this.attempts.delete(oldest);
    }
    return attempts >= MAX_ATTEMPTS ? 'failing' : undefined;
  }
}

function where(event: { position: OutboxPosition; topic: string }) {
  return { position: event.position, topic: event.topic };
}
