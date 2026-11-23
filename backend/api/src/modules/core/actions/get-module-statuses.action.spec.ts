import { type Module, ProjectConfig } from '@openfolia/content-model';
import { actorWith, READER } from '../../../../tests/fakes/actors.js';
import {
  config as baseConfig,
  type FakeContent,
  module,
} from '../../../../tests/fakes/fake-content.js';
import { FakeHistory } from '../../../../tests/fakes/fake-history.js';
import type { Actor, Scope } from '../../../access/core/actor.js';
import type { Permission } from '../../../access/core/permissions.js';
import { ChangeSetTouches } from '../../../change-sets/core/change-set-touches.js';
import { ReadableRefs } from '../../../content/core/readable-refs.js';
import {
  followsChangeSets,
  GetModuleStatusesAction,
} from './get-module-statuses.action.js';

const config = ProjectConfig.parse({
  ...baseConfig,
  audiences: [
    { id: 'public', label: 'Public' },
    { id: 'internal', label: 'Internal' },
  ],
});
const user = (
  id: string,
  permissions: Permission[],
  scope: Scope = {},
): Actor => ({ ...actorWith(permissions, scope), id });
const author = user('sample-author', ['content.read', 'content.edit']);
const other = user('other-author', ['content.read', 'content.edit']);
const reviewer = user('sample-reviewer', [
  'content.read',
  'content.read.draft',
]);
const publicReviewer = user(
  'public-reviewer',
  ['content.read', 'content.read.draft'],
  { maxAudience: 'public' },
);

const internal = (m: Module): Module => ({
  ...m,
  meta: { ...m.meta, audience: 'internal' },
});
const at = (...modules: Module[]): FakeContent => ({ config, modules });

/**
 * v1 holds `charging` (first text) and `old`; v2 `charging` as on main
 * now and `old` made internal; main also has `fresh`, never released.
 */
function setUp() {
  const v1 = at(module('charging', 'en', 'First.'), module('old'));
  const now = at(module('charging'), internal(module('old')), module('fresh'));
  const history = new FakeHistory(now);
  history.tag('v1', history.commit(v1).commit);
  history.tag('v2', history.heads.get('main') as string);
  const action = new GetModuleStatusesAction(
    new ReadableRefs(history),
    history.openSnapshot,
    new ChangeSetTouches(history.store, history.branches, history.openSnapshot),
  );
  const statuses = async (actor: Actor, ref = 'main', ...ids: string[]) =>
    action.handle({
      actor,
      snapshot: await history.openSnapshot.handle({ actor, ref }),
      modules: (ids.length ? ids : ['charging']).map((id) => ({
        id,
        lang: 'en',
      })),
    });
  return { history, now, statuses };
}

describe('GetModuleStatusesAction, deprecation (#266)', () => {
  it('names the source-language file’s deprecation for every language, else the file’s own', async () => {
    const deprecated = { reason: 'Superseded.', replacedBy: 'fresh' };
    const charging = module('charging');
    const history = new FakeHistory(
      at(
        { ...charging, meta: { ...charging.meta, deprecated } },
        module('charging', 'de'),
        module('fresh'),
        {
          ...module('only', 'de'),
          meta: {
            ...module('only', 'de').meta,
            deprecated: { reason: 'Old.' },
          },
        },
      ),
    );
    const action = new GetModuleStatusesAction(
      new ReadableRefs(history),
      history.openSnapshot,
      new ChangeSetTouches(
        history.store,
        history.branches,
        history.openSnapshot,
      ),
    );
    const found = await action.handle({
      actor: READER,
      snapshot: await history.openSnapshot.handle({
        actor: READER,
        ref: 'main',
      }),
      modules: [
        { id: 'charging', lang: 'en' },
        { id: 'charging', lang: 'de' },
        { id: 'fresh', lang: 'en' },
        { id: 'only', lang: 'de' },
      ],
    });
    expect(found.get('en/charging')?.deprecated).toEqual(deprecated);
    expect(found.get('de/charging')?.deprecated).toEqual(deprecated);
    expect(found.get('en/fresh')?.deprecated).toBeNull();
    expect(found.get('de/only')?.deprecated).toEqual({ reason: 'Old.' });
  });
});

