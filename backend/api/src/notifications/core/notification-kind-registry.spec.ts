import {
  defineNotificationKinds,
  type NotificationKindDefinition,
  registerNotificationKinds,
} from './notification-kind-registry.js';

const SECTIONS = ['work', 'alerts'];

const things = defineNotificationKinds('things', [
  { kind: 'thing.made', section: 'work', defaultChoice: 'email' },
  { kind: 'thing.broken', section: 'alerts', defaultChoice: 'app' },
]);
const alarms = defineNotificationKinds('alarms', [
  { kind: 'alarm.raised', chosen: false },
]);

const odd = (definition: object) =>
  defineNotificationKinds('odd', [
    definition as unknown as NotificationKindDefinition,
  ]);

describe('registerNotificationKinds', () => {
  it('lists each group’s kinds in the order given, with their group', () => {
    expect(registerNotificationKinds([things, alarms], SECTIONS)).toEqual([
      { ...things.kinds[0], group: 'things' },
      { ...things.kinds[1], group: 'things' },
      { kind: 'alarm.raised', chosen: false, group: 'alarms' },
    ]);
  });

  it('refuses a kind registered twice, so none is replaced or made one nobody can turn off', () => {
    const silenced = defineNotificationKinds('rival', [
      { kind: 'thing.made', chosen: false },
    ]);
    expect(() =>
      registerNotificationKinds([things, silenced], SECTIONS),
    ).toThrow(
      'The notification kind "thing.made" is registered by things and by rival',
    );
    const offByDefault = defineNotificationKinds('rival', [
      { kind: 'alarm.raised', section: 'alerts', defaultChoice: 'off' },
    ]);
    expect(() =>
      registerNotificationKinds([alarms, offByDefault], SECTIONS),
    ).toThrow(
      'The notification kind "alarm.raised" is registered by alarms and by rival',
    );
    expect(() => registerNotificationKinds([things, things], SECTIONS)).toThrow(
      'The notification kind "thing.made" is registered by things and by things',
    );
  });

  it('refuses a chosen flag that is not false, and a kind nobody chooses about with a section or default', () => {
    expect(() =>
      registerNotificationKinds(
        [odd({ kind: 'odd.one', chosen: true })],
        SECTIONS,
      ),
    ).toThrow(
      'The notification kind "odd.one" of odd has chosen set to something other than false',
    );
    expect(() =>
      registerNotificationKinds(
        [odd({ kind: 'odd.one', chosen: false, defaultChoice: 'off' })],
        SECTIONS,
      ),
    ).toThrow(
      'The notification kind "odd.one" of odd is chosen by nobody but has a section or a default',
    );
  });

  it('reads only a definition’s own fields, so an inherited one never decides what can be turned off', () => {
    const inherited = Object.assign(Object.create({ chosen: false }), {
      kind: 'alarm.raised',
    }) as NotificationKindDefinition;
    expect(() =>
      registerNotificationKinds(
        [{ group: 'alarms', kinds: [inherited] }],
        SECTIONS,
      ),
    ).toThrow(
      'The notification kind "alarm.raised" of alarms has the section "undefined", which is not listed',
    );
  });

  it('refuses a kind that is no topic name', () => {
    for (const kind of ['__proto__', 'constructor', 'Thing.Made', 'thing'])
      expect(() =>
        registerNotificationKinds(
          [odd({ kind, section: 'work', defaultChoice: 'app' })],
          SECTIONS,
        ),
      ).toThrow(`The notification kind "${kind}" of odd is no topic name`);
  });

  it('refuses a section not listed and a default that is no delivery choice', () => {
    expect(() =>
      registerNotificationKinds(
        [odd({ kind: 'odd.one', section: 'elsewhere', defaultChoice: 'app' })],
        SECTIONS,
      ),
    ).toThrow(
      'The notification kind "odd.one" of odd has the section "elsewhere", which is not listed',
    );
    expect(() =>
      registerNotificationKinds(
        [odd({ kind: 'odd.one', section: 'work', defaultChoice: 'loud' })],
        SECTIONS,
      ),
    ).toThrow(
      'The notification kind "odd.one" of odd has the default "loud", which is no delivery choice',
    );
  });

  it('freezes a component’s kinds as they are defined, and what it lists', () => {
    expect(Object.isFrozen(things)).toBe(true);
    expect(Object.isFrozen(things.kinds[0])).toBe(true);
    expect(() =>
      (things.kinds as unknown as object[]).push({ kind: 'thing.stolen' }),
    ).toThrow(TypeError);
    const registered = registerNotificationKinds([things], SECTIONS);
    expect(Object.isFrozen(registered)).toBe(true);
    expect(registered.every((k) => Object.isFrozen(k))).toBe(true);
  });
});
