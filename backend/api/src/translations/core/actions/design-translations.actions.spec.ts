import {
  PageDesign,
  printPageDesign,
  ProjectConfig,
  regionBlocksDiffer,
  type Block,
  type Module,
  type PageDesignInput,
} from '@openfolia/content-model';
import { actorWith } from '../../../../tests/fakes/actors.js';
import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import { FakeAuthoredBranches } from '../../../../tests/fakes/fake-authored-branches.js';
import { FakeChangeSetBranches } from '../../../../tests/fakes/fake-change-set-branches.js';
import {
  config as baseConfig,
  FakeSnapshot,
  manifest,
  module,
  readable,
  type FakeContent,
} from '../../../../tests/fakes/fake-content.js';
import { fakeModuleIndex } from '../../../../tests/fakes/fake-module-index-store.js';
import { FakeRepository } from '../../../../tests/fakes/fake-repository.js';
import { FakeTranslationEvents } from '../../../../tests/fakes/fake-translation-events.js';
import { FakeTranslationImportStore } from '../../../../tests/fakes/fake-translation-import-store.js';
import { FakeTranslationExchange } from '../../../../tests/fakes/fake-translation-exchange.js';
import { FakeTranslationJobs } from '../../../../tests/fakes/fake-translation-jobs.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import type { Actor, Scope } from '../../../access/core/actor.js';
import { NotFoundError } from '../../../base/core/errors.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import type { ContentSnapshot } from '../../../content/core/content.repository.js';
import { ReadableRefs } from '../../../content/core/readable-refs.js';
import { mergeDesignTranslation } from '../design-translation-merge.js';
import { TranslationReads } from '../translation-index.js';
import { TranslationImportCheck } from '../translation-import-check.js';
import { ExportTranslationsAction } from './export-translations.action.js';
import { GetTranslationStatusAction } from './get-translation-status.action.js';
import { ListTranslationStatusesAction } from './list-translation-statuses.action.js';
import {
  ApplyTranslationImportAction,
  TranslationImportGate,
  ValidateTranslationImportAction,
} from './translation-imports.action.js';
import { TranslationJobFileAction } from './translation-job-file.action.js';

const config = ProjectConfig.parse({
  ...baseConfig,
  languages: { source: 'en', targets: ['de', 'fr'] },
  audiences: [
    { id: 'public', label: 'Public' },
    { id: 'internal', label: 'Internal' },
  ],
});

const translator = (scope: Scope = {}): Actor => ({
  ...actorWith(
    [
      'content.read',
      'content.read.draft',
      'content.edit',
      'translation.manage',
    ],
    scope,
  ),
  id: 'sample-translator',
});

const para = (id: string, text: string): Block => ({
  type: 'paragraph',
  id,
  content: [{ type: 'text', text }],
});

/** The back page: a paragraph with a placeholder, and another. */
const imprint = (text = 'Printed on '): Block[] => [
  {
    type: 'paragraph',
    id: 'imprint',
    content: [
      { type: 'text', text },
      { type: 'placeholder', key: 'date' },
    ],
  },
  para('maker', 'Made by us'),
];

const design = (extra: Partial<PageDesignInput> = {}) =>
  PageDesign.parse({
    schemaVersion: 1,
    id: 'house',
    name: 'House style',
    preset: 'classic',
    colours: { primary: '#1f4e79', accent: '#2563eb', text: '#1f2328' },
    regions: { back: imprint() },
    ...extra,
  });

const guide: Module = {
  ...module('guide', 'en'),
  blocks: [para('b1', 'One.')],
};

const contentWith = (d: PageDesign): FakeContent => ({
  config: { ...config, pdf: { ...config.pdf, design: 'house' } },
  modules: [guide],
  manifests: [manifest('user-manual', ['guide'])],
  pageDesigns: { house: printPageDesign(d) },
});

/** Each `<source>` of the design's file given a `<target>`. */
const translated = (
  xml: string,
  translate: (unit: string, source: string) => string,
) =>
  xml.replace(/<unit id="([^"]+)"[\s\S]*?<\/unit>/g, (unit, id: string) =>
    unit.replace(
      /<source>(.*?)<\/source>/gs,
      (_, source: string) =>
        `<source>${source}</source><target>${translate(id, source)}</target>`,
    ),
  );