describe('GetModuleStatusesAction', () => {
  it('names the newest release holding a module and main, each compared with the one read', async () => {
    const { history, statuses } = setUp();
    const main = history.heads.get('main');
    const found = await statuses(reviewer, 'main', 'charging', 'fresh');
    expect(found.get('en/charging')).toEqual({
      release: { tag: 'v2', commit: main, same: true },
      main: { commit: main, same: true },
      changeSets: [],
      deprecated: null,
    });
    expect(found.get('en/fresh')).toMatchObject({
      release: { tag: 'v2', same: true },
    });
    const old = await statuses(reviewer, 'v1');
    expect(old.get('en/charging')).toMatchObject({
      release: { tag: 'v2', same: false },
      main: { same: false },
    });
  });

  it('skips a release where the module lies outside the reader’s scope', async () => {
    const { history, statuses } = setUp();
    const v1 = history.tags[1]?.commit;
    // `old` is internal on v2 and main: for a public reader only v1 holds it.
    expect((await statuses(publicReviewer, 'v1', 'old')).get('en/old')).toEqual(
      {
        release: { tag: 'v1', commit: v1, same: true },
        main: null,
        changeSets: [],
        deprecated: null,
      },
    );
  });

  it('shows a released module with an open change set as both', async () => {
    const { history, now, statuses } = setUp();
    const changeSet = history.changeSet(author, {
      ...now,
      modules: [module('charging', 'en', 'Changed.'), ...now.modules!.slice(1)],
    });
    const status = (await statuses(reviewer)).get('en/charging');
    expect(status).toMatchObject({
      release: { tag: 'v2', same: true },
      changeSets: [{ id: changeSet.id, state: 'draft' }],
    });
    // The author sees their own; another author nobody else's.
    expect((await statuses(author)).get('en/charging')?.changeSets).toEqual([
      { id: changeSet.id, state: 'draft' },
    ]);
    expect((await statuses(other)).get('en/charging')?.changeSets).toEqual([]);
  });

  it('names change sets newest first, open ones only, only those changing the module', async () => {
    const { history, now, statuses } = setUp();
    const changed = at(
      module('charging', 'en', 'Changed.'),
      ...now.modules!.slice(1),
    );
    const first = history.changeSet(author, changed);
    history.changeSet(author, changed, { state: 'abandoned' });
    history.changeSet(author, now);
    const reviewed = history.changeSet(other, changed, {
      state: 'in-review',
    });
    history.store.changeSets[history.store.changeSets.length - 1] = {
      ...reviewed,
      reviewHead: history.heads.get(reviewed.branch) as string,
    };
    expect((await statuses(reviewer)).get('en/charging')?.changeSets).toEqual([
      { id: reviewed.id, state: 'in-review' },
      { id: first.id, state: 'draft' },
    ]);
  });

  it('names no change set where the reader sees the module on neither of its sides', async () => {
    const { history, now, statuses } = setUp();
    // `old` is internal at the base and on the change set's head.
    history.changeSet(author, {
      ...now,
      modules: [
        module('charging'),
        internal(module('old', 'en', 'Changed.')),
        module('fresh'),
      ],
    });
    expect(
      (await statuses(publicReviewer, 'v1', 'old')).get('en/old')?.changeSets,
    ).toEqual([]);
    expect(
      (await statuses(reviewer, 'main', 'old')).get('en/old')?.changeSets,
    ).toHaveLength(1);
  });

  it('tells a consumer of released content nothing of change sets', async () => {
    const { history, now, statuses } = setUp();
    history.changeSet(author, {
      ...now,
      modules: [module('charging', 'en', 'Changed.')],
    });
    expect(followsChangeSets(READER)).toBe(false);
    expect(followsChangeSets(author)).toBe(true);
    expect(followsChangeSets(reviewer)).toBe(true);
    const status = (await statuses(READER)).get('en/charging');
    expect(status).toMatchObject({ release: { tag: 'v2' } });
    expect(status).not.toHaveProperty('changeSets');
  });

  it('has no release for a module no release holds', async () => {
    const history = new FakeHistory(at(module('charging')));
    const action = new GetModuleStatusesAction(
      new ReadableRefs(history),
      history.openSnapshot,
      new ChangeSetTouches(
        history.store,
        history.branches,
        history.openSnapshot,
      ),
    );
    const found = await action.handle({
      actor: reviewer,
      snapshot: await history.openSnapshot.handle({
        actor: reviewer,
        ref: 'main',
      }),
      modules: [{ id: 'charging', lang: 'en' }],
    });
    expect(found.get('en/charging')?.release).toBeNull();
  });
});
