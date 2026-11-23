import {
  ProjectConfig,
  translationRecordOf,
  type Block,
  type Module,
} from '@openfolia/content-model';
import { actorWith } from '../../../../tests/fakes/actors.js';
import {
  config as baseConfig,
  FakeSnapshot,
  manifest,
  module,
  readable,
  type FakeContent,
} from '../../../../tests/fakes/fake-content.js';
import { fakeModuleIndex } from '../../../../tests/fakes/fake-module-index-store.js';
import { FakeTranslationJobs } from '../../../../tests/fakes/fake-translation-jobs.js';
import type { Actor, Scope } from '../../../access/core/actor.js';
import type { Permission } from '../../../access/core/permissions.js';
import { ForbiddenError, NotFoundError } from '../../../base/core/errors.js';
import type { TranslationStatusFilter } from '../statuses.js';
import { TranslationReads } from '../translation-index.js';
import { GetTranslationStatusAction } from './get-translation-status.action.js';
import { ListTranslationStatusesAction } from './list-translation-statuses.action.js';

const config = ProjectConfig.parse({
  ...baseConfig,
  languages: { source: 'en', targets: ['de', 'fr'] },
  moduleTypes: [
    { id: 'concept', label: 'Concept' },
    { id: 'procedure', label: 'Procedure' },
  ],
  audiences: [
    { id: 'public', label: 'Public' },
    { id: 'internal', label: 'Internal' },
  ],
  facets: [
    {
      id: 'region',
      label: 'Region',
      values: [
        { id: 'north', label: 'North' },
        { id: 'south', label: 'South' },
      ],
    },
  ],
});

const COMMIT = 'e'.repeat(40);
const manager = (scope: Scope = {}): Actor =>
  actorWith(['content.read', 'translation.manage'], scope);
const as = (permissions: Permission[], scope: Scope = {}) =>
  actorWith(permissions, scope);

const para = (id: string, text: string): Block => ({
  type: 'paragraph',
  id,
  content: [{ type: 'text', text }],
});
const doc = (
  id: string,
  texts: [string, string],
  lang = 'en',
  meta: Partial<Module['meta']> = {},
): Module => {
  const base = module(id, lang);
  return {
    ...base,
    meta: { ...base.meta, title: `Title of ${id}`, ...meta },
    blocks: [para('one', texts[0]), para('two', texts[1])],
  };
};

/**
 * `guide` was translated into both languages from its old text, and its
 * first paragraph changed since; `fresh` is up to date in German and has
 * no record in French; `alone` has no translation; `steps` (a procedure in
 * the north) is up to date in German only; `secret` is internal.
 */
const old = doc('guide', ['One.', 'Two.']);
const guide = doc('guide', ['One, edited.', 'Two.']);
const fresh = doc('fresh', ['Fresh.', 'Air.']);
const steps = doc('steps', ['Step.', 'Done.'], 'en', {
  type: 'procedure',
  facets: { region: ['north'] },
});
const secret = doc('secret', ['Hush.', 'Quiet.'], 'en', {
  audience: 'internal',
});
const content: FakeContent = {
  config,
  modules: [
    guide,
    doc('guide', ['Eins.', 'Zwei.'], 'de'),
    doc('guide', ['Un.', 'Deux.'], 'fr'),
    fresh,
    doc('fresh', ['Frisch.', 'Luft.'], 'de'),
    doc('fresh', ['Frais.', 'Air.'], 'fr'),
    doc('alone', ['Alone.', 'Here.']),
    steps,
    doc('steps', ['Schritt.', 'Fertig.'], 'de', {
      type: 'procedure',
      facets: { region: ['north'] },
    }),
    secret,
    doc('secret', ['Still.', 'Ruhe.'], 'de', { audience: 'internal' }),
    {
      ...module('uses-alone'),
      blocks: [{ type: 'moduleRef', id: 'ref', module: 'alone' }],
    },
  ],
  brokenModules: [{ id: 'broken', lang: 'en' }],
  manifests: [manifest('op', ['fresh', 'uses-alone'])],
  translationRecords: {
    'de/guide': translationRecordOf(old, COMMIT),
    'fr/guide': translationRecordOf(old, COMMIT),
    'de/fresh': translationRecordOf(fresh, COMMIT),
    'de/steps': translationRecordOf(steps, COMMIT),
    'de/secret': translationRecordOf(secret, COMMIT),
  },
};