const toGerman = (_unit: string, source: string) =>
  source
    .replace('Printed on ', 'Gedruckt am ')
    .replace('Made by us', 'Von uns');

async function setUp(from: FakeContent = contentWith(design())) {
  const snapshot = new FakeSnapshot(from);
  const repo = new FakeRepository(snapshot);
  const open = new OpenSnapshotAction(repo, new FakeAuthoredBranches());
  const jobs = new FakeTranslationJobs();
  const audit = new FakeAuditLog();
  const exporter = new ExportTranslationsAction(
    open,
    repo,
    jobs,
    audit,
    new FakeUnitOfWork(),
  );
  const check = new TranslationImportCheck(
    jobs,
    open,
    new ReadableRefs(repo),
    new FakeChangeSetBranches(),
    { maxBytes: 1024 * 1024 },
    new FakeTranslationExchange(),
  );
  const store = new FakeTranslationImportStore();
  const gate = new TranslationImportGate();
  const validate = new ValidateTranslationImportAction(check, store, gate);
  const list = new ListTranslationStatusesAction(
    jobs,
    new TranslationReads(fakeModuleIndex().readable),
  );
  const get = new GetTranslationStatusAction(jobs);
  const rows = async (
    current: FakeContent,
    filter: Parameters<typeof list.handle>[0]['filter'] = {},
    actor: Actor = translator(),
  ) =>
    (
      await list.handle({
        actor,
        snapshot: readable(current, actor),
        filter,
        page: { number: 1, size: 50 },
      })
    ).items.map(
      (s) =>
        `${s.kind} ${s.lang}/${s.moduleId} ${s.state} ${s.outdatedBlocks}/${s.blocks.length}`,
    );
  const exportDesign = async (
    subject: Parameters<ExportTranslationsAction['handle']>[0]['subject'] = {
      type: 'designs',
      designIds: ['house'],
    },
    actor: Actor = translator(),
  ) => {
    const job = await exporter.handle({
      actor,
      languages: ['de'],
      subject,
      ref: 'main',
      dueDate: null,
      dryRun: false,
    });
    repo.branches.set(job.commit, snapshot);
    const file = await new TranslationJobFileAction(jobs, open).handle({
      actor,
      id: job.id,
      lang: 'de',
    });
    return { job, xliff: file.files[0]?.xliff as string };
  };
  const moveMain = (next: FakeContent) => {
    const moved = new FakeSnapshot(next);
    (repo as unknown as { main: ContentSnapshot }).main = moved;
    repo.branches.set('change-sets/cs-1', moved);
  };
  const applying = () => {
    const saved: unknown[] = [];
    const calls: string[] = [];
    const unit = new FakeUnitOfWork();
    const step = (
      name: string,
      answer: (input: never) => unknown = () => ({}),
    ) => ({
      handle: vi.fn(async (input: never) => {
        const { subject, content } = input as {
          subject?: { type: string; designId?: string; moduleId?: string };
          content?: unknown;
        };
        calls.push(
          subject ? `${name} ${subject.designId ?? subject.moduleId}` : name,
        );
        if (name === 'save') saved.push(content);
        return answer(input);
      }),
    });
    const apply = new ApplyTranslationImportAction(
      check,
      store,
      gate,
      jobs,
      step('create', () => ({
        id: 'cs-1',
        branch: 'change-sets/cs-1',
      })) as never,
      step('lock') as never,
      step('save') as never,
      step('commit', async (input: never) => {
        const { after } = input as {
          after: (tx: never, made: { commit: string }) => Promise<void>;
        };
        await unit.run((tx) => after(tx as never, { commit: 'c'.repeat(40) }));
        return { commit: 'c'.repeat(40) };
      }) as never,
      step('abandon') as never,
      open,
      audit,
      new FakeTranslationEvents(),
    );
    return { apply, saved, calls };
  };
  return { jobs, validate, rows, get, exportDesign, moveMain, applying, audit };
}

const form = (xliff: string) => async () => ({
  bytes: new TextEncoder().encode(xliff),
});

