import { actorWith, NOBODY } from '../../../../tests/fakes/actors.js';
import { FakeJobQueue } from '../../../../tests/fakes/fake-job-queue.js';
import {
  FakeMailSettings,
  FakeMailStore,
} from '../../../../tests/fakes/fake-mail.js';
import { FakePreferenceStore } from '../../../../tests/fakes/fake-preference-store.js';
import { fakeSealer } from '../../../../tests/fakes/fake-secret-key.js';
import { FakeUserDirectory } from '../../../../tests/fakes/fake-user-directory.js';
import { API_TOKEN_ACTOR } from '../../../access/core/service-actor.js';
import { ForbiddenError } from '../../../base/core/errors.js';
import { MailOutbox } from '../../../mail/core/mail-outbox.js';
import { FixedNotificationEmailOptions } from '../notification-email-options.js';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  deliveryOf,
} from '../notification-settings.js';
import { DEFAULT_PREFERENCES } from '../preferences.js';
import {
  GetPreferencesAction,
  PreferencesViews,
} from './get-preferences.action.js';
import { UpdatePreferencesAction } from './update-preferences.action.js';

const alice = { ...actorWith(['content.read']), id: 'alice' };
const bob = { ...actorWith(['content.edit']), id: 'bob' };

function setup(users?: ReadonlySet<string>) {
  const store = new FakePreferenceStore(users);
  const settings = new FakeMailSettings();
  const directory = new FakeUserDirectory([alice, bob]);
  directory.emails.set(alice.id, 'alice@example.com');
  const views = new PreferencesViews(
    new MailOutbox(settings, new FakeMailStore(), fakeSealer(1), new FakeJobQueue()),
    directory,
    new FixedNotificationEmailOptions(7, 20),
  );
  return {
    store,
    settings,
    get: new GetPreferencesAction(store, views),
    update: new UpdatePreferencesAction(store, views),
  };
}

describe('GetPreferencesAction', () => {
  it('answers the defaults before any change', async () => {
    const { get } = setup();
    expect(await get.handle({ actor: alice })).toEqual({
      preferences: DEFAULT_PREFERENCES,
      updatedAt: null,
      email: { unavailable: null },
      defaultDigestHour: 7,
    });
    expect(DEFAULT_PREFERENCES).toEqual({
      showTips: true,
      dismissedTips: [],
      tourDone: false,
      notifications: DEFAULT_NOTIFICATION_SETTINGS,
    });
  });

  it('needs no permission, and a service reads the defaults', async () => {
    const { get, update } = setup();
    await update.handle({ actor: NOBODY, changes: { tourDone: true } });
    expect((await get.handle({ actor: NOBODY })).preferences.tourDone).toBe(
      true,
    );
    expect(await get.handle({ actor: API_TOKEN_ACTOR })).toMatchObject({
      preferences: DEFAULT_PREFERENCES,
      updatedAt: null,
    });
  });
});

describe('UpdatePreferencesAction', () => {
  it('changes only what it is given, and only the actor’s own', async () => {
    const { get, update } = setup();
    await update.handle({ actor: alice, changes: { tourDone: true } });
    const after = await update.handle({
      actor: alice,
      changes: { dismissedTips: ['content.new-module'] },
    });
    expect(after.preferences).toEqual({
      showTips: true,
      dismissedTips: ['content.new-module'],
      tourDone: true,
      notifications: DEFAULT_NOTIFICATION_SETTINGS,
    });
    expect(after.updatedAt).toBeInstanceOf(Date);
    expect((await get.handle({ actor: bob })).preferences).toEqual(
      DEFAULT_PREFERENCES,
    );
  });

  it('keeps each dismissed tip once, in the order first given', async () => {
    const { update } = setup();
    const after = await update.handle({
      actor: alice,
      changes: { dismissedTips: ['b.tip', 'a.tip', 'b.tip'] },
    });
    expect(after.preferences.dismissedTips).toEqual(['b.tip', 'a.tip']);
  });

  it('writes nothing for an empty change', async () => {
    const { store, update } = setup();
    const after = await update.handle({ actor: alice, changes: {} });
    expect(after.preferences).toEqual(DEFAULT_PREFERENCES);
    expect(store.writes).toBe(0);
  });

  it('refuses a service, which has no preferences', async () => {
    const { store, update } = setup();
    await expect(
      update.handle({ actor: API_TOKEN_ACTOR, changes: { showTips: false } }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(store.writes).toBe(0);
  });

  it('refuses a user that is gone', async () => {
    const { update } = setup(new Set(['bob']));
    await expect(
      update.handle({ actor: alice, changes: { showTips: false } }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('notification settings (#884)', () => {
  it('says why email cannot reach the person', async () => {
    const { get, settings } = setup();
    expect((await get.handle({ actor: bob })).email.unavailable).toBe(
      'no-address',
    );
    settings.publicUrl = null;
    expect((await get.handle({ actor: alice })).email.unavailable).toBe(
      'no-public-url',
    );
    settings.state = 'no-secret-key';
    expect((await get.handle({ actor: alice })).email.unavailable).toBe(
      'no-secret-key',
    );
    settings.state = 'off';
    expect((await get.handle({ actor: alice })).email.unavailable).toBe('off');
  });

  it('merges the choices kind by kind and keeps the other settings', async () => {
    const { update } = setup();
    await update.handle({
      actor: alice,
      changes: {
        notifications: {
          choices: { 'release.published': 'off' },
          timeZone: 'Europe/Vienna',
        },
      },
    });
    const after = await update.handle({
      actor: alice,
      changes: {
        notifications: { choices: { 'backup.failed': 'app' }, digestHour: 6 },
      },
    });
    expect(after.preferences.notifications).toEqual({
      ...DEFAULT_NOTIFICATION_SETTINGS,
      choices: { 'release.published': 'off', 'backup.failed': 'app' },
      timeZone: 'Europe/Vienna',
      digestHour: 6,
    });
  });

  it('writes nothing for an empty notification change', async () => {
    const { store, update } = setup();
    await update.handle({
      actor: alice,
      changes: { notifications: { choices: {} } },
    });
    expect(store.writes).toBe(0);
  });

  it('decides delivery: all off wins, pause keeps email in the app', () => {
    const s = DEFAULT_NOTIFICATION_SETTINGS;
    expect(deliveryOf(s, 'change-set.submit')).toBe('email');
    expect(deliveryOf(s, 'release.published')).toBe('digest');
    expect(deliveryOf(s, 'lock.break')).toBe('app');
    expect(deliveryOf({ ...s, emailPaused: true }, 'change-set.submit')).toBe(
      'app',
    );
    expect(deliveryOf({ ...s, allOff: true }, 'lock.break')).toBe('off');
    expect(
      deliveryOf(
        { ...s, choices: { 'change-set.submit': 'off' } },
        'change-set.submit',
      ),
    ).toBe('off');
  });
});
