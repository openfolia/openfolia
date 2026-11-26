import { readFileSync } from 'node:fs';
import {
  DELIVERY_EVENTS,
  DeliveryEvent,
  WEBHOOK_EVENTS,
  WebhookEvent,
} from './webhooks/core/webhook.js';
import { TOPIC_EVENTS } from './webhooks/core/webhook-events.js';
import { REGISTERED_WEBHOOK_EVENTS } from './webhook-events.js';
import { definedGroups } from '../tests/registered-groups.js';

// Every webhook event there was before the components registered their own: the same types in
// the same order (the API's enum, the OpenAPI document and the webhooks reference list them in
// it), each made from the same outbox topic. A change here changes what subscribers receive.
const TODAY = [
  { type: 'manual.released', group: 'releases', topic: 'release.published' },
  { type: 'module.released', group: 'releases', topic: 'release.published' },
  {
    type: 'module.deprecated',
    group: 'change-sets',
    topic: 'module.deprecated',
  },
  {
    type: 'manual.deprecated',
    group: 'change-sets',
    topic: 'manual.deprecated',
  },
  { type: 'release.withdrawn', group: 'releases', topic: 'release.withdrawn' },
  {
    type: 'translation.imported',
    group: 'translations',
    topic: 'translation.imported',
  },
];

describe('the registered webhook events', () => {
  it('yields exactly the events there were, in their order, each from its topic', () => {
    expect(
      REGISTERED_WEBHOOK_EVENTS.map((e) => ({
        type: e.type,
        group: e.group,
        topic: e.topic,
      })),
    ).toEqual(TODAY);
    for (const event of REGISTERED_WEBHOOK_EVENTS)
      expect(event.description.length, event.type).toBeGreaterThan(0);
  });

  it('gives the webhooks the same lists', () => {
    const types = TODAY.map((e) => e.type);
    expect([...WEBHOOK_EVENTS]).toEqual(types);
    expect(WebhookEvent.options).toEqual(types);
    expect([...DELIVERY_EVENTS]).toEqual([...types, 'ping']);
    expect(DeliveryEvent.options).toEqual([...types, 'ping']);
    expect(TOPIC_EVENTS).toEqual({
      'release.published': ['manual.released', 'module.released'],
      'release.withdrawn': ['release.withdrawn'],
      'module.deprecated': ['module.deprecated'],
      'manual.deprecated': ['manual.deprecated'],
      'translation.imported': ['translation.imported'],
    });
  });

  it('matches what the stored subscribers and deliveries admit, so a new event brings its migration', () => {
    const tables = readFileSync(
      new URL('./webhooks/repos/webhooks.tables.ts', import.meta.url),
      'utf8',
    );
    const admitted = (check: string) => {
      const sql = new RegExp(`'${check}',\\s*sql\`([^\`]*)\``).exec(tables);
      return [...(sql?.[1] ?? '').matchAll(/'([a-z.-]+)'/g)].map((m) => m[1]);
    };
    expect(admitted('webhooks_events')).toEqual([...WEBHOOK_EVENTS]);
    expect(admitted('webhook_deliveries_event')).toEqual([...DELIVERY_EVENTS]);
  });

  it('names each group after the component whose folder defines it, so none passes for another', async () => {
    const groups = await definedGroups('./webhook-events.ts');
    for (const { folder, group } of groups) expect(group).toBe(folder);
    // Each registered event under the group of the file that defines it, so none is registered
    // under another name than its file's.
    expect(
      groups.flatMap((g) => g.members.map((m) => `${g.group} ${m}`)).sort(),
    ).toEqual(
      REGISTERED_WEBHOOK_EVENTS.map((e) => `${e.group} ${e.type}`).sort(),
    );
  });

  it('keeps the types literal, so an event nobody registered does not compile', () => {
    // @ts-expect-error: no component registers it.
    const unknown: WebhookEvent = 'manual.flown';
    expect(WebhookEvent.safeParse(unknown).success).toBe(false);
    expect(WebhookEvent.safeParse('ping').success).toBe(false);
  });

  it('cannot be changed once registered', () => {
    expect(Object.isFrozen(REGISTERED_WEBHOOK_EVENTS)).toBe(true);
    expect(REGISTERED_WEBHOOK_EVENTS.every((e) => Object.isFrozen(e))).toBe(
      true,
    );
    expect(Object.isFrozen(WEBHOOK_EVENTS)).toBe(true);
    expect(Object.isFrozen(DELIVERY_EVENTS)).toBe(true);
    expect(Object.isFrozen(TOPIC_EVENTS)).toBe(true);
    expect(TOPIC_EVENTS['constructor']).toBeUndefined();
    expect(
      Object.values(TOPIC_EVENTS).every((events) => Object.isFrozen(events)),
    ).toBe(true);
  });
});
