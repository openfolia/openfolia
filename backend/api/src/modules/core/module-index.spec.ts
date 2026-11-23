import {
  config,
  fakeChangedPaths,
  FakeSnapshot,
  manifest,
  module,
} from '../../../tests/fakes/fake-content.js';
import { FakeHistory } from '../../../tests/fakes/fake-history.js';
import {
  fakeModuleIndex,
  referring,
} from '../../../tests/fakes/fake-module-index-store.js';
import { NotFoundError } from '../../base/core/errors.js';
import { sourceHashes } from '@openfolia/content-model';
import {
  buildCommitIndex,
  updateCommitIndex,
  type CommitIndex,
} from './module-index.js';

const content = {
  modules: [
    referring(module('b'), 'c', 'c', 'a'),
    module('a'),
    module('a', 'de'),
    module('c'),
  ],
  brokenModules: [{ id: 'broken', lang: 'en' }],
  manifests: [manifest('two', ['b', 'a']), manifest('one', ['a'])],
  brokenManifests: ['bad'],
};

describe('buildCommitIndex', () => {
  it('holds every module file, sorted, with its metadata and the modules it refers to', async () => {
    const index = await buildCommitIndex(new FakeSnapshot(content));
    expect(index.modules.map((m) => `${m.lang}/${m.id}`)).toEqual([
      'de/a',
      'en/a',
      'en/b',
      'en/broken',
      'en/c',
    ]);
    expect(index.modules[2]).toEqual({
      id: 'b',
      lang: 'en',
      meta: {
        title: 'Title of b',
        type: 'concept',
        audience: 'public',
        facets: {},
      },
      refs: ['c', 'a'],
      digest: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
      units: ['p', 'refs'],
    });
    expect(index.modules[3]).toEqual({
      id: 'broken',
      lang: 'en',
      refs: [],
      error: 'modules/en/broken.adoc: not a module',
    });
  });

  it('holds every manifest with the modules and variants it names; a broken one with its error', async () => {
    const index = await buildCommitIndex(new FakeSnapshot(content));
    const variants = { model: ['large', 'small'] };
    expect(index.manuals).toEqual([
      { id: 'bad', modules: [], error: expect.any(String) as string },
      {
        id: 'one',
        title: 'Manual one',
        audience: 'public',
        modules: ['a'],
        variants,
      },
      {
        id: 'two',
        title: 'Manual two',
        audience: 'public',
        modules: ['b', 'a'],
        variants,
      },
    ]);
  });

  it('holds a digest per module: equal modules, equal digests, at any commits', async () => {
    const [here, there] = await Promise.all([
      buildCommitIndex(new FakeSnapshot(content)),
      buildCommitIndex(
        new FakeSnapshot({
          ...content,
          modules: [module('a'), module('c', 'en', 'Changed.')],
        }),
      ),
    ]);
    const digest = (index: typeof here, id: string) =>
      index.modules.find((m) => m.id === id && m.lang === 'en')?.digest;
    expect(digest(here, 'a')).toBe(digest(there, 'a'));
    expect(digest(here, 'c')).not.toBe(digest(there, 'c'));
    expect(here.modules.find((m) => m.id === 'broken')?.digest).toBeUndefined();
  });

  it('holds the source units and each translation compared with its record (#480)', async () => {
    const source = module('a', 'en', 'Hello.');
    const translated: CommitIndex = await buildCommitIndex(
      new FakeSnapshot({
        modules: [
          source,
          module('a', 'de', 'Hallo.'),
          module('a', 'fr', 'Bonjour.'),
          module('a', 'it', 'Ciao.'),
          module('only', 'de'),
        ],
        translationRecords: {
          // Translated from the text the source has now.
          'de/a': {
            schemaVersion: 1,
            sourceCommit: 'b'.repeat(40),
            blocks: Object.fromEntries(sourceHashes(source)),
          },
          // From another text.
          'fr/a': {
            schemaVersion: 1,
            sourceCommit: 'c'.repeat(40),
            blocks: { p: '0'.repeat(64) },
          },
        },
        brokenTranslationRecords: ['it/a'],
      }),
    );
    const at = (lang: string, id = 'a') =>
      translated.modules.find((m) => m.id === id && m.lang === lang);
    expect(at('en')?.units).toEqual(['p']);
    expect(at('en')?.translation).toBeUndefined();
    expect(at('de')?.units).toBeUndefined();
    expect(at('de')?.translation).toEqual({
      outdated: [],
      sourceCommit: 'b'.repeat(40),
    });
    expect(at('fr')?.translation).toEqual({
      outdated: ['p'],
      sourceCommit: 'c'.repeat(40),
    });
    // A record that cannot be read is none; so is a source that is not there.
    expect(at('it')?.translation).toBeUndefined();
    expect(at('de', 'only')?.translation).toBeUndefined();
  });

  it('gives the same index for the same commit', async () => {
    const snapshot = new FakeSnapshot(content);
    expect(await buildCommitIndex(snapshot)).toEqual(
      await buildCommitIndex(snapshot),
    );
  });
});