function setUp() {
  const jobs = new FakeTranslationJobs();
  const list = new ListTranslationStatusesAction(
    jobs,
    new TranslationReads(fakeModuleIndex().readable),
  );
  const get = new GetTranslationStatusAction(jobs);
  const page = { number: 1, size: 50 };
  // The modules' rows; the manuals' own text and the project labels (#731) come first, with
  // `kind: undefined`.
  const rows = async (
    filter: TranslationStatusFilter = {},
    actor: Actor = manager(),
    from: FakeContent = content,
  ) =>
    (
      await list.handle({
        actor,
        snapshot: readable(from, actor),
        filter: { kind: 'module', ...filter },
        page,
      })
    ).items.map(
      (s) =>
        `${s.lang}/${s.moduleId} ${s.state} ${s.outdatedBlocks}/${s.blocks.length}`,
    );
  return { jobs, list, get, page, rows };
}

describe('ListTranslationStatusesAction', () => {
  it('lists each source module in each target language, by title, after the labels and manuals (#731)', async () => {
    const { rows } = setUp();
    expect((await rows({ kind: undefined })).slice(0, 4)).toEqual([
      'de/config.project missing 10/10',
      'fr/config.project missing 10/10',
      'de/manual.op missing 1/1',
      'fr/manual.op missing 1/1',
    ]);
    expect(await rows()).toEqual([
      'de/alone missing 2/2',
      'fr/alone missing 2/2',
      // Translated from the old text: only the edited paragraph.
      'de/fresh up-to-date 0/2',
      // A translation without a record: every block.
      'fr/fresh outdated 2/2',
      'de/guide outdated 1/2',
      'fr/guide outdated 1/2',
      'de/secret up-to-date 0/2',
      'fr/secret missing 2/2',
      'de/steps up-to-date 0/2',
      'fr/steps missing 2/2',
      // Nothing to translate, and no file.
      'de/uses-alone missing 0/0',
      'fr/uses-alone missing 0/0',
    ]);
  });

  it('names the outdated blocks and the commit translated from', async () => {
    const { get } = setUp();
    const status = await get.handle({
      actor: manager(),
      snapshot: readable(content, manager()),
      moduleId: 'guide',
      lang: 'de',
    });
    expect(status).toMatchObject({
      moduleId: 'guide',
      lang: 'de',
      title: 'Title of guide',
      state: 'outdated',
      outdatedBlocks: 1,
      atProviderBlocks: 0,
      sourceCommit: COMMIT,
      blocks: [
        { blockId: 'one', state: 'outdated' },
        { blockId: 'two', state: 'up-to-date' },
      ],
    });
    const missing = await get.handle({
      actor: manager(),
      snapshot: readable(content, manager()),
      moduleId: 'alone',
      lang: 'fr',
    });
    expect(missing).toMatchObject({ state: 'missing', sourceCommit: null });
    expect(missing.blocks.map((b) => b.state)).toEqual(['missing', 'missing']);
  });

  it('shows blocks sent to a provider as at-provider, the module too once nothing else is open', async () => {
    const { jobs, rows } = setUp();
    jobs.units = [
      { lang: 'de', moduleId: 'guide', blockId: 'one' },
      { lang: 'fr', moduleId: 'alone', blockId: 'one' },
      { lang: 'fr', moduleId: 'fresh', blockId: 'one' },
      { lang: 'fr', moduleId: 'fresh', blockId: 'two' },
    ];
    const byModule = await rows({ q: 'guide' });
    expect(byModule).toEqual([
      'de/guide at-provider 0/2',
      'fr/guide outdated 1/2',
    ]);
    expect(await rows({ q: 'title of alone', lang: 'fr' })).toEqual([
      'fr/alone missing 1/2',
    ]);
    expect(await rows({ state: 'at-provider' })).toEqual([
      'fr/fresh at-provider 0/2',
      'de/guide at-provider 0/2',
    ]);
  });

  it('filters by language, state, folder, manual and text, before paging', async () => {
    const { list, rows } = setUp();
    expect(await rows({ lang: 'fr', state: 'outdated' })).toEqual([
      'fr/fresh outdated 2/2',
      'fr/guide outdated 1/2',
    ]);
    expect(await rows({ lang: 'it' })).toEqual([]);
    expect(await rows({ lang: 'en' })).toEqual([]);
    expect(await rows({ folder: 'procedure' })).toEqual([
      'de/steps up-to-date 0/2',
      'fr/steps missing 2/2',
    ]);
    expect(await rows({ folder: 'procedure/north', lang: 'de' })).toEqual([
      'de/steps up-to-date 0/2',
    ]);
    expect(await rows({ folder: 'procedure/south' })).toEqual([]);
    expect(await rows({ folder: 'concept/north/x' })).toEqual([]);
    // Through module references too.
    expect(await rows({ manual: 'op', lang: 'de' })).toEqual([
      'de/alone missing 2/2',
      'de/fresh up-to-date 0/2',
      'de/uses-alone missing 0/0',
    ]);
    expect(await rows({ manual: 'nope' })).toEqual([]);
    expect(await rows({ q: 'TITLE OF G' })).toEqual([
      'de/guide outdated 1/2',
      'fr/guide outdated 1/2',
    ]);
    const paged = await list.handle({
      actor: manager(),
      snapshot: readable(content, manager()),
      filter: { kind: 'module', state: 'missing' },
      page: { number: 2, size: 2 },
    });
    expect(paged.total).toBe(6);
    expect(paged.items.map((s) => `${s.lang}/${s.moduleId}`)).toEqual([
      'fr/secret',
      'fr/steps',
    ]);
  });

  it('pages by row: each row with every status it has, the total in rows (#689)', async () => {
    const { list } = setUp();
    const pageOf = async (number: number) => {
      const result = await list.handle({
        actor: manager(),
        snapshot: readable(content, manager()),
        filter: { kind: 'module', state: 'missing' },
        page: { number, size: 2 },
        by: 'row',
      });
      return {
        total: result.total,
        items: result.items.map((s) => `${s.lang}/${s.moduleId}`),
      };
    };
    // Missing: alone in both languages, secret and steps in French only, uses-alone in both.
    expect(await pageOf(1)).toEqual({
      total: 4,
      items: ['de/alone', 'fr/alone', 'fr/secret'],
    });
    expect(await pageOf(2)).toEqual({
      total: 4,
      items: ['fr/steps', 'de/uses-alone', 'fr/uses-alone'],
    });
    expect(await pageOf(3)).toEqual({ total: 4, items: [] });
  });

  it('lists only the named modules with filter.modules, as the reader sees them (#694)', async () => {
    const { rows } = setUp();
    expect(
      await rows({ modules: new Set(['guide', 'fresh', 'nope']) }),
    ).toEqual([
      'de/fresh up-to-date 0/2',
      'fr/fresh outdated 2/2',
      'de/guide outdated 1/2',
      'fr/guide outdated 1/2',
    ]);
    // Other filters still hold; a module outside the reader's scope is not there for them.
    expect(
      await rows({ modules: new Set(['guide', 'fresh']), lang: 'de' }),
    ).toEqual(['de/fresh up-to-date 0/2', 'de/guide outdated 1/2']);
    expect(
      await rows(
        { modules: new Set(['secret', 'guide']) },
        manager({ languages: ['en', 'de'], maxAudience: 'public' }),
      ),
    ).toEqual(['de/guide outdated 1/2']);
    expect(await rows({ modules: new Set(['nope']) })).toEqual([]);
  });

  it('holds a snippet a manual uses three times once: its units are translated once', async () => {
    const { rows } = setUp();
    const phrase = doc('phrase', ['Wear gloves.', 'Keep clear.']);
    const using = (id: string, refs: string[]): Module => ({
      ...module(id),
      blocks: refs.map((ref, i) => ({
        type: 'moduleRef',
        id: `ref-${i}`,
        module: ref,
      })),
    });
    const withSnippet: FakeContent = {
      ...content,
      modules: [
        ...(content.modules ?? []),
        phrase,
        // Twice in one module, once in another; both in the manual.
        using('first', ['phrase', 'phrase']),
        using('second', ['phrase']),
      ],
      manifests: [manifest('snippets', ['first', 'second'])],
    };
    expect(
      await rows({ manual: 'snippets', lang: 'de' }, manager(), withSnippet),
    ).toEqual([
      'de/first missing 0/0',
      'de/phrase missing 2/2',
      'de/second missing 0/0',
    ]);
  });

  it('never lists or counts what lies outside the reader’s scope', async () => {
    const { list, rows } = setUp();
    const german = manager({ languages: ['en', 'de'] });
    expect((await rows({}, german)).every((r) => r.startsWith('de/'))).toBe(
      true,
    );
    // Without the source language, nothing: the source modules are not there.
    expect(await rows({}, manager({ languages: ['de'] }))).toEqual([]);
    const outside = manager({ maxAudience: 'public' });
    expect((await rows({}, outside)).some((r) => r.includes('secret'))).toBe(
      false,
    );
    const page = await list.handle({
      actor: outside,
      snapshot: readable(content, outside),
      filter: { kind: 'module' },
      page: { number: 1, size: 1 },
    });
    expect(page.total).toBe(10);
  });

  it('counts a translation the reader may not see as missing, and a broken one as outdated', async () => {
    const { rows } = setUp();
    const hidden: FakeContent = {
      ...content,
      modules: [
        guide,
        doc('guide', ['Eins.', 'Zwei.'], 'de', { audience: 'internal' }),
      ],
      brokenModules: [{ id: 'guide', lang: 'fr' }],
    };
    // A broken file is told only to a reader of all of its language.
    expect(await rows({}, manager({ maxAudience: 'public' }), hidden)).toEqual([
      'de/guide missing 2/2',
      'fr/guide missing 2/2',
    ]);
    expect(await rows({}, manager(), hidden)).toEqual([
      'de/guide outdated 1/2',
      'fr/guide outdated 2/2',
    ]);
    // A record that cannot be read counts as none.
    expect(
      await rows({}, manager(), {
        ...hidden,
        brokenTranslationRecords: ['de/guide'],
      }),
    ).toEqual(['de/guide outdated 2/2', 'fr/guide outdated 2/2']);
  });

  it('reads no file once the commit is indexed, and says of each what reading its files says (#480)', async () => {
    const { jobs, list, get } = setUp();
    jobs.units = [{ lang: 'fr', moduleId: 'fresh', blockId: 'one' }];
    for (const actor of [
      manager(),
      manager({ maxAudience: 'public' }),
      manager({ languages: ['en', 'de'] }),
      as(['content.read', 'content.read.draft']),
    ]) {
      const raw = new FakeSnapshot(content);
      const snapshot = readable(raw, actor);
      const all = (page: { number: number; size: number }) =>
        list.handle({ actor, snapshot, filter: {}, page });
      const first = await all({ number: 1, size: 3 });
      const reads = vi.spyOn(raw, 'module');
      const records = vi.spyOn(raw, 'translationRecord');
      const pages = [first];
      for (let n = 2; (n - 1) * 3 < first.total; n++) {
        pages.push(await all({ number: n, size: 3 }));
      }
      expect(reads).not.toHaveBeenCalled();
      expect(records).not.toHaveBeenCalled();
      reads.mockRestore();
      records.mockRestore();
      const listed = pages.flatMap((p) => p.items);
      expect(listed).toHaveLength(first.total);
      for (const status of listed) {
        expect(status).toEqual(
          await get.handle({
            actor,
            snapshot,
            lang: status.lang,
            ...(status.kind === 'config'
              ? { config: true }
              : status.kind === 'manual'
                ? { manualId: status.moduleId.slice('manual.'.length) }
                : { moduleId: status.moduleId }),
          }),
        );
      }
    }
  });

  it('needs translation.manage or content.read.draft on top of reading', async () => {
    const { rows } = setUp();
    await expect(rows({}, as(['content.read']))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(rows({}, as(['translation.manage']))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(
      (await rows({}, as(['content.read', 'content.read.draft']))).length,
    ).toBe(12);
    // Held in any scope.
    expect(
      (
        await rows(
          {},
          as(['content.read', 'translation.manage'], { languages: ['fr'] }),
        )
      ).length,
    ).toBe(0);
  });
});

describe('GetTranslationStatusAction', () => {
  it('is not found outside the target languages, the reader’s scope or the modules', async () => {
    const { get } = setUp();
    const read = (moduleId: string, lang: string, actor: Actor = manager()) =>
      get.handle({ actor, snapshot: readable(content, actor), moduleId, lang });
    for (const [id, lang, actor] of [
      ['guide', 'en', manager()],
      ['guide', 'it', manager()],
      ['nope', 'de', manager()],
      ['broken', 'de', manager()],
      ['secret', 'de', manager({ maxAudience: 'public' })],
      ['guide', 'fr', manager({ languages: ['en', 'de'] })],
    ] as const) {
      await expect(read(id, lang, actor)).rejects.toBeInstanceOf(NotFoundError);
    }
    await expect(
      read('guide', 'de', as(['content.read'])),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
