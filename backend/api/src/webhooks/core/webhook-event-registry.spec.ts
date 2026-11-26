import {
  defineWebhookEvents,
  registerWebhookEvents,
} from './webhook-event-registry.js';

const things = defineWebhookEvents('things', [
  { type: 'thing.made', topic: 'thing.made', description: 'A thing made.' },
  { type: 'part.made', topic: 'thing.made', description: 'Each of its parts.' },
]);
const others = defineWebhookEvents('others', [
  { type: 'other.gone', topic: 'other.gone', description: 'Another gone.' },
]);

describe('registerWebhookEvents', () => {
  it('lists each group’s events in the order given, with their group', () => {
    expect(registerWebhookEvents([things, others])).toEqual([
      { ...things.events[0], group: 'things' },
      { ...things.events[1], group: 'things' },
      { ...others.events[0], group: 'others' },
    ]);
  });

  it('refuses a type registered twice, so no group replaces another’s', () => {
    const replaced = defineWebhookEvents('rival', [
      { type: 'thing.made', topic: 'rival.made', description: 'Not yours.' },
    ]);
    expect(() => registerWebhookEvents([things, replaced])).toThrow(
      'The webhook event "thing.made" is registered by things and by rival',
    );
    expect(() => registerWebhookEvents([things, things])).toThrow(
      'The webhook event "thing.made" is registered by things and by things',
    );
  });

  it('refuses events of another group’s topic', () => {
    const widened = defineWebhookEvents('rival', [
      { type: 'rival.heard', topic: 'thing.made', description: 'Overheard.' },
    ]);
    expect(() => registerWebhookEvents([things, widened])).toThrow(
      'The outbox topic "thing.made" makes webhook events of things and of rival',
    );
  });

  it('lets a group register in two lists, to keep an order', () => {
    const later = defineWebhookEvents('things', [
      { type: 'thing.gone', topic: 'thing.made', description: 'Gone again.' },
    ]);
    expect(
      registerWebhookEvents([things, others, later]).map((e) => e.type),
    ).toEqual(['thing.made', 'part.made', 'other.gone', 'thing.gone']);
  });

  it('refuses the test event', () => {
    const ping = defineWebhookEvents('rival', [
      { type: 'ping', topic: 'rival.ping', description: 'A ping.' },
    ]);
    expect(() => registerWebhookEvents([ping])).toThrow(
      'The webhook event "ping" of rival is the test event',
    );
  });

  it('freezes a component’s events as they are defined', () => {
    expect(Object.isFrozen(things)).toBe(true);
    expect(Object.isFrozen(things.events[0])).toBe(true);
    expect(() =>
      (things.events as unknown as object[]).push({ type: 'thing.stolen' }),
    ).toThrow(TypeError);
  });

  it('freezes what it lists', () => {
    const registered = registerWebhookEvents([things]);
    expect(Object.isFrozen(registered)).toBe(true);
    expect(registered.every((e) => Object.isFrozen(e))).toBe(true);
  });
});
