import {
  PageDesign,
  printPageDesign,
  ProjectConfig,
  translationRecordOf,
  type Block,
  type Manifest,
  type Module,
} from '@openfolia/content-model';
import { actorWith } from '../../../../tests/fakes/actors.js';
import {
  config as baseConfig,
  manifest,
  module,
  readable,
  type FakeContent,
} from '../../../../tests/fakes/fake-content.js';
import { fakeModuleIndex } from '../../../../tests/fakes/fake-module-index-store.js';
import { FakeTranslationJobs } from '../../../../tests/fakes/fake-translation-jobs.js';
import type { Actor, Scope } from '../../../access/core/actor.js';
import { ForbiddenError } from '../../../base/core/errors.js';
import { TranslationReads } from '../../../translations/core/translation-index.js';
import type { CoverageFilter } from '../translation-coverage.js';
import { ReportTranslationsAction } from './report-translations.action.js';

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
});

const COMMIT = 'e'.repeat(40);
const lead = (scope: Scope = {}): Actor =>
  actorWith(['content.read', 'content.read.draft'], scope);

const para = (id: string, text: string): Block => ({
  type: 'paragraph',
  id,
  content: [{ type: 'text', text }],
});
const doc = (
  id: string,
  text: string,
  lang = 'en',
  meta: Partial<Module['meta']> = {},
  more: Block[] = [],
): Module => {
  const base = module(id, lang);
  return {
    ...base,
    meta: { ...base.meta, title: `Title of ${id}`, ...meta },
    blocks: [para('one', text), ...more],
  };
};

/**
 * The guide includes four modules: `a`, `b` and `c` up to date in German
 * and `d` outdated (its text changed since); `c` only through `b`'s module
 * reference. `e`, internal, is in the guide too. Nothing is in French.
 */
const a = doc('a', 'A.');
const b = doc('b', 'B.', 'en', {}, [
  { type: 'moduleRef', id: 'ref', module: 'c' },
]);
const c = doc('c', 'C.');
const dOld = doc('d', 'D.');
const d = doc('d', 'D, edited.');
const e = doc('e', 'E.', 'en', { audience: 'internal' });
const german = (m: Module) => ({ ...m, meta: { ...m.meta, lang: 'de' } });
const internal: Manifest = {
  ...manifest('internal-guide', ['a']),
  title: 'An internal guide',
  audience: 'internal',
};
const content: FakeContent = {
  config,
  modules: [a, b, c, d, e, german(a), german(b), german(c), german(dOld)],
  manifests: [
    manifest('guide', ['a', 'b', 'd', 'e']),
    { ...manifest('old', ['a']), deprecated: { reason: 'Gone.' } },
    internal,
  ],
  translationRecords: {
    'de/a': translationRecordOf(a, COMMIT),
    'de/b': translationRecordOf(b, COMMIT),
    'de/c': translationRecordOf(c, COMMIT),
    'de/d': translationRecordOf(dOld, COMMIT),
  },
};

function setUp() {
  const jobs = new FakeTranslationJobs();
  const action = new ReportTranslationsAction(
    jobs,
    new TranslationReads(fakeModuleIndex().readable),
  );
  const rows = async (filter: CoverageFilter = {}, actor: Actor = lead()) =>
    (
      await action.handle({
        actor,
        snapshot: readable(content, actor),
        filter,
        page: { number: 1, size: 50 },
      })
    ).items.map(
      (r) =>
        `${r.manualId}/${r.lang} modules ${r.modules.upToDate}/${r.modules.outdated}/${r.modules.atProvider}/${r.modules.missing} of ${r.modules.total}, blocks ${r.blocks.upToDate}/${r.blocks.outdated}/${r.blocks.atProvider}/${r.blocks.missing} of ${r.blocks.total}`,
    );
  return { jobs, action, rows };
}

