import { type Module, ProjectConfig } from '@openfolia/content-model';
import { actorWith, READER } from '../../../../tests/fakes/actors.js';
import {
  config as baseConfig,
  type FakeContent,
  manifest,
  module,
} from '../../../../tests/fakes/fake-content.js';
import { FakeHistory } from '../../../../tests/fakes/fake-history.js';
import {
  fakeModuleIndex,
  referring,
} from '../../../../tests/fakes/fake-module-index-store.js';
import type { Actor } from '../../../access/core/actor.js';
import { ChangeSetTouches } from '../../../change-sets/core/change-set-touches.js';
import { ReadableRefs } from '../../../content/core/readable-refs.js';
import { GetModuleStatusesAction } from './get-module-statuses.action.js';
import {
  ListModulesAction,
  type ModuleListFilter,
  type ModuleSort,
} from './list-modules.action.js';

const config = ProjectConfig.parse({
  ...baseConfig,
  moduleTypes: [
    { id: 'concept', label: 'Concept' },
    { id: 'task', label: 'Task' },
  ],
  facets: [
    {
      id: 'product-line',
      label: 'Product line',
      values: [
        { id: 'lifters', label: 'Lifters' },
        { id: 'tuggers', label: 'Tuggers' },
      ],
    },
    {
      id: 'region',
      label: 'Region',
      values: [{ id: 'north', label: 'North' }],
    },
  ],
});
const shaped = (
  m: Module,
  over: Partial<Module['meta']>,
  title = m.meta.title,
): Module => ({ ...m, meta: { ...m.meta, ...over, title } });

const content: FakeContent = {
  config,
  modules: [
    shaped(module('a'), { facets: { 'product-line': ['lifters'] } }, 'Zebra'),
    shaped(
      module('b'),
      { type: 'task', facets: { region: ['north'] } },
      'apple',
    ),
    module('a', 'de'),
    referring(shaped(module('c'), {}, 'Mango'), 'a'),
  ],
  brokenModules: [{ id: 'broken', lang: 'en' }],
  manifests: [manifest('guide', ['a', 'c'])],
};

function setUp(main: FakeContent = content) {
  const history = new FakeHistory(main);
  const { readable } = fakeModuleIndex(history);
  const action = new ListModulesAction(
    readable,
    new GetModuleStatusesAction(
      new ReadableRefs(history),
      history.openSnapshot,
      new ChangeSetTouches(
        history.store,
        history.branches,
        history.openSnapshot,
      ),
    ),
  );
  const list = async (
    options: {
      actor?: Actor;
      filter?: ModuleListFilter;
      sort?: ModuleSort[];
      page?: { number: number; size: number };
    } = {},
  ) => {
    const actor = options.actor ?? READER;
    return action.handle({
      actor,
      snapshot: await history.openSnapshot.handle({ actor, ref: 'main' }),
      ...(options.filter && { filter: options.filter }),
      ...(options.sort && { sort: options.sort }),
      page: options.page ?? { number: 1, size: 50 },
    });
  };
  return { history, list };
}

const keys = (items: { id: string; lang: string }[]) =>
  items.map((i) => `${i.lang}/${i.id}`);

