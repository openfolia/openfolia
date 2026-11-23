import { ProjectConfig, type Module } from '@openfolia/content-model';
import { actorWith, READER } from '../../../../tests/fakes/actors.js';
import {
  config,
  FakeSnapshot,
  module,
  readable,
} from '../../../../tests/fakes/fake-content.js';
import { FakeHistory } from '../../../../tests/fakes/fake-history.js';
import { fakeModuleIndex } from '../../../../tests/fakes/fake-module-index-store.js';
import type { Actor } from '../../../access/core/actor.js';
import { ReadableRefs } from '../../../content/core/readable-refs.js';
import { ListModuleSummariesAction } from './list-module-summaries.action.js';

const summariesOver = (history: FakeHistory) =>
  new ListModuleSummariesAction(
    new ReadableRefs(history),
    history.openSnapshot,
    fakeModuleIndex().readable,
  );
const action = summariesOver(new FakeHistory({}));
/** Reads drafts everywhere: deleted modules from their last versions, released or not (#418). */
const DRAFTS = actorWith(['content.read', 'content.read.draft']);
const PAGE = { number: 1, size: 50 };

const titled = (
  id: string,
  lang: string,
  title: string,
  patch: Partial<Module['meta']> = {},
): Module => {
  const m = module(id, lang);
  return { ...m, meta: { ...m.meta, title, ...patch } };
};

const withVariant = (m: Module): Module => ({
  ...m,
  blocks: [
    ...m.blocks,
    {
      type: 'variant',
      id: 'v',
      when: {
        op: 'all',
        of: [
          { op: 'in', attr: 'model', values: ['large', 'small'] },
          { op: 'cmp', attr: 'software', cmp: '>=', value: '2.3' },
        ],
      },
      blocks: [],
    },
  ],
});

const charging = titled('charging', 'en', 'Charging', {
  facets: { region: ['north'] },
  keywords: ['Maintenance', 'battery'],
});
const laden = titled('charging', 'de', 'Laden', {
  facets: { region: ['north'] },
  keywords: ['Wärme'],
});
const safety = withVariant(
  titled('safety', 'en', 'Safety', { type: 'procedure', audience: 'internal' }),
);
const about = titled('about', 'de', 'Über');

const released = {
  modules: [charging, laden, safety],
  brokenModules: [{ id: 'broken', lang: 'en' }],
};
// A draft: German charging edited, `about` added (German only), safety as released.
const draft = {
  config,
  modules: [charging, { ...laden, blocks: [] }, safety, about],
  brokenModules: [{ id: 'broken', lang: 'en' }],
};

const list = (
  filter: Parameters<typeof action.handle>[0]['filter'] = {},
  page = PAGE,
) =>
  action.handle({
    actor: READER,
    snapshot: readable(draft),
    released: readable(released),
    filter,
    page,
  });

describe('ListModuleSummariesAction, deprecation (#266)', () => {
  const deprecated = { reason: 'Superseded.', replacedBy: 'safety' };
  const content = {
    config,
    modules: [
      titled('charging', 'en', 'Charging', { deprecated }),
      // A translation's own (none here) is not the module's.
      laden,
      safety,
      // Only in German: its own file's counts.
      titled('about', 'de', 'Über', { deprecated: { reason: 'Old.' } }),
    ],
  };
  const deprecatedList = (
    filter: Parameters<typeof action.handle>[0]['filter'],
  ) =>
    action.handle({
      actor: READER,
      snapshot: readable(content),
      filter,
      page: PAGE,
    });

  it('names the source-language file’s deprecation in every language', async () => {
    const { items } = await deprecatedList({ lang: 'de' });
    expect(items.map((s) => [s.id, s.title, s.deprecated])).toEqual([
      ['charging', 'Laden', deprecated],
      ['about', 'Über', { reason: 'Old.' }],
    ]);
  });

  it('filters by it', async () => {
    const only = await deprecatedList({ deprecated: true });
    expect(only.items.map((s) => s.id)).toEqual(['charging', 'about']);
    const others = await deprecatedList({ deprecated: false });
    expect(others.items.map((s) => s.id)).toEqual(['safety']);
    expect(others.items[0]?.deprecated).toBeUndefined();
  });
});

