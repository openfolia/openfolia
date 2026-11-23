import type { Manifest, Module } from '@openfolia/content-model';
import {
  FakeSnapshot,
  manifest,
  module,
  type FakeContent,
} from '../../../tests/fakes/fake-content.js';
import { DeprecationEvents, deprecationEvents } from './deprecation-events.js';

const reason = { reason: 'Superseded.' };
const deprecatedModule = (m: Module, replacedBy?: string): Module => ({
  ...m,
  meta: {
    ...m.meta,
    deprecated: { ...reason, ...(replacedBy && { replacedBy }) },
  },
});
const deprecatedManual = (m: Manifest): Manifest => ({
  ...m,
  deprecated: { reason: 'Replaced.', replacedBy: 'next' },
});

/** The rows merging `head` over `base` writes, with every file changed. */
async function rows(
  base: FakeContent,
  head: FakeContent,
  deleted: string[] = [],
) {
  const at = new FakeSnapshot(head);
  const before = new FakeSnapshot(base);
  const byCommit = new Map([
    [at.commit, at],
    [before.commit, before],
  ]);
  const paths = [
    ...(head.modules ?? []).map((m) => `modules/${m.meta.lang}/${m.id}.adoc`),
    ...(head.manifests ?? []).map((m) => `manuals/${m.id}.yaml`),
  ];
  return deprecationEvents(
    { at: (ref) => Promise.resolve(byCommit.get(ref)) },
    [
      ...paths.map((path) => ({ path, deleted: false })),
      ...deleted.map((path) => ({ path, deleted: true })),
    ],
    {
      changeSetId: 'cs1',
      baseCommit: before.commit,
      head: at.commit,
      commit: 'm1',
    },
  );
}

describe('deprecationEvents', () => {
  it('writes one row per module and manual the change set deprecates', async () => {
    const found = await rows(
      {
        modules: [module('a'), module('b')],
        manifests: [manifest('op', ['a'])],
      },
      {
        modules: [
          deprecatedModule(module('a'), 'b'),
          module('b'),
          // A new module that is deprecated already counts too.
          deprecatedModule(module('c')),
        ],
        manifests: [deprecatedManual(manifest('op', ['a']))],
      },
    );
    expect(found).toEqual([
      {
        topic: 'module.deprecated',
        key: 'cs1/a',
        payload: {
          moduleId: 'a',
          lang: 'en',
          reason: 'Superseded.',
          replacedBy: 'b',
          changeSetId: 'cs1',
          commit: 'm1',
        },
      },
      {
        topic: 'module.deprecated',
        key: 'cs1/c',
        payload: {
          moduleId: 'c',
          lang: 'en',
          reason: 'Superseded.',
          replacedBy: null,
          changeSetId: 'cs1',
          commit: 'm1',
        },
      },
      {
        topic: 'manual.deprecated',
        key: 'cs1/op',
        payload: {
          manualId: 'op',
          reason: 'Replaced.',
          replacedBy: 'next',
          changeSetId: 'cs1',
          commit: 'm1',
        },
      },
    ]);
  });

  it('writes nothing for one deprecated before, an undone one, a translation or a deleted file', async () => {
    const found = await rows(
      {
        modules: [deprecatedModule(module('a')), deprecatedModule(module('b'))],
      },
      {
        modules: [
          // Its reason changed: deprecated before, so no new row.
          {
            ...module('a'),
            meta: {
              ...module('a').meta,
              deprecated: { reason: 'Gone for good.' },
            },
          },
          module('b'),
          deprecatedModule(module('a', 'de')),
        ],
      },
      ['modules/en/gone.adoc'],
    );
    expect(found).toEqual([]);
  });

  it('counts a file that cannot be read as not deprecated', async () => {
    const found = await rows(
      { modules: [], brokenModules: [{ id: 'a', lang: 'en' }] },
      { modules: [deprecatedModule(module('a'))] },
    );
    expect(found.map((e) => e.key)).toEqual(['cs1/a']);
  });

  it('writes none, and does not throw, when Git cannot say what changed: the merge is recorded anyway', async () => {
    const events = new DeprecationEvents({
      at: () => Promise.reject(new Error('unreachable')),
    } as never);
    await expect(
      events.of(() => Promise.reject(new Error('git is down')), {
        changeSetId: 'cs1',
        baseCommit: 'a',
        head: 'b',
        commit: 'm1',
      }),
    ).resolves.toEqual([]);
  });
});
