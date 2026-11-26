import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Actor } from '../../access/core/actor.js';
import { allows, ANYWHERE } from '../../access/core/allows.js';
import type { OutboxEvent } from '../../outbox/core/outbox-feed.js';
import { REGISTERED_WEBHOOK_EVENTS } from '../../webhook-events.js';
import type { DeliveryEvent, WebhookEvent } from './webhook.js';
import {
  type OutgoingEvent,
  WebhookEventHandlers,
} from './webhook-event-handler.js';

export type { OutgoingEvent } from './webhook-event-handler.js';

/**
 * Who reads content to judge an event that names no release (a module
 * deprecated at a commit): a service that reads every ref. What it reads
 * decides only whether an owner may know of the event, by their own
 * scope; nothing of it is sent but IDs.
 */
export const WEBHOOK_READER: Actor = Object.freeze({
  kind: 'service',
  // Outside the `UserId` format (":"), so no user can have this ID.
  id: 'service:webhooks',
  roles: Object.freeze([
    Object.freeze({
      id: 'webhook-reader',
      name: 'Webhooks (read-only)',
      permissions: Object.freeze(['content.read', 'content.read.draft']),
      scope: Object.freeze({}),
    }),
  ]),
}) as Actor;

/**
 * The topics that make webhook events, and the events each makes, as the
 * components registered them (`src/webhook-events.ts`).
 */
export const TOPIC_EVENTS: Readonly<Record<string, readonly WebhookEvent[]>> =
  topicEvents();

function topicEvents(): Readonly<Record<string, readonly WebhookEvent[]>> {
  const byTopic = new Map<string, WebhookEvent[]>();
  for (const { topic, type } of REGISTERED_WEBHOOK_EVENTS)
    byTopic.set(topic, [...(byTopic.get(topic) ?? []), type]);
  // No prototype: a topic such as `constructor` makes nothing.
  const topics: Record<string, readonly WebhookEvent[]> = Object.create(null);
  for (const [topic, events] of byTopic) topics[topic] = Object.freeze(events);
  return Object.freeze(topics);
}

/** The idempotency key of an event: SHA-256 over its type and what identifies it. */
export function idempotencyKey(
  type: DeliveryEvent,
  ...parts: readonly string[]
): string {
  const hash = createHash('sha256').update(type);
  for (const part of parts) hash.update('\n').update(part);
  return hash.digest('hex');
}

/**
 * What an outbox row tells one subscriber (#42), as its owner may read
 * it: a subscriber only hears of content its owner's roles let them read
 * (`content.read`, in their scope), worked out again for every event.
 *
 * What each event tells, and to whom, is decided by the handler of the
 * component that registered it (`WebhookEventHandler`, found by the row's
 * topic); this holds what every event shares: nothing for a row of a topic
 * that makes no event, or that makes none the subscriber wants, nothing to
 * an owner who reads no content anywhere, and of what the handler answers
 * only the events its topic makes that the subscriber wants.
 *
 * The same row read again makes the same idempotency keys, so a subscriber
 * gets each event once.
 *
 * Undefined: the row's payload is not what its topic writes.
 */
@Injectable()
export class WebhookEventBuilder {
  constructor(private readonly handlers: WebhookEventHandlers) {}

  /**
   * `maxAudience`: the subscriber's audience limit (#254): content is
   * judged as the owner reads it with every role capped at that level
   * (`capAudience`, by the configuration at the event's commit), where the
   * event names content of an audience.
   */
  async of(
    event: OutboxEvent,
    owner: Actor,
    wanted: ReadonlySet<WebhookEvent>,
    maxAudience: string | null = null,
  ): Promise<OutgoingEvent[] | undefined> {
    const makes = TOPIC_EVENTS[event.topic] ?? [];
    if (!makes.some((type) => wanted.has(type))) return [];
    if (!allows(owner, 'content.read', ANYWHERE)) return [];
    const handler = this.handlers.ofTopic(event.topic);
    if (!handler) return [];
    const made = await handler.build(event, owner, wanted, maxAudience);
    // A handler makes only its own topic's events, and only those wanted.
    return made?.filter((e) => makes.includes(e.type) && wanted.has(e.type));
  }
}
