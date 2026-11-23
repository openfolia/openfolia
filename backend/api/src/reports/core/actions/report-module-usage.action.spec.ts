import { ProjectConfig, type Module } from '@openfolia/content-model';
import { actorWith } from '../../../../tests/fakes/actors.js';
import {
  config as baseConfig,
  manifest,
  module,
} from '../../../../tests/fakes/fake-content.js';
import { FakeHistory } from '../../../../tests/fakes/fake-history.js';
import {
  fakeModuleIndex,
  referring,
} from '../../../../tests/fakes/fake-module-index-store.js';
import type { Actor, Scope } from '../../../access/core/actor.js';
import { ForbiddenError } from '../../../base/core/errors.js';
import type { UsageFilter, UsageSort } from '../module-usage-report.js';
import { ReportModuleUsageAction } from './report-module-usage.action.js';

const config = ProjectConfig.parse({
  ...baseConfig,
  languages: { source: 'en', targets: ['de'] },
  moduleTypes: [
    { id: 'concept', label: 'Concept' },
    { id: 'procedure', label: 'Procedure' },
  ],
  audiences: [
    { id: 'public', label: 'Public' },
    { id: 'internal', label: 'Internal' },
  ],
});

const titled = (
  m: Module,
  title: string,
  meta: Partial<Module['meta']> = {},
) => ({
  ...m,
  meta: { ...m.meta, title, ...meta },
});

/**
 * The guide includes `intro` and `steps`; `steps` refers to `note`, so
 * `note` is used only through a module reference. `orphan` is in no manual,
 * though `lonely` (in no manual either) refers to it. `secret`, internal,
 * refers to `intro`; `hidden` (internal) is used by nothing.
 */
const history = new FakeHistory({
  config,
  modules: [
    titled(module('intro'), 'Introduction'),
    titled(module('intro', 'de'), 'Einleitung'),
    titled(referring(module('steps'), 'note'), 'Steps', { type: 'procedure' }),
    titled(module('note'), 'Note'),
    titled(module('orphan'), 'Orphan', { deprecated: { reason: 'Old.' } }),
    titled(referring(module('lonely'), 'orphan'), 'Lonely'),
    titled(referring(module('secret'), 'intro'), 'Secret', {
      audience: 'internal',
    }),
    titled(module('hidden'), 'Hidden', { audience: 'internal' }),
  ],
  manifests: [manifest('guide', ['intro', 'steps'])],
});
const action = new ReportModuleUsageAction(fakeModuleIndex(history).readable);
const lead = (scope: Scope = {}): Actor =>
  actorWith(['content.read', 'content.read.draft'], scope);

async function rows(
  filter: UsageFilter = {},
  actor: Actor = lead(),
  sort?: UsageSort[],
) {
  const snapshot = await history.openSnapshot.handle({ actor, ref: 'main' });
  return (
    await action.handle({
      actor,
      snapshot,
      filter,
      sort,
      page: { number: 1, size: 50 },
    })
  ).items.map(
    (r) =>
      `${r.moduleId} ${r.manuals}/${r.modules} [${r.languages.join(' ')}]${r.deprecated ? ' deprecated' : ''}`,
  );
}

describe('ReportModuleUsageAction', () => {
  it('lists every module with its use counts, by title', async () => {
    expect(await rows()).toEqual([
      'hidden 0/0 [en]',
      'intro 1/1 [en de]',
      'lonely 0/0 [en]',
      'note 1/1 [en]',
      'orphan 0/1 [en] deprecated',
      'secret 0/0 [en]',
      'steps 1/0 [en]',
    ]);
  });

  it('finds the unused modules: none included only through a module reference', async () => {
    expect(await rows({ unused: true })).toEqual([
      'hidden 0/0 [en]',
      'lonely 0/0 [en]',
      'orphan 0/1 [en] deprecated',
      'secret 0/0 [en]',
    ]);
    expect(await rows({ unused: false })).toEqual([
      'intro 1/1 [en de]',
      'note 1/1 [en]',
      'steps 1/0 [en]',
    ]);
  });

  it('filters by type and sorts by use count', async () => {
    expect(await rows({ type: 'procedure' })).toEqual(['steps 1/0 [en]']);
    expect(await rows({ type: 'nope' })).toEqual([]);
    expect(
      (await rows({}, lead(), [{ field: 'usage', descending: true }])).slice(
        0,
        3,
      ),
    ).toEqual([
      'intro 1/1 [en de]',
      'note 1/1 [en]',
      'orphan 0/1 [en] deprecated',
    ]);
  });

  it('names and counts nothing outside the reader’s scope', async () => {
    // Public only: no `secret`, no `hidden`, and `intro`'s use by `secret` goes.
    expect(await rows({}, lead({ maxAudience: 'public' }))).toEqual([
      'intro 1/0 [en de]',
      'lonely 0/0 [en]',
      'note 1/1 [en]',
      'orphan 0/1 [en] deprecated',
      'steps 1/0 [en]',
    ]);
    // Concepts only: `steps` is hidden, so the guide reaches `note` through nothing they see.
    expect(
      await rows(
        { unused: true },
        lead({ moduleTypes: ['concept'], maxAudience: 'public' }),
      ),
    ).toEqual([
      'lonely 0/0 [en]',
      'note 0/0 [en]',
      'orphan 0/1 [en] deprecated',
    ]);
    // German only: one file to see.
    expect(await rows({}, lead({ languages: ['de'] }))).toEqual([
      'intro 1/0 [de]',
    ]);
  });

  it('needs content.read.draft', async () => {
    const actor = actorWith(['content.read']);
    const snapshot = await history.openSnapshot.handle({ actor, ref: 'main' });
    await expect(
      action.handle({ actor, snapshot, filter: {} }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