describe('ReportTranslationsAction', () => {
  it('counts each manual’s modules and blocks per language, through module references', async () => {
    const { rows } = setUp();
    // Without the internal module: up to date, outdated, at provider, missing.
    expect(await rows({}, lead({ maxAudience: 'public' }))).toEqual([
      'guide/de modules 3/1/0/0 of 4, blocks 3/1/0/0 of 4',
      'guide/fr modules 0/0/0/4 of 4, blocks 0/0/0/4 of 4',
      'old/de modules 1/0/0/0 of 1, blocks 1/0/0/0 of 1',
      'old/fr modules 0/0/0/1 of 1, blocks 0/0/0/1 of 1',
    ]);
    // A reader of every audience sees `e` (missing in German) and the internal manual.
    expect(await rows()).toEqual([
      'internal-guide/de modules 1/0/0/0 of 1, blocks 1/0/0/0 of 1',
      'internal-guide/fr modules 0/0/0/1 of 1, blocks 0/0/0/1 of 1',
      'guide/de modules 3/1/0/1 of 5, blocks 3/1/0/1 of 5',
      'guide/fr modules 0/0/0/5 of 5, blocks 0/0/0/5 of 5',
      'old/de modules 1/0/0/0 of 1, blocks 1/0/0/0 of 1',
      'old/fr modules 0/0/0/1 of 1, blocks 0/0/0/1 of 1',
    ]);
  });

  it('shows one outdated module of four as 75 % up to date', async () => {
    const { action } = setUp();
    const actor = lead({ maxAudience: 'public' });
    const [row] = (
      await action.handle({
        actor,
        snapshot: readable(content, actor),
        filter: { manual: 'guide', lang: 'de' },
      })
    ).items;
    expect(row).toMatchObject({
      manualId: 'guide',
      lang: 'de',
      title: 'Manual guide',
      deprecated: false,
    });
    expect(
      ((row?.modules.upToDate ?? 0) * 100) / (row?.modules.total ?? 0),
    ).toBe(75);
  });

  it('counts the units of the manual’s page design and cover images apart (#656)', async () => {
    const { action, jobs } = setUp();
    const design = PageDesign.parse({
      schemaVersion: 1,
      id: 'house',
      name: 'House',
      preset: 'classic',
      colours: { primary: '#1f4e79', accent: '#2563eb', text: '#1f2328' },
      regions: {
        back: {
          en: [para('maker', 'Made by us')],
          de: [para('maker', 'Von uns')],
        },
        footer: [para('note', 'A note')],
      },
    });
    const withDesign: FakeContent = {
      ...content,
      pageDesigns: { house: printPageDesign(design) },
      manifests: [
        {
          ...manifest('guide', ['a']),
          design: 'house',
          coverImage: {
            default: {
              asset: 'sha256:' + 'a'.repeat(64),
              alt: { en: 'The vehicle', de: 'Das Fahrzeug' },
            },
            variants: [],
          },
        },
      ],
    };
    jobs.units = [
      { lang: 'de', moduleId: 'design.house', blockId: 'footer.note' },
    ];
    const actor = lead({ maxAudience: 'public' });
    const [row] = (
      await action.handle({
        actor,
        snapshot: readable(withDesign, actor),
        filter: { manual: 'guide', lang: 'de' },
      })
    ).items;
    // The design's own German text has no record: outdated; its footer is at a provider.
    expect(row?.design).toEqual({
      total: 2,
      upToDate: 0,
      outdated: 1,
      atProvider: 1,
      missing: 0,
    });
    // The manual's title (#731), without a German version, beside the cover image's text.
    expect(row?.cover).toEqual({
      total: 2,
      upToDate: 0,
      outdated: 1,
      atProvider: 0,
      missing: 1,
    });
    const [french] = (
      await action.handle({
        actor,
        snapshot: readable(withDesign, actor),
        filter: { manual: 'guide', lang: 'fr' },
      })
    ).items;
    expect(french?.cover).toMatchObject({ total: 2, missing: 2 });
    expect(french?.design).toMatchObject({ total: 2, missing: 2 });
  });

  it('counts blocks at a provider', async () => {
    const { jobs, rows } = setUp();
    jobs.units = [{ lang: 'de', moduleId: 'd', blockId: 'one' }];
    expect(
      await rows(
        { manual: 'guide', lang: 'de' },
        lead({ maxAudience: 'public' }),
      ),
    ).toEqual(['guide/de modules 3/0/1/0 of 4, blocks 3/0/1/0 of 4']);
  });

  it('names and counts nothing outside the reader’s scope', async () => {
    const { rows } = setUp();
    // No French: its column goes; no internal: neither `e` nor the internal manual.
    expect(
      await rows({}, lead({ languages: ['en', 'de'], maxAudience: 'public' })),
    ).toEqual([
      'guide/de modules 3/1/0/0 of 4, blocks 3/1/0/0 of 4',
      'old/de modules 1/0/0/0 of 1, blocks 1/0/0/0 of 1',
    ]);
    // Procedures only: no module of the guide is one, so nothing counts.
    expect(
      await rows({ manual: 'guide' }, lead({ moduleTypes: ['procedure'] })),
    ).toEqual([
      'guide/de modules 0/0/0/0 of 0, blocks 0/0/0/0 of 0',
      'guide/fr modules 0/0/0/0 of 0, blocks 0/0/0/0 of 0',
    ]);
    // A manual the reader may not see matches nothing, like one that does not exist.
    expect(
      await rows({ manual: 'internal-guide' }, lead({ maxAudience: 'public' })),
    ).toEqual([]);
    expect(await rows({ manual: 'nope' })).toEqual([]);
    expect(await rows({ lang: 'en' })).toEqual([]);
  });

  it('pages, and marks a deprecated manual', async () => {
    const { action } = setUp();
    const actor = lead({ maxAudience: 'public' });
    const page = await action.handle({
      actor,
      snapshot: readable(content, actor),
      filter: {},
      page: { number: 2, size: 3 },
    });
    expect(page.total).toBe(4);
    expect(
      page.items.map((r) => `${r.manualId}/${r.lang} ${r.deprecated}`),
    ).toEqual(['old/fr true']);
  });

  it('needs content.read.draft', async () => {
    const { action } = setUp();
    const actor = actorWith(['content.read', 'translation.manage']);
    await expect(
      action.handle({ actor, snapshot: readable(content, actor), filter: {} }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