describe('ListModuleSummariesAction', () => {
  it('lists one entry per module ID, languages grouped, ordered by title', async () => {
    const { items, total } = await list();
    expect(total).toBe(3);
    expect(items.map((s) => s.id)).toEqual(['charging', 'safety', 'about']);
    expect(items[0]).toEqual({
      id: 'charging',
      title: 'Charging',
      titleLang: 'en',
      moduleType: 'concept',
      audience: 'public',
      facets: { region: ['north'] },
      keywords: ['Maintenance', 'battery'],
      languages: ['en', 'de'],
      variants: [],
      changed: true,
      text: 'Hello.',
    });
    // No source-language version: the title of the one there is.
    expect(items[2]).toMatchObject({ title: 'Über', titleLang: 'de' });
  });

  it('marks what differs from the released content, or is not there', async () => {
    const { items } = await list();
    expect(Object.fromEntries(items.map((s) => [s.id, s.changed]))).toEqual({
      charging: true,
      safety: false,
      about: true,
    });
  });

  it('counts nothing as changed when reading the released commit itself', async () => {
    const snapshot = readable(released);
    const { items } = await action.handle({
      actor: READER,
      snapshot,
      released: snapshot,
      filter: {},
      page: PAGE,
    });
    expect(items.every((s) => !s.changed)).toBe(true);
  });

  it('counts everything as changed when there is no released content', async () => {
    const { items } = await action.handle({
      actor: READER,
      snapshot: readable(draft),
      filter: {},
      page: PAGE,
    });
    expect(items.every((s) => s.changed)).toBe(true);
  });

  it('lists from the module index, reading only the page’s files (#480)', async () => {
    const raw = new FakeSnapshot(draft);
    const snapshot = readable(raw);
    const page = (number: number) =>
      action.handle({
        actor: READER,
        snapshot,
        released: readable(released),
        filter: {},
        page: { number, size: 1 },
      });
    const first = await page(1);
    const reads = vi.spyOn(raw, 'module');
    const second = await page(2);
    // Only the page's module, in each of its languages.
    expect(reads.mock.calls.map(([id, lang]) => `${lang}/${id}`)).toEqual([
      'en/safety',
    ]);
    reads.mockClear();
    await page(1);
    expect(reads.mock.calls.map(([id, lang]) => `${lang}/${id}`)).toEqual([
      'de/charging',
      'en/charging',
    ]);
    reads.mockRestore();
    expect([first.total, second.total]).toEqual([3, 3]);
    expect(second.items).toEqual([(await list()).items[1]]);
    // A deep page is the same list, cut further on.
    expect((await page(3)).items).toEqual([(await list()).items[2]]);
  });

  it('counts a module equal to the released one, whatever its object, as unchanged', async () => {
    const { items } = await action.handle({
      actor: READER,
      snapshot: readable({
        ...draft,
        modules: (draft.modules ?? []).map((m) => structuredClone(m)),
      }),
      released: readable(released),
      filter: { changed: false },
      page: PAGE,
    });
    expect(items.map((s) => s.id)).toEqual(['safety']);
  });

  it('collects what variant blocks are conditioned on', async () => {
    const { items } = await list({ q: 'safety' });
    expect(items[0]?.variants).toEqual([
      'model=large',
      'model=small',
      'software>=2.3',
    ]);
  });

  it('filters before paging, so the total counts only matches', async () => {
    expect((await list({ lang: 'de' })).items).toMatchObject([
      { id: 'charging', title: 'Laden', titleLang: 'de' },
      { id: 'about' },
    ]);
    expect((await list({ type: 'procedure' })).items.map((s) => s.id)).toEqual([
      'safety',
    ]);
    // The level a module counts as (#699): with `public` the only configured level, the
    // modules naming none count as it; `safety`'s `internal` is not configured, so it is none.
    expect(
      (await list({ audience: 'public' })).items.map((s) => s.id).sort(),
    ).toEqual(['about', 'charging']);
    expect((await list({ audience: 'internal' })).total).toBe(0);
    expect(
      (await list({ facets: [{ id: 'region', value: 'north' }] })).items.map(
        (s) => s.id,
      ),
    ).toEqual(['charging']);
    expect((await list({ changed: false })).items.map((s) => s.id)).toEqual([
      'safety',
    ]);
    expect((await list({ changed: true })).total).toBe(2);
    // Any language's title, or the ID; case aside.
    expect((await list({ q: 'LADEN' })).items.map((s) => s.id)).toEqual([
      'charging',
    ]);
    expect((await list({ q: 'abou' })).items.map((s) => s.id)).toEqual([
      'about',
    ]);
    const paged = await list({}, { number: 2, size: 2 });
    expect(paged).toMatchObject({ total: 3, items: [{ id: 'about' }] });
  });

  it('lists only the modules of the IDs asked for, before paging (#481)', async () => {
    const found = await list({ ids: new Set(['safety', 'about', 'no-such']) });
    expect(found.items.map((s) => s.id)).toEqual(['safety', 'about']);
    expect(found.total).toBe(2);
    // Ordered by title, as ever; with the other filters every one has to match.
    const both = await list({
      ids: new Set(['safety', 'about']),
      type: 'procedure',
    });
    expect(both.items.map((s) => s.id)).toEqual(['safety']);
  });

  it('combines type, audience, facets and keywords, every value of each', async () => {
    const ids = async (filter: Parameters<typeof list>[0]) =>
      (await list(filter)).items.map((s) => s.id);
    expect(
      await ids({
        type: 'concept',
        audience: 'public',
        facets: [{ id: 'region', value: 'north' }],
        keywords: ['maintenance'],
      }),
    ).toEqual(['charging']);
    expect(
      await ids({
        facets: [
          { id: 'region', value: 'north' },
          { id: 'region', value: 'south' },
        ],
      }),
    ).toEqual([]);
    expect(await ids({ type: 'procedure', keywords: ['maintenance'] })).toEqual(
      [],
    );
    expect(await ids({ keywords: ['MAINTENANCE', 'Battery'] })).toEqual([
      'charging',
    ]);
    expect(await ids({ keywords: ['maintenance', 'nothing'] })).toEqual([]);
    // An unknown facet or type matches nothing; it is no error.
    expect(await ids({ facets: [{ id: 'colour', value: 'red' }] })).toEqual([]);
  });

  it('matches keywords exactly, case and diacritics aside, in one language', async () => {
    const ids = async (filter: Parameters<typeof list>[0]) =>
      (await list(filter)).items.map((s) => s.id);
    expect(await ids({ keywords: ['maint'] })).toEqual([]);
    // Any language's keywords; the row shows the shown language's.
    expect(await ids({ keywords: ['warme'] })).toEqual(['charging']);
    expect(await ids({ lang: 'en', keywords: ['wärme'] })).toEqual([]);
    expect(await ids({ lang: 'de', keywords: ['WARME'] })).toEqual([
      'charging',
    ]);
    // Every keyword in one language, not spread over two.
    expect(await ids({ keywords: ['battery', 'wärme'] })).toEqual([]);
    const [row] = (await list({ lang: 'de', keywords: ['wärme'] })).items;
    expect(row?.keywords).toEqual(['Wärme']);
  });

  it('lists only what the reader may see, in both snapshots', async () => {
    const actor = actorWith(['content.read'], { languages: ['de'] });
    const { items } = await action.handle({
      actor,
      snapshot: readable(draft, actor),
      released: readable(released, actor),
      filter: {},
      page: PAGE,
    });
    expect(items.map((s) => [s.id, s.languages])).toEqual([
      ['charging', ['de']],
      ['about', ['de']],
    ]);
  });

  it('leaves unreadable files out', async () => {
    const { items } = await list({ q: 'broken' });
    expect(items).toEqual([]);
  });

  describe('snippets', () => {
    const snippetConfig = ProjectConfig.parse({
      ...config,
      moduleTypes: [
        ...config.moduleTypes,
        { id: 'phrase', label: 'Phrase', snippet: true },
      ],
    });
    const gloves = titled('gloves', 'en', 'Gloves', {
      type: 'phrase',
      audience: 'internal',
    });
    const handschuhe = {
      ...titled('gloves', 'de', 'Handschuhe', { type: 'phrase' }),
      blocks: [
        {
          type: 'paragraph' as const,
          id: 'p',
          content: [
            { type: 'text' as const, text: 'Schutzhandschuhe  tragen.' },
          ],
        },
      ],
    };
    const content = {
      config: snippetConfig,
      modules: [charging, gloves, handschuhe, about],
    };
    const snippets = (
      filter: Parameters<typeof action.handle>[0]['filter'],
      actor = READER,
    ) =>
      action.handle({
        actor,
        snapshot: readable(content, actor),
        released: readable(content, actor),
        filter,
        page: PAGE,
      });

    it('filters on the configured snippet types, with the start of the text', async () => {
      const only = await snippets({ snippet: true });
      expect(only.items.map((s) => [s.id, s.text])).toEqual([
        ['gloves', 'Hello.'],
      ]);
      expect(only.total).toBe(1);
      const others = await snippets({ snippet: false });
      expect(others.items.map((s) => s.id)).toEqual(['charging', 'about']);
      // The text follows the language shown.
      const german = await snippets({ snippet: true, lang: 'de' });
      expect(german.items.map((s) => s.text)).toEqual([
        'Schutzhandschuhe tragen.',
      ]);
    });

    it('offers only the snippets the reader may see', async () => {
      const publicReader = actorWith(['content.read'], {
        maxAudience: 'public',
      });
      const seen = await snippets({ snippet: true, lang: 'en' }, publicReader);
      expect(seen.items).toEqual([]);
      const german = actorWith(['content.read'], { languages: ['de'] });
      const de = await snippets({ snippet: true }, german);
      expect(de.items.map((s) => [s.id, s.titleLang])).toEqual([
        ['gloves', 'de'],
      ]);
    });
  });
});

