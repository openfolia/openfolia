import type { Actor } from '../../access/core/actor.js';
import { allowsUnrestricted } from '../../access/core/allows.js';
import type { OutboxEvent } from '../../outbox/core/outbox-feed.js';
import { REGISTERED_WEBHOOK_EVENTS } from '../../webhook-events.js';
import {
  WEBHOOK_EVENTS,
  type WebhookEvent,
  type WebhookOwner,
} from './webhook.js';
import type { WebhookVisibility } from './webhook-store.js';

/** One event for one subscriber: what goes into its body. */
export interface OutgoingEvent {
  readonly type: WebhookEvent;
  /** The same for the same event whoever reads it, however often: SHA-256 hex. */
  readonly idempotencyKey: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * How a component's webhook events are made and who may know of them: one per group of
 * `src/webhook-events.ts`, provided by the component that registered the group (its module's
 * providers, through dependency injection), so `webhooks/` names no event. `WebhookEventHandlers`
 * finds every one as the API starts.
 *
 * What the webhooks hold for every event, before a handler is asked: the owner reads content
 * somewhere (`content.read`), the subscriber wants one of the events the row's topic makes, and
 * only those of its events the subscriber wants are kept of what `build` answers; a reader
 * covers any owner only with `content.read` restricting nothing. A handler can only narrow that.
 */
export abstract class WebhookEventHandler {
  /** The group it makes the events of: its component's, as `defineWebhookEvents` named it. */
  abstract readonly group: string;

  /**
   * What an outbox row of one of its group's topics tells one subscriber, as `owner` may read it
   * (`maxAudience`: the subscriber's audience limit, #254; null for none). Undefined: the row's
   * payload is not what its topic writes. A domain error refuses the row for this owner only; any
   * other error retries the row.
   */
  abstract build(
    event: OutboxEvent,
    owner: Actor,
    wanted: ReadonlySet<WebhookEvent>,
    maxAudience: string | null,
  ): Promise<OutgoingEvent[] | undefined>;

  /**
   * Whether `actor`, whose `content.read` restricts nothing, also reads what any owner of a
   * subscriber to `type` (one of its group's events) could be sent: who may see such a
   * subscriber, change it, and read its deliveries' bodies.
   */
  abstract coversAnyOwner(actor: Actor, type: WebhookEvent): boolean;
}

/**
 * Every component's handler, one per registered group (`src/webhook-events.ts`), looked up by
 * the group of an event or a topic. Empty until `load`, which `WebhookEventHandlersLoader` calls
 * with the app's handlers as it starts: the API does not start when a registered group has no
 * handler, a group has two, or a handler's group registers no event.
 */
export class WebhookEventHandlers {
  private loaded?: {
    readonly byType: ReadonlyMap<string, WebhookEventHandler>;
    readonly byTopic: ReadonlyMap<string, WebhookEventHandler>;
  };

  /** Loaded at once with `handlers` when given (tests). */
  constructor(handlers?: readonly WebhookEventHandler[]) {
    if (handlers) this.load(handlers);
  }

  /** Takes the handlers, once. */
  load(handlers: readonly WebhookEventHandler[]): void {
    if (this.loaded)
      throw new Error('The webhook event handlers are loaded already.');
    const groups = new Set(REGISTERED_WEBHOOK_EVENTS.map((e) => e.group));
    const byGroup = new Map<string, WebhookEventHandler>();
    for (const handler of new Set(handlers)) {
      // Read once: what it says later changes nothing.
      const { group } = handler;
      if (!groups.has(group))
        throw new Error(
          `A webhook event handler for ${group}, which registers no webhook event`,
        );
      if (byGroup.has(group))
        throw new Error(`Two webhook event handlers for ${group}`);
      byGroup.set(group, handler);
    }
    const missing = [...groups].filter((g) => !byGroup.has(g));
    if (missing.length > 0)
      throw new Error(
        `No webhook event handler for ${missing.join(', ')}: each component that registers webhook events provides one`,
      );
    const byType = new Map<string, WebhookEventHandler>();
    const byTopic = new Map<string, WebhookEventHandler>();
    for (const { type, topic, group } of REGISTERED_WEBHOOK_EVENTS) {
      const handler = byGroup.get(group)!;
      byType.set(type, handler);
      byTopic.set(topic, handler);
    }
    this.loaded = { byType, byTopic };
  }

  /** The handler of the group that makes events of `topic`; undefined when none does. */
  ofTopic(topic: string): WebhookEventHandler | undefined {
    return this.handlers().byTopic.get(topic);
  }

  /**
   * Whether `actor` reads at least what any owner of a subscriber to `events` could:
   * `content.read` restricting nothing, and what each event's handler adds.
   */
  coversAnyOwner(actor: Actor, events: readonly WebhookEvent[]): boolean {
    if (!allowsUnrestricted(actor, 'content.read')) return false;
    const { byType } = this.handlers();
    return events.every((type) => {
      const handler = byType.get(type);
      // Fails closed: an event no handler makes is covered by nobody.
      return handler !== undefined && handler.coversAnyOwner(actor, type);
    });
  }

  /**
   * The subscribers `actor` sees as a store filter (`seesWebhook`): every one when they cover
   * any owner of every event; else their own and, when their `content.read` restricts nothing,
   * those subscribed to none of the events they do not cover.
   */
  visibleTo(actor: Actor, owner: WebhookOwner): WebhookVisibility {
    if (this.coversAnyOwner(actor, WEBHOOK_EVENTS)) return 'all';
    if (!this.coversAnyOwner(actor, [])) return { owner };
    return {
      owner,
      orWithout: WEBHOOK_EVENTS.filter((e) => !this.coversAnyOwner(actor, [e])),
    };
  }

  private handlers() {
    if (!this.loaded)
      throw new Error('The webhook event handlers have not been loaded.');
    return this.loaded;
  }
}