describe('ListModulesAction', () => {
  it('returns one page of modules with their issues, status and usage, and the total', async () => {
    const { list } = setUp();
    const { items, total } = await list({ page: { number: 1, size: 2 } });
    expect(total).toBe(5);
    expect(keys(items)).toEqual(['de/a', 'en/a']);
    expect(items[1]).toMatchObject({
      issues: [],
      status: { release: null },
      usage: { manuals: 1, modules: 1 },
    });
  });

  it('filters by language', async () => {
    const { list } = setUp();
    const { items, total } = await list({ filter: { lang: 'de' } });
    expect(total).toBe(1);
    expect(items[0]).toMatchObject({ id: 'a', lang: 'de' });
  });

  it('lists an unreadable module with its error instead of failing', async () => {
    const { list } = setUp();
    const { items } = await list({ filter: { lang: 'en' } });
    expect(items).toContainEqual({
      id: 'broken',
      lang: 'en',
      error: 'modules/en/broken.adoc: not a module',
    });
    expect(items.filter((i) => 'module' in i)).toHaveLength(3);
  });

  it('lists and counts only what the reader may see, before paging', async () => {
    const { list } = setUp();
    const actor = actorWith(['content.read'], { languages: ['de'] });
    const { items, total } = await list({
      actor,
      page: { number: 1, size: 1 },
    });
    // Neither the English modules nor the broken English file.
    expect(total).toBe(1);
    expect(keys(items)).toEqual(['de/a']);
  });

  it('filters by type, facet and product, leaving unreadable files out', async () => {
    const { list } = setUp();
    expect(keys((await list({ filter: { type: 'task' } })).items)).toEqual([
      'en/b',
    ]);
    expect(
      keys(
        (await list({ filter: { facets: [{ id: 'region', value: 'north' }] } }))
          .items,
      ),
    ).toEqual(['en/b']);
    // The product facet is the first facet: `product-line`.
    expect(
      keys((await list({ filter: { product: 'lifters' } })).items),
    ).toEqual(['en/a']);
    expect((await list({ filter: { product: 'north' } })).total).toBe(0);
  });

  it('filters by the product facet the configuration names', async () => {
    const { list } = setUp({
      ...content,
      config: ProjectConfig.parse({
        ...config,
        release: { productFacet: 'region' },
      }),
    });
    expect(keys((await list({ filter: { product: 'north' } })).items)).toEqual([
      'en/b',
    ]);
  });

  it('filters by status, before paging', async () => {
    const { history, list } = setUp();
    const main = history.heads.get('main') as string;
    expect((await list({ filter: { status: 'released' } })).total).toBe(0);
    history.tag('v1', main);
    const released = await list({
      filter: { status: 'released' },
      page: { number: 1, size: 1 },
    });
    // Every readable file, not the broken one.
    expect(released.total).toBe(4);
    expect(released.items[0]).toMatchObject({
      status: { release: { tag: 'v1', same: true } },
    });
    expect((await list({ filter: { status: 'unreleased' } })).total).toBe(0);
    expect((await list({ filter: { status: 'changed' } })).total).toBe(0);
    // READER is told of no change sets.
    expect((await list({ filter: { status: 'in-change-set' } })).total).toBe(0);
  });

  it('finds a module changed since its release and one in an open change set', async () => {
    const { history, list } = setUp();
    history.tag('v1', history.heads.get('main') as string);
    history.onMain({
      ...content,
      modules: [
        ...(content.modules ?? []).filter((m) => m.id !== 'b'),
        shaped(module('b', 'en', 'Changed.'), { type: 'task' }, 'apple'),
      ],
    });
    expect(keys((await list({ filter: { status: 'changed' } })).items)).toEqual(
      ['en/b'],
    );
    const reviewer = actorWith(['content.read', 'content.read.draft']);
    history.changeSet(reviewer, {
      ...content,
      modules: [...(content.modules ?? []), module('new')],
    });
    // The change set adds `new` and changes `b` back from main.
    const inChangeSets = await list({
      actor: reviewer,
      filter: { status: 'in-change-set' },
    });
    expect(keys(inChangeSets.items)).toEqual(['en/b']);
  });

  it('sorts by title, type, ID and usage, each either way, ties by language and ID', async () => {
    const { list } = setUp();
    const sorted = async (...sort: ModuleSort[]) =>
      keys((await list({ sort })).items);
    // Case aside; the unreadable file last, whichever the direction.
    expect(await sorted({ field: 'title', descending: false })).toEqual([
      'en/b',
      'en/c',
      'de/a',
      'en/a',
      'en/broken',
    ]);
    expect(await sorted({ field: 'title', descending: true })).toEqual([
      'en/a',
      'de/a',
      'en/c',
      'en/b',
      'en/broken',
    ]);
    expect(await sorted({ field: 'id', descending: true })).toEqual([
      'en/c',
      'en/broken',
      'en/b',
      'de/a',
      'en/a',
    ]);
    // `a` is used by the manual and by `c`; `c` by the manual.
    expect(await sorted({ field: 'usage', descending: true })).toEqual([
      'de/a',
      'en/a',
      'en/c',
      'en/b',
      'en/broken',
    ]);
    expect(
      await sorted(
        { field: 'type', descending: true },
        { field: 'lang', descending: true },
      ),
    ).toEqual(['en/b', 'en/a', 'en/c', 'de/a', 'en/broken']);
  });
});