describe('ListModuleSummariesAction, deleted modules (#320)', () => {
  const gone = titled('gone', 'en', 'Gone', { type: 'procedure' });
  const weg = titled('gone', 'de', 'Weg', { type: 'procedure' });
  const partly = titled('partly', 'de', 'Teilweise');
  const hidden = titled('hidden', 'en', 'Hidden', { type: 'secret' });
  // The line, oldest first: everything; `gone` edited; then `gone`, German `partly` and `hidden`
  // deleted (the head). `charging` stays throughout.
  const oldest = new FakeSnapshot({
    modules: [charging, gone, weg, partly, hidden],
  });
  const edited = { ...gone, blocks: [] };
  const middle = new FakeSnapshot({
    modules: [charging, edited, weg, partly, hidden],
    line: [oldest],
  });
  const head = new FakeSnapshot({
    modules: [charging, titled('partly', 'en', 'Partly')],
    line: [middle, oldest],
    commitInfo: { committedAt: '2026-03-01T00:00:00Z' },
  });
  const mainSnapshot = new FakeSnapshot({ modules: [charging, gone, weg] });

  // Read as a draft: the last versions are not released (#418 has the released path).
  const deletedList = (
    filter: Parameters<typeof action.handle>[0]['filter'],
    actor = DRAFTS,
    snapshot: FakeSnapshot = head,
  ) =>
    action.handle({
      actor,
      snapshot: readable(snapshot, actor, 'content.read.draft'),
      released: readable(mainSnapshot, actor),
      filter,
      page: PAGE,
    });

  it('lists none unless asked for', async () => {
    const { items } = await deletedList({});
    expect(items.map((s) => s.id)).toEqual(['charging', 'partly']);
  });

  it('lists the modules no file of which is left, from their last versions', async () => {
    const { items, total } = await deletedList({ status: 'deleted' });
    expect(total).toBe(2);
    expect(items.map((s) => [s.id, s.title, s.languages])).toEqual([
      ['gone', 'Gone', ['en', 'de']],
      ['hidden', 'Hidden', ['en']],
    ]);
    const [first] = items;
    // The last version, as edited before the deletion, and its deletion.
    expect(first?.text).toBe('');
    expect(first?.deleted).toEqual({
      commit: head.commit,
      committedAt: '2026-03-01T00:00:00Z',
    });
    // The released branch has it: its deletion is a change.
    expect(first?.changed).toBe(true);
    expect(items[1]?.changed).toBe(false);
  });

  it('lists both in one list, ordered by title, with `any`', async () => {
    const { items, total } = await deletedList({ status: 'any' });
    expect(total).toBe(4);
    expect(items.map((s) => [s.id, s.deleted !== undefined])).toEqual([
      ['charging', false],
      ['gone', true],
      ['hidden', true],
      ['partly', false],
    ]);
  });

  it('applies the other filters to the last versions', async () => {
    const ids = async (filter: Parameters<typeof deletedList>[0]) =>
      (await deletedList({ status: 'deleted', ...filter })).items.map(
        (s) => s.id,
      );
    expect(await ids({ type: 'procedure' })).toEqual(['gone']);
    expect(await ids({ q: 'weg' })).toEqual(['gone']);
    expect(await ids({ lang: 'de' })).toEqual(['gone']);
    expect(await ids({ changed: false })).toEqual(['hidden']);
    const [german] = (await deletedList({ status: 'deleted', lang: 'de' }))
      .items;
    expect(german?.title).toBe('Weg');
  });

  it('never lists or counts a deleted module outside the reader’s scope', async () => {
    const scoped = actorWith(['content.read', 'content.read.draft'], {
      moduleTypes: ['concept', 'procedure'],
    });
    const { items, total } = await deletedList({ status: 'any' }, scoped);
    expect(total).toBe(3);
    expect(items.map((s) => s.id)).toEqual(['charging', 'gone', 'partly']);
    // By language: only the German file of `gone` is theirs.
    const german = actorWith(['content.read', 'content.read.draft'], {
      languages: ['de'],
    });
    const found = await deletedList({ status: 'deleted' }, german);
    // `partly` has an English file they do not see, and its German one was deleted: gone, for
    // them.
    expect(found.items.map((s) => [s.id, s.languages, s.title])).toEqual([
      ['partly', ['de'], 'Teilweise'],
      ['gone', ['de'], 'Weg'],
    ]);
  });

  it('judges the last version, not an older one in scope', async () => {
    // `hidden` was a concept before it became a secret, then was deleted.
    const before = new FakeSnapshot({
      modules: [titled('hidden', 'en', 'Hidden')],
    });
    const after = new FakeSnapshot({
      modules: [hidden],
      line: [before],
    });
    const deletion = new FakeSnapshot({ modules: [], line: [after, before] });
    const scoped = actorWith(['content.read', 'content.read.draft'], {
      moduleTypes: ['concept'],
    });
    const { items } = await deletedList(
      { status: 'deleted' },
      scoped,
      deletion,
    );
    expect(items).toEqual([]);
  });

  it('lists a deleted module that was deprecated, whatever `deprecated` asks', async () => {
    const old = titled('old', 'en', 'Old', {
      deprecated: { reason: 'Superseded.' },
    });
    const before = new FakeSnapshot({ modules: [charging, old] });
    const now = new FakeSnapshot({ modules: [charging], line: [before] });
    const { items } = await deletedList(
      { status: 'any', deprecated: false },
      DRAFTS,
      now,
    );
    expect(items.map((s) => [s.id, s.deprecated?.reason])).toEqual([
      ['charging', undefined],
      ['old', 'Superseded.'],
    ]);
  });

  it('leaves out a deleted file whose last version cannot be read', async () => {
    const older = new FakeSnapshot({
      brokenModules: [{ id: 'broken', lang: 'en' }],
    });
    const now = new FakeSnapshot({ modules: [], line: [older] });
    const { items } = await deletedList({ status: 'deleted' }, DRAFTS, now);
    expect(items).toEqual([]);
  });

  it('counts only deletions within the window', async () => {
    const { files } = await readable(head).deletedModules(1);
    // Not `partly`: its English file is there.
    expect(files.map((f) => `${f.lang}/${f.id}`).sort()).toEqual([
      'de/gone',
      'en/gone',
      'en/hidden',
    ]);
    const later = new FakeSnapshot({
      modules: head.content.modules ?? [],
      line: [head, middle, oldest],
    });
    expect((await readable(later).deletedModules(1)).files).toEqual([]);
    expect((await readable(later).deletedModules(2)).files).toHaveLength(3);
  });
});

