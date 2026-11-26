import {
  CHOSEN_KINDS,
  ChosenKind,
  NOTIFICATION_KINDS,
  NotificationKind,
  NotificationSubjectType,
  SUBJECT_TYPES,
} from './notifications/core/notification.js';
import {
  DEFAULT_CHOICES,
  DEFAULT_NOTIFICATION_SETTINGS,
  DELIVERY_CHOICES,
  deliveryOf,
  NOTIFICATION_GROUPS,
} from './preferences/core/notification-settings.js';
import { REGISTERED_NOTIFICATION_KINDS } from './notification-kinds.js';
import { definedGroups } from '../tests/registered-groups.js';

// Every notification kind there was before the components registered their own, in order (the
// API's enums, the OpenAPI document and the preferences' `choices` list them in it), each with
// the component that writes its outbox row, the settings page's group it is shown in and what a
// person who chose nothing gets. `sign-in.break-glass` is chosen by nobody: it cannot be turned
// off. A change here changes who is told what.
const TODAY = [
  ['change-set.submit', 'change-sets', 'review', 'email'],
  ['change-set.return', 'change-sets', 'review', 'email'],
  ['change-set.approve', 'change-sets', 'review', 'email'],
  ['change-set.sign-off', 'change-sets', 'review', 'email'],
  ['change-set.merge', 'change-sets', 'review', 'email'],
  ['lock.break', 'change-sets', 'review', 'app'],
  ['translation.imported', 'translations', 'translations', 'digest'],
  ['translation.import-failed', 'translations', 'translations', 'digest'],
  ['release.published', 'releases', 'releases', 'digest'],
  ['release.output-failed', 'releases', 'admin', 'email'],
  ['release.output-recovered', 'releases', 'releases', 'digest'],
  ['backup.failed', 'backups', 'admin', 'email'],
  ['backup.overdue', 'backups', 'admin', 'email'],
  ['sign-in.break-glass', 'access', null, null],
] as const;

describe('the registered notification kinds', () => {
  it('yields exactly the kinds there were, in their order, with their group and default', () => {
    expect(
      REGISTERED_NOTIFICATION_KINDS.map((k) => [
        k.kind,
        k.group,
        'chosen' in k ? null : k.section,
        'chosen' in k ? null : k.defaultChoice,
      ]),
    ).toEqual(TODAY);
  });

  it('gives the notifications and the preferences the same lists, in the same order', () => {
    const kinds = TODAY.map(([kind]) => kind);
    const chosen = TODAY.filter(([, , section]) => section !== null).map(
      ([kind]) => kind,
    );
    expect([...NOTIFICATION_KINDS]).toEqual(kinds);
    expect(NotificationKind.options).toEqual(kinds);
    expect([...CHOSEN_KINDS]).toEqual(chosen);
    expect(ChosenKind.options).toEqual(chosen);
    expect([...SUBJECT_TYPES]).toEqual([
      'change-set',
      'release',
      'import',
      'backup',
      'user',
    ]);
    expect(NotificationSubjectType.options).toEqual([...SUBJECT_TYPES]);
    expect([...DELIVERY_CHOICES]).toEqual(['off', 'app', 'email', 'digest']);
  });

  it('shows the same groups on the settings page, in the same order', () => {
    expect(Object.keys(NOTIFICATION_GROUPS)).toEqual([
      'review',
      'releases',
      'translations',
      'admin',
    ]);
    expect(NOTIFICATION_GROUPS).toEqual({
      review: [
        'change-set.submit',
        'change-set.return',
        'change-set.approve',
        'change-set.sign-off',
        'change-set.merge',
        'lock.break',
      ],
      releases: ['release.published', 'release.output-recovered'],
      translations: ['translation.imported', 'translation.import-failed'],
      admin: ['release.output-failed', 'backup.failed', 'backup.overdue'],
    });
  });

  it('gives a person who chose nothing the same defaults', () => {
    expect(DEFAULT_CHOICES).toEqual({
      'change-set.submit': 'email',
      'change-set.return': 'email',
      'change-set.approve': 'email',
      'change-set.sign-off': 'email',
      'change-set.merge': 'email',
      'lock.break': 'app',
      'release.published': 'digest',
      'release.output-failed': 'email',
      'release.output-recovered': 'digest',
      'translation.imported': 'digest',
      'translation.import-failed': 'digest',
      'backup.failed': 'email',
      'backup.overdue': 'email',
    });
    // Its keys in the order everything else lists the kinds the person chooses about.
    expect(Object.keys(DEFAULT_CHOICES)).toEqual([...CHOSEN_KINDS]);
  });

  it('never lets anyone turn off the kind nobody chooses about', () => {
    const everythingOff = {
      ...DEFAULT_NOTIFICATION_SETTINGS,
      allOff: true,
      emailPaused: true,
      choices: Object.fromEntries(CHOSEN_KINDS.map((k) => [k, 'off'])),
    };
    expect(deliveryOf(everythingOff, 'sign-in.break-glass')).toBe('app');
    expect(ChosenKind.safeParse('sign-in.break-glass').success).toBe(false);
    for (const kind of CHOSEN_KINDS)
      expect(deliveryOf(everythingOff, kind), kind).toBe('off');
  });

  it('names each group after the component whose folder defines it, so none passes for another', async () => {
    const groups = await definedGroups('./notification-kinds.ts');
    for (const { folder, group } of groups) expect(group).toBe(folder);
    expect(
      groups.flatMap((g) => g.members.map((m) => `${g.group} ${m}`)).sort(),
    ).toEqual(
      REGISTERED_NOTIFICATION_KINDS.map((k) => `${k.group} ${k.kind}`).sort(),
    );
    // What each found group defines is what is registered, not only by name.
    const found = groups.flatMap((g) =>
      (g.value.kinds ?? []).map((k) => ({ ...k, group: g.group })),
    );
    for (const registered of REGISTERED_NOTIFICATION_KINDS)
      expect(found.find((k) => k.kind === registered.kind)).toStrictEqual({
        ...registered,
      });
  });

  it('keeps the kinds literal, so one nobody registered does not compile', () => {
    // @ts-expect-error: no component registers it.
    const unknown: NotificationKind = 'manual.flown';
    expect(NotificationKind.safeParse(unknown).success).toBe(false);
    // @ts-expect-error: nobody chooses about it.
    const unchosen: ChosenKind = 'sign-in.break-glass';
    expect(ChosenKind.safeParse(unchosen).success).toBe(false);
  });

  it('cannot be changed once registered', () => {
    expect(Object.isFrozen(REGISTERED_NOTIFICATION_KINDS)).toBe(true);
    expect(REGISTERED_NOTIFICATION_KINDS.every((k) => Object.isFrozen(k))).toBe(
      true,
    );
    for (const list of [
      NOTIFICATION_KINDS,
      CHOSEN_KINDS,
      SUBJECT_TYPES,
      DEFAULT_CHOICES,
      NOTIFICATION_GROUPS,
      ...Object.values(NOTIFICATION_GROUPS),
    ])
      expect(Object.isFrozen(list)).toBe(true);
  });
});