describe('a page design’s region text in the translation status (#568)', () => {
  it('is missing, then up to date after an import, then outdated once the English text changes', async () => {
    const t = await setUp();
    const before = contentWith(design());
    expect(await t.rows(before, { lang: 'de' })).toEqual([
      // The project labels and the manual's title (#731) beside it.
      'config de/config.project missing 6/6',
      'design de/design.house missing 2/2',
      'manual de/manual.user-manual missing 1/1',
      'module de/guide missing 1/1',
    ]);

    const { xliff } = await t.exportDesign();
    expect(await t.rows(before, { lang: 'de', kind: 'design' })).toEqual([
      'design de/design.house at-provider 0/2',
    ]);
    expect(xliff).toContain(
      '<file id="design.house" original="design/house.yaml"',
    );

    const checked = await t.validate.handle({
      actor: translator(),
      form: form(translated(xliff, toGerman)),
    });
    expect(checked.counts).toMatchObject({ units: 2, ok: 2 });
    expect(checked.modules).toEqual([
      expect.objectContaining({
        lang: 'de',
        moduleId: 'design.house',
        designId: 'house',
        title: 'House style',
      }),
    ]);

    const a = t.applying();
    await a.apply.handle({
      actor: translator(),
      id: checked.id,
      decisions: [],
    });
    expect(a.calls).toEqual(['create', 'lock house', 'save house', 'commit']);
    const merged = PageDesign.parse(a.saved[0]);
    expect(merged.regions['back']).toEqual({
      en: imprint(),
      de: [
        {
          type: 'paragraph',
          id: 'imprint',
          content: [
            { type: 'text', text: 'Gedruckt am ' },
            { type: 'placeholder', key: 'date' },
          ],
        },
        para('maker', 'Von uns'),
      ],
    });
    // The job's units are back: no longer at a provider.
    expect(await t.jobs.unitsAtProvider({ lang: 'de' })).toEqual([]);

    const after = contentWith(merged);
    expect(await t.rows(after, { lang: 'de', kind: 'design' })).toEqual([
      'design de/design.house up-to-date 0/2',
    ]);
    const edited = contentWith(
      PageDesign.parse({
        ...merged,
        regions: {
          back: {
            ...(merged.regions['back'] as Record<string, Block[]>),
            en: imprint('Printed, on '),
          },
        },
      }),
    );
    expect(await t.rows(edited, { lang: 'de', kind: 'design' })).toEqual([
      'design de/design.house outdated 1/2',
    ]);
    const one = await t.get.handle({
      actor: translator(),
      snapshot: readable(edited, translator()),
      designId: 'house',
      lang: 'de',
    });
    expect(one.blocks).toEqual([
      { blockId: 'back.imprint', state: 'outdated' },
      { blockId: 'back.maker', state: 'up-to-date' },
    ]);
  });

  it('keeps the manual’s design with filter[manual], none with filter[folder], and matches its name with filter[q]', async () => {
    const t = await setUp();
    const c = contentWith(design());
    expect(await t.rows(c, { lang: 'de', manual: 'user-manual' })).toEqual([
      'config de/config.project missing 6/6',
      'design de/design.house missing 2/2',
      'manual de/manual.user-manual missing 1/1',
      'module de/guide missing 1/1',
    ]);
    expect(await t.rows(c, { lang: 'de', manual: 'nope' })).toEqual([]);
    expect(await t.rows(c, { lang: 'de', folder: guide.meta.type })).toEqual([
      'module de/guide missing 1/1',
    ]);
    // The modules named (#694): their rows only, no design's.
    expect(
      await t.rows(c, { lang: 'de', modules: new Set([guide.id]) }),
    ).toEqual(['module de/guide missing 1/1']);
    expect(await t.rows(c, { lang: 'de', q: 'house st' })).toEqual([
      'design de/design.house missing 2/2',
    ]);
  });

  it('is not found for a design without region text, or one that is not there', async () => {
    const t = await setUp();
    const c = contentWith(design({ regions: {} }));
    expect(await t.rows(c, { kind: 'design' })).toEqual([]);
    await expect(
      t.get.handle({
        actor: translator(),
        snapshot: readable(c, translator()),
        designId: 'house',
        lang: 'de',
      }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('a page design’s region text in an export and an import (#568)', () => {
  it('goes with a manual’s export, from the configuration’s design', async () => {
    const t = await setUp();
    const { job, xliff } = await t.exportDesign({
      type: 'manual',
      manualId: 'user-manual',
    });
    // With the manual's title (#731); not the project labels: this manager may not change the
    // configuration, so could not import them.
    expect(job.counts).toMatchObject({ modules: 3, units: 4 });
    expect(xliff).not.toContain('<file id="config.project"');
    expect(xliff).toContain('<file id="design.house"');
    expect(xliff).toContain('<file id="guide"');
  });

  it('is not sent to a translation manager whose role is limited by more than languages', async () => {
    const t = await setUp();
    const limited = translator({ languages: ['de'], maxAudience: 'public' });
    await expect(
      t.exportDesign({ type: 'designs', designIds: ['house'] }, limited),
    ).rejects.toMatchObject({ code: 'nothing-to-translate' });
  });

  it('refuses a placeholder the source has not, naming the unit, and imports the rest', async () => {
    const t = await setUp();
    const { xliff } = await t.exportDesign();
    const sneaky = translated(xliff, (unit, source) =>
      unit === 'back.imprint'
        ? `${toGerman(unit, source)} <ph id="9" type="other" subType="ccms:placeholder" disp="[title]" ccms:key="title"/>`
        : toGerman(unit, source),
    );
    const checked = await t.validate.handle({
      actor: translator(),
      form: form(sneaky),
    });
    expect(checked.modules[0]?.units).toEqual([
      expect.objectContaining({
        blockId: 'back.imprint',
        state: 'broken-markup',
      }),
      expect.objectContaining({ blockId: 'back.maker', state: 'ok' }),
    ]);
  });

  it('keeps Typst and AsciiDoc markup in a translation as text', async () => {
    const t = await setUp();
    const { xliff } = await t.exportDesign();
    const hostile = translated(xliff, (unit, source) =>
      unit === 'back.maker' ? '#read("/etc/passwd") *bold* &lt;b&gt;' : source,
    );
    const checked = await t.validate.handle({
      actor: translator(),
      form: form(hostile),
    });
    const a = t.applying();
    await a.apply.handle({
      actor: translator(),
      id: checked.id,
      decisions: [],
    });
    const merged = PageDesign.parse(a.saved[0]);
    const de = (merged.regions['back'] as Record<string, Block[]>)['de'];
    expect(de?.[1]).toEqual(para('maker', '#read("/etc/passwd") *bold* <b>'));
  });

  it('is outside the scope of one who may not change page designs', async () => {
    const t = await setUp();
    const { xliff } = await t.exportDesign();
    const reader = {
      ...actorWith(
        ['content.read', 'content.read.draft', 'translation.manage'],
        {},
      ),
      id: 'sample-translator',
    };
    const checked = await t.validate.handle({
      actor: reader,
      form: form(translated(xliff, toGerman)),
    });
    expect(checked.modules[0]?.units.map((u) => u.state)).toEqual([
      'outside-scope',
      'outside-scope',
    ]);
  });
});

describe('mergeDesignTranslation', () => {
  it('keeps the source’s block IDs where the translation had others, and its text for the blocks it shares', () => {
    const d = design({
      regions: {
        back: {
          en: imprint(),
          de: [para('maker', 'Von uns'), para('old', 'Alt')],
        },
      },
    });
    const merged = mergeDesignTranslation(
      d,
      'de',
      'en',
      'a'.repeat(40),
      new Map([
        [
          'back.imprint',
          {
            parts: [
              {
                field: 'content',
                content: [
                  { type: 'text', text: 'Gedruckt am ' },
                  { type: 'placeholder', key: 'date' },
                ],
              },
            ],
            hash: 'b'.repeat(64),
          },
        ],
      ]),
    );
    const back = merged.regions['back'] as Record<string, Block[]>;
    expect(regionBlocksDiffer(back['de'] ?? [], back['en'] ?? [])).toBe(
      undefined,
    );
    expect(back['de']?.[1]).toEqual(para('maker', 'Von uns'));
    expect(back['en']).toEqual(imprint());
    expect(merged.translations).toEqual({
      de: {
        sourceCommit: 'a'.repeat(40),
        blocks: { 'back.imprint': 'b'.repeat(64) },
      },
    });
  });
});