describe('updateCommitIndex (#480)', () => {
  const source = module('a', 'en', 'Hello.');
  const record = {
    schemaVersion: 1 as const,
    sourceCommit: 'b'.repeat(40),
    blocks: Object.fromEntries(sourceHashes(source)),
  };
  const before = new FakeSnapshot({
    modules: [
      source,
      module('a', 'de', 'Hallo.'),
      module('a', 'fr', 'Bonjour.'),
      module('b'),
      module('c'),
    ],
    translationRecords: { 'de/a': record, 'fr/a': record },
    manifests: [manifest('one', ['a']), manifest('two', ['b'])],
  });

  async function carried(after: FakeSnapshot) {
    const base = await buildCommitIndex(before);
    const changed = (await fakeChangedPaths(
      before.commit,
      after.commit,
    )) as string[];
    const reads = vi.spyOn(after, 'module');
    const updated = await updateCommitIndex(after, base, changed);
    const read = reads.mock.calls.map(([id, lang]) => `${lang}/${id}`).sort();
    reads.mockRestore();
    expect(updated).toEqual(await buildCommitIndex(after));
    return read;
  }

  it('gives the index a build gives, reading only the files changed', async () => {
    const after = new FakeSnapshot({
      ...before.content,
      modules: [
        source,
        module('a', 'de', 'Hallo.'),
        module('a', 'fr', 'Bonjour.'),
        // Edited, `c` deleted, `d` added.
        module('b', 'en', 'Edited.'),
        module('d'),
      ],
      manifests: [manifest('one', ['a']), manifest('two', ['b', 'd'])],
    });
    expect(await carried(after)).toEqual(['en/b', 'en/d']);
  });

  it('compares a translation again when its source or its record changed', async () => {
    const edited = new FakeSnapshot({
      ...before.content,
      modules: [
        module('a', 'en', 'Hello, edited.'),
        ...(before.content.modules ?? []).slice(1),
      ],
    });
    expect(await carried(edited)).toEqual(['de/a', 'en/a', 'fr/a']);
    const recorded = new FakeSnapshot({
      ...before.content,
      translationRecords: { 'de/a': record },
    });
    // The source is read for the translation compared again.
    expect(await carried(recorded)).toEqual(['en/a', 'fr/a']);
  });

  it('builds from every file when the configuration changed', async () => {
    const after = new FakeSnapshot({
      ...before.content,
      config: { ...config, languages: { source: 'de', targets: ['en'] } },
    });
    expect(await carried(after)).toHaveLength(5);
  });
});

describe('ModuleIndex', () => {
  it('builds a commit once and keeps it in the store', async () => {
    const history = new FakeHistory(content);
    const { index, store } = fakeModuleIndex(history);
    const main = history.heads.get('main') as string;
    const first = await index.at(main);
    expect(await index.at(main)).toBe(first);
    expect(store.puts).toBe(1);
    expect(store.kept.get(main)).toEqual(first);
  });

  it('builds a new commit from the last one it built, reading what changed (#480)', async () => {
    const history = new FakeHistory(content);
    const { index } = fakeModuleIndex(history);
    await index.at(history.heads.get('main') as string);
    const next = history.onMain({
      ...content,
      modules: [...content.modules, module('d')],
    });
    const reads = vi.spyOn(next, 'module');
    const built = await index.at(next.commit);
    expect(reads.mock.calls).toEqual([['d', 'en']]);
    expect(built).toEqual(await buildCommitIndex(next));
  });

  it('reads a kept index instead of building it', async () => {
    const history = new FakeHistory(content);
    const main = history.heads.get('main') as string;
    const { index, store } = fakeModuleIndex(history);
    const kept = { commit: main, modules: [], manuals: [] };
    store.kept.set(main, kept);
    expect(await index.at(main)).toBe(kept);
    expect(store.puts).toBe(0);
  });

  it('refuses a commit the repository does not have', async () => {
    const { index } = fakeModuleIndex(new FakeHistory(content));
    await expect(index.at('f'.repeat(40))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('rebuilds every branch and tag, with the same result as before', async () => {
    const history = new FakeHistory(content);
    const main = history.heads.get('main') as string;
    const old = history.commit({ modules: [module('a')] });
    history.tag('v1', old.commit);
    const { index, store } = fakeModuleIndex(history);
    const before = await index.at(main);
    store.kept.set('0'.repeat(40), {
      commit: '0'.repeat(40),
      modules: [],
      manuals: [],
    });
    expect(await index.rebuild()).toEqual([main, old.commit]);
    expect([...store.kept.keys()]).toEqual([main, old.commit]);
    expect(store.kept.get(main)).toEqual(before);
  });
});

describe('ModuleIndex over a failing store', () => {
  it('still answers from Git', async () => {
    const history = new FakeHistory(content);
    const { index, store } = fakeModuleIndex(history);
    store.get = () => Promise.reject(new Error('down'));
    store.put = () => Promise.reject(new Error('down'));
    const main = history.heads.get('main') as string;
    expect((await index.at(main)).modules).toHaveLength(5);
  });
});

describe('the module index of a derived manual (#451)', () => {
  const safety = (id: string) => {
    const m = module(id);
    return { ...m, meta: { ...m.meta, type: 'safety' } };
  };
  const leaflet = {
    ...manifest('leaflet', []),
    kind: 'derived' as const,
    rule: { source: 'one', exclude: [], front: [], back: [] },
  };
  const withSafety = {
    config: {
      ...config,
      moduleTypes: [
        ...config.moduleTypes,
        {
          id: 'safety',
          label: 'Safety',
          restricted: false,
          snippet: false,
          safety: true,
        },
      ],
    },
    modules: [module('a'), safety('s')],
    manifests: [manifest('one', ['a', 's']), leaflet],
  };

  it('holds the modules it gathers, and gathers them again when only its source changed', async () => {
    const history = new FakeHistory(withSafety);
    const { index } = fakeModuleIndex(history);
    const first = await index.at(history.heads.get('main') as string);
    expect(first.manuals.find((m) => m.id === 'leaflet')?.modules).toEqual([
      's',
    ]);
    // A module turns safety: the leaflet's file is the same, its modules are not.
    const next = history.onMain({
      ...withSafety,
      modules: [safety('a'), safety('s')],
    });
    const built = await index.at(next.commit);
    expect(built.manuals.find((m) => m.id === 'leaflet')?.modules).toEqual([
      'a',
      's',
    ]);
  });
});
