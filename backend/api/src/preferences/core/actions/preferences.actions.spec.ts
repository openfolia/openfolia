import { actorWith, NOBODY } from '../../../../tests/fakes/actors.js';
import { FakePreferenceStore } from '../../../../tests/fakes/fake-preference-store.js';
import { API_TOKEN_ACTOR } from '../../../access/core/service-actor.js';
import { ForbiddenError } from '../../../base/core/errors.js';
import { DEFAULT_PREFERENCES } from '../preferences.js';
import { GetPreferencesAction } from './get-preferences.action.js';
import { UpdatePreferencesAction } from './update-preferences.action.js';

const alice = { ...actorWith(['content.read']), id: 'alice' };
const bob = { ...actorWith(['content.edit']), id: 'bob' };

function setup(users?: ReadonlySet<string>) {
  const store = new FakePreferenceStore(users);
  return {
    store,
    get: new GetPreferencesAction(store),
    update: new UpdatePreferencesAction(store),
  };
}

describe('GetPreferencesAction', () => {
  it('answers the defaults before any change', async () => {
    const { get } = setup();
    expect(await get.handle({ actor: alice })).toEqual({
      preferences: DEFAULT_PREFERENCES,
      updatedAt: null,
    });
    expect(DEFAULT_PREFERENCES).toEqual({
      showTips: true,
      dismissedTips: [],
      tourDone: false,
    });
  });

  it('needs no permission, and a service reads the defaults', async () => {
    const { get, update } = setup();
    await update.handle({ actor: NOBODY, changes: { tourDone: true } });
    expect((await get.handle({ actor: NOBODY })).preferences.tourDone).toBe(
      true,
    );
    expect(await get.handle({ actor: API_TOKEN_ACTOR })).toEqual({
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
