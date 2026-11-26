/**
 * One webhook event, as the component that writes its outbox row registers it. A subscriber
 * subscribes to it by `type`; the webhooks make it from each outbox row of `topic`.
 */
export interface WebhookEventDefinition {
  /** What subscribers subscribe to and receive as `type`, e.g. `manual.released`. Never renamed. */
  readonly type: string;
  /** The outbox topic it is made from, e.g. `release.published`. */
  readonly topic: string;
  /** What it tells, for whoever reads the code. */
  readonly description: string;
}

/** A component's webhook events (`defineWebhookEvents`), under the component's name as their group. */
export interface WebhookEventGroup<
  E extends readonly WebhookEventDefinition[] =
    readonly WebhookEventDefinition[],
> {
  readonly group: string;
  readonly events: E;
}

/** A registered webhook event: its definition and the group that registered it. */
export type RegisteredWebhookEvent<T extends string = string> =
  WebhookEventDefinition & { readonly type: T; readonly group: string };

/** The test event's type (`ping`): the webhooks' own, never a component's. */
export const RESERVED_WEBHOOK_EVENT = 'ping';

/**
 * A component's webhook events under its name, for `src/webhook-events.ts` to register. The types
 * stay literal types, so a subscription to an event nobody registered does not compile.
 */
export function defineWebhookEvents<
  const E extends readonly WebhookEventDefinition[],
>(group: string, events: E): WebhookEventGroup<E> {
  // Frozen, so no other module adds to a component's events before they are registered.
  return Object.freeze({
    group,
    events: Object.freeze(events.map((e) => Object.freeze({ ...e }))) as E,
  });
}

/**
 * Every group's events in the order given, each frozen, the list too. The API does not start
 * when a type is registered twice (within a group or across two), when a group registers the
 * test event `ping`, or when two groups make events from the same topic: a component can neither
 * replace another's event nor make events of another's outbox rows.
 *
 * A `<component>.webhook-events.ts` imports nothing but this file: `core/webhook.ts` reads the
 * registry as it is imported, so an events file that reached it would be a cycle.
 */
export function registerWebhookEvents<
  const G extends readonly WebhookEventGroup[],
>(
  groups: G,
): readonly RegisteredWebhookEvent<G[number]['events'][number]['type']>[] {
  const ownerOfType = new Map<string, string>();
  const ownerOfTopic = new Map<string, string>();
  const registered: RegisteredWebhookEvent<
    G[number]['events'][number]['type']
  >[] = [];
  for (const { group, events } of groups)
    for (const event of events) {
      if (event.type === RESERVED_WEBHOOK_EVENT)
        throw new Error(
          `The webhook event "${event.type}" of ${group} is the test event`,
        );
      const first = ownerOfType.get(event.type);
      if (first !== undefined)
        throw new Error(
          `The webhook event "${event.type}" is registered by ${first} and by ${group}`,
        );
      const topicOwner = ownerOfTopic.get(event.topic);
      if (topicOwner !== undefined && topicOwner !== group)
        throw new Error(
          `The outbox topic "${event.topic}" makes webhook events of ${topicOwner} and of ${group}`,
        );
      ownerOfType.set(event.type, group);
      ownerOfTopic.set(event.topic, group);
      registered.push(Object.freeze({ ...event, group }));
    }
  return Object.freeze(registered);
}