describe('ListModuleSummariesAction, deleted modules to a reader without draft access (#418)', () => {
  const audiences = ProjectConfig.parse({
    ...config,
    audiences: [
      { id: 'public', label: 'Public' },
      { id: 'internal', label: 'Internal' },
    ],
  });
  const at = (...modules: Module[]) => ({ config: audiences, modules });
  const textOf = (m: Module, text: string): Module => ({
    ...m,
    blocks: module(m.id, m.meta.lang, text).blocks,
  });
  /** Reads released content of every audience, drafts only of the public one. */
  const narrowDrafts: Actor = {
    kind: 'user',
    id: 'narrow-drafts',
    roles: [
      { id: 'reads', name: 'Reads', permissions: ['content.read'], scope: {} },
      {
        id: 'drafts',
        name: 'Drafts',
        permissions: ['content.read.draft'],
        scope: { maxAudience: 'public' },
      },
    ],
  };
  const publicOnly = actorWith(['content.read'], { maxAudience: 'public' });

  const kept = textOf(titled('kept', 'en', 'Kept'), 'Released text.');
  const gone = textOf(titled('gone', 'en', 'Gone'), 'Released text.');
  const weg = textOf(titled('gone', 'de', 'Weg'), 'Veröffentlicht.');
  const goneEdited = textOf(
    titled('gone', 'en', 'Gone, renamed'),
    'Unreleased secret text.',
  );
  const never = textOf(titled('never', 'en', 'Never'), 'Draft text.');

  /**
   * `main`: `kept` and `gone` (English and German) are released by `v1`; then `gone`'s English
   * file is renamed and `never` added (never released); then all of them are deleted.
   */
  function setUp() {
    const history = new FakeHistory(at());
    const v1 = history.onMain(at(kept, gone, weg), { message: 'Add' });
    history.tag('v1', v1.commit);
    history.onMain(at(kept, goneEdited, weg, never), { message: 'Edit' });
    const deletion = history.onMain(at(), { message: 'Drop them all' });
    const list = async (actor: Actor, filter = {}) =>
      summariesOver(history).handle({
        actor,
        snapshot: await history.openSnapshot.handle({ actor, ref: 'main' }),
        filter: { status: 'deleted', ...filter },
        page: PAGE,
      });
    return { history, deletion, list };
  }

  it('lists only the deleted files released content holds, summarised from the released file', async () => {
    const { deletion, list } = setUp();
    const { items, total } = await list(READER);
    expect(total).toBe(2);
    expect(
      items.map((s) => [s.id, s.title, s.languages, s.text, s.deleted]),
    ).toEqual([
      [
        'kept',
        'Kept',
        ['en'],
        'Released text.',
        { commit: deletion.commit, committedAt: expect.any(String) },
      ],
      // Its English file's last version was never released: only the German one is listed.
      [
        'gone',
        'Weg',
        ['de'],
        'Veröffentlicht.',
        { commit: deletion.commit, committedAt: expect.any(String) },
      ],
    ]);
    const all = JSON.stringify(await list(READER, { q: 'e' }));
    expect(all).not.toContain('Unreleased secret text.');
    expect(all).not.toContain('Gone, renamed');
    expect(all).not.toContain('never');
    // Nor found by its unreleased title.
    expect((await list(READER, { q: 'renamed' })).total).toBe(0);
  });

  it('gives a reader of drafts every deleted module from its last versions, as before', async () => {
    const { list } = setUp();
    const { items } = await list(DRAFTS);
    expect(items.map((s) => [s.id, s.title, s.languages, s.text])).toEqual([
      ['gone', 'Gone, renamed', ['en', 'de'], 'Unreleased secret text.'],
      ['kept', 'Kept', ['en'], 'Released text.'],
      ['never', 'Never', ['en'], 'Draft text.'],
    ]);
  });

  it('judges the released file by the reader’s scope at that release', async () => {
    // At the release, internal ranks above public; at the head, below it: so the head shows the
    // last version to a public reader, the release (where it is read) does not.
    const lower = ProjectConfig.parse({
      ...config,
      audiences: [
        { id: 'internal', label: 'Internal' },
        { id: 'public', label: 'Public' },
      ],
    });
    const history = new FakeHistory(at());
    const secret = { ...kept, meta: { ...kept.meta, audience: 'internal' } };
    history.tag('v1', history.onMain(at(secret)).commit);
    history.onMain({ config: lower, modules: [] });
    const drafts = await readable(
      (await history.at('main')) as FakeSnapshot,
      publicOnly,
    ).deletedModules(10);
    expect(drafts.files.map((f) => f.id)).toEqual(['kept']);
    const list = async (actor: Actor) =>
      summariesOver(history).handle({
        actor,
        snapshot: await history.openSnapshot.handle({ actor, ref: 'main' }),
        filter: { status: 'deleted' },
        page: PAGE,
      });
    expect((await list(publicOnly)).total).toBe(0);
    expect((await list(READER)).items.map((s) => s.id)).toEqual(['kept']);
  });

  it('takes the released path for a draft scope narrower than the read scope', async () => {
    const history = new FakeHistory(at());
    const secret = textOf(
      {
        ...titled('secret', 'en', 'Secret draft'),
        meta: {
          ...titled('secret', 'en', 'Secret draft').meta,
          audience: 'internal',
        },
      },
      'Internal draft text.',
    );
    history.onMain(at(secret, never), { message: 'Add, never released' });
    history.onMain(at(), { message: 'Drop both' });
    const { items } = await summariesOver(history).handle({
      actor: narrowDrafts,
      snapshot: await history.openSnapshot.handle({
        actor: narrowDrafts,
        ref: 'main',
      }),
      filter: { status: 'deleted' },
      page: PAGE,
    });
    // The public one is a draft their draft scope shows alike; the internal one is not.
    expect(items.map((s) => s.id)).toEqual(['never']);
  });
});
