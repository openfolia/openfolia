import { z } from 'zod';
import { defineJob } from '../../jobs/core/job.js';
import { isWebhookId } from './webhook.js';

/**
 * Delivers one delivery (`webhook_deliveries`): 9 attempts, the retries
 * 30 s apart at first, doubled each time with jitter (about 30 s, 1, 2, 4,
 * 8, 16, 32 minutes and an hour: some two hours in all), then it has
 * failed for good. An attempt runs at most two minutes (the request's own
 * timeout is shorter). Four at once per server. An attempt put off (its
 * subscriber's one attempt in flight taken, a wait after a failure, its
 * owner's limit reached) spends none: a new job runs it later
 * (`deferrals`, backing off), until the delivery is two hours old; then
 * put-offs spend attempts, so it fails for good within about four hours.
 */
export const DELIVER_WEBHOOK = defineJob({
  name: 'webhook.deliver',
  payload: z.strictObject({
    deliveryId: z.string().refine(isWebhookId, 'not a delivery ID'),
    /** How often it was put off already (its receiver busy or waiting); none spends an attempt. */
    deferrals: z.number().int().min(0).max(10_000).optional(),
  }),
  retryLimit: 8,
  retryDelaySeconds: 30,
  timeoutSeconds: 120,
  concurrency: 4,
});
export type DeliverWebhookPayload = z.infer<typeof DELIVER_WEBHOOK.payload>;

/** The headers every delivery carries (besides `Content-Type` and `User-Agent`). */
export const DELIVERY_HEADERS = {
  /** The delivery's ID: the same on every attempt of it. */
  delivery: 'X-Ccms-Delivery',
  /** The event's type (`module.released`, …). */
  event: 'X-Ccms-Event',
  /** The event's idempotency key: a receiver keeps those it has handled and ignores one seen before. */
  idempotencyKey: 'Idempotency-Key',
} as const;

/** The JSON body of a delivery: the event, small: IDs and what changed, never content. */
export function deliveryBody(event: {
  readonly type: string;
  readonly idempotencyKey: string;
  readonly occurredAt: Date;
  readonly data: Readonly<Record<string, unknown>>;
}): string {
  return JSON.stringify({
    type: event.type,
    idempotencyKey: event.idempotencyKey,
    occurredAt: event.occurredAt.toISOString(),
    data: event.data,
  });
}
