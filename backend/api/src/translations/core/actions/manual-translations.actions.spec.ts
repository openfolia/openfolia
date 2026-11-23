import {
  coverUnitKey,
  Manifest,
  PageDesign,
  printPageDesign,
  ProjectConfig,
  type Block,
  type Module,
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
import { TranslationReads } from '../translation-index.js';
import { TranslationImportCheck } from '../translation-import-check.js';
import { ExportTranslationsAction } from './export-translations.action.js';
import { GetTranslationStatusAction } from './get-translation-status.action.js';
import { ListTranslationStatusesAction } from './list-translation-statuses.action.js';
import { MarkTranslationCurrentAction } from './mark-translation-current.action.js';
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

const ASSET = 'sha256:' + 'a'.repeat(64);
const LARGE = coverUnitKey({ model: 'large' });

const para = (id: string, text: string): Block => ({
  type: 'paragraph',
  id,
  content: [{ type: 'text', text }],
});

const guide: Module = {
  ...module('guide', 'en'),
  blocks: [para('b1', 'One.')],
};

/** The manual with its own cover image and the large variant's. */
const covered = (extra: Partial<Manifest> = {}): Manifest =>
  Manifest.parse({
    ...manifest('user-manual', ['guide']),
    coverImage: {
      default: { asset: ASSET, alt: 'The vehicle' },
      variants: [
        { variant: { model: 'large' }, asset: ASSET, alt: 'The large one' },
      ],
    },
    ...extra,
  });

const contentWith = (m: Manifest, more: Partial<FakeContent> = {}) =>
  ({
    config,
    modules: [guide],
    manifests: [m],
    ...more,
  }) satisfies FakeContent;

/** Each `<source>` of the manual's file given a `<target>`. */
const translated = (
  xml: string,
  translate: (unit: string, source: string) => string,
) =>
  xml.replace(/<file id="manual\.[^"]+"[\s\S]*?<\/file>/g, (file) =>
    file.replace(/<unit id="([^"]+)"[\s\S]*?<\/unit>/g, (unit, id: string) =>
      unit.replace(
        /<source>(.*?)<\/source>/gs,
        (_, source: string) =>
          `<source>${source}</source><target>${translate(id, source)}</target>`,
      ),
    ),
  );
const toGerman = (_unit: string, source: string) =>
  source
    .replace('Manual user-manual', 'Handbuch')
    .replace('The vehicle', 'Das Fahrzeug')
    .replace('The large one', 'Das große');

async function setUp(from: FakeContent = contentWith(covered())) {
  const snapshot = new FakeSnapshot(from);
  const repo = new FakeRepository(snapshot);
  const open = new OpenSnapshotAction(repo, new FakeAuthoredBranches());
  const jobs = new FakeTranslationJobs();
  const audit = new FakeAuditLog();
  const events = new FakeTranslationEvents();
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
  const exportManual = async (
    subject: Parameters<ExportTranslationsAction['handle']>[0]['subject'] = {
      type: 'manuals',
      manualIds: ['user-manual'],
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
          subject?: {
            type: string;
            manualId?: string;
            designId?: string;
            moduleId?: string;
          };
          content?: unknown;
        };
        calls.push(
          subject
            ? `${name} ${subject.type} ${subject.manualId ?? subject.designId ?? subject.moduleId}`
            : name,
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
      events,
    );
    return { apply, saved, calls };
  };
  return {
    jobs,
    validate,
    rows,
    get,
    exportManual,
    moveMain,
    applying,
    audit,
    events,
    repo,
    open,
  };
}

const form = (xliff: string) => async () => ({
  bytes: new TextEncoder().encode(xliff),
});

describe('a manual’s cover image alternative text in the translation status (#656)', () => {
  it('is missing, then up to date after an import, then outdated once the English text changes', async () => {
    const t = await setUp();
    const before = contentWith(covered());
    // The manual's title is a unit of its own text too (#731).
    expect(
      await t.rows(before, { lang: 'de' }).then((r) => r.slice(1)),
    ).toEqual([
      'manual de/manual.user-manual missing 3/3',
      'module de/guide missing 1/1',
    ]);

    const { xliff } = await t.exportManual();
    expect(await t.rows(before, { lang: 'de', kind: 'manual' })).toEqual([
      'manual de/manual.user-manual at-provider 0/3',
    ]);
    expect(xliff).toContain(
      '<file id="manual.user-manual" original="manuals/user-manual.yaml"',
    );
    expect(xliff).toContain('<unit id="coverImage.default"');
    expect(xliff).toContain(`<unit id="${LARGE}"`);

    const checked = await t.validate.handle({
      actor: translator(),
      form: form(translated(xliff, toGerman)),
    });
    expect(checked.counts).toMatchObject({ units: 3, ok: 3 });
    expect(checked.modules).toEqual([
      expect.objectContaining({
        lang: 'de',
        moduleId: 'manual.user-manual',
        manualId: 'user-manual',
        title: 'Manual user-manual',
      }),
    ]);

    const a = t.applying();
    await a.apply.handle({
      actor: translator(),
      id: checked.id,
      decisions: [],
    });
    expect(a.calls).toEqual([
      'create',
      'lock manual user-manual',
      'save manual user-manual',
      'commit',
    ]);
    const merged = Manifest.parse(a.saved[0]);
    expect(merged.coverImage?.default?.alt).toEqual({
      en: 'The vehicle',
      de: 'Das Fahrzeug',
    });
    expect(merged.coverImage?.variants[0]?.alt).toEqual({
      en: 'The large one',
      de: 'Das große',
    });
    expect(merged.translations?.['de']?.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    // The outline is untouched.
    expect(merged.entries).toEqual(covered().entries);
    expect(await t.jobs.unitsAtProvider({ lang: 'de' })).toEqual([]);
    // The outbox row names the manual (#656), the modules' fields as they were.
    expect(t.events.events[0]?.payload).toMatchObject({
      modules: [],
      moduleCount: 0,
      designs: [],
      designCount: 0,
      manuals: [{ lang: 'de', manualId: 'user-manual' }],
      manualCount: 1,
    });

    const after = contentWith(merged);
    expect(await t.rows(after, { lang: 'de', kind: 'manual' })).toEqual([
      'manual de/manual.user-manual up-to-date 0/3',
    ]);
    const edited = contentWith(
      Manifest.parse({
        ...merged,
        coverImage: {
          ...merged.coverImage,
          default: {
            asset: ASSET,
            alt: { en: 'The new vehicle', de: 'Das Fahrzeug' },
          },
        },
      }),
    );
    const one = await t.get.handle({
      actor: translator(),
      snapshot: readable(edited, translator()),
      manualId: 'user-manual',
      lang: 'de',
    });
    expect(one).toMatchObject({ kind: 'manual', state: 'outdated' });
    expect(one.blocks).toEqual([
      { blockId: 'title', state: 'up-to-date' },
      { blockId: 'coverImage.default', state: 'outdated' },
      { blockId: LARGE, state: 'up-to-date' },
    ]);
  });

  it('keeps the manual’s row with filter[manual], none with filter[folder], and matches its title with filter[q]', async () => {
    const t = await setUp();
    const c = contentWith(covered());
    expect(
      await t.rows(c, { lang: 'de', manual: 'user-manual', kind: 'manual' }),
    ).toEqual(['manual de/manual.user-manual missing 3/3']);
    expect(await t.rows(c, { lang: 'de', manual: 'nope' })).toEqual([]);
    expect(await t.rows(c, { lang: 'de', folder: guide.meta.type })).toEqual([
      'module de/guide missing 1/1',
    ]);
    // The modules named (#694): their rows only, no manual's.
    expect(
      await t.rows(c, { lang: 'de', modules: new Set([guide.id]) }),
    ).toEqual(['module de/guide missing 1/1']);
    expect(await t.rows(c, { lang: 'de', q: 'manual user' })).toEqual([
      'manual de/manual.user-manual missing 3/3',
    ]);
  });

  it('has a row for a manual without cover image text, its title (#731), and none for one the reader may not see', async () => {
    const t = await setUp();
    const plain = contentWith(manifest('user-manual', ['guide']));
    expect(await t.rows(plain, { kind: 'manual' })).toEqual([
      'manual de/manual.user-manual missing 1/1',
      'manual fr/manual.user-manual missing 1/1',
    ]);
    const hidden = contentWith(covered({ audience: 'internal' }));
    const outsider = translator({ maxAudience: 'public' });
    expect(await t.rows(hidden, { kind: 'manual' }, outsider)).toEqual([]);
    await expect(
      t.get.handle({
        actor: outsider,
        snapshot: readable(hidden, outsider),
        manualId: 'user-manual',
        lang: 'de',
      }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('a manual’s cover image alternative text in an export and an import (#656)', () => {
  it('goes with a manual’s export, beside its design and modules', async () => {
    const d = PageDesign.parse({
      schemaVersion: 1,
      id: 'house',
      name: 'House style',
      preset: 'classic',
      colours: { primary: '#1f4e79', accent: '#2563eb', text: '#1f2328' },
      regions: { back: [para('maker', 'Made by us')] },
    });
    const t = await setUp(
      contentWith(covered({ design: 'house' }), {
        pageDesigns: { house: printPageDesign(d) },
      }),
    );
    const { job, xliff } = await t.exportManual({
      type: 'manual',
      manualId: 'user-manual',
    });
    // With the manual's title (#731); not the project labels: this manager may not change the
    // configuration, so could not import them.
    expect(job.counts).toMatchObject({ modules: 3, units: 5 });
    expect(xliff).not.toContain('<file id="config.project"');
    expect(xliff).toContain('<file id="design.house"');
    expect(xliff).toContain('<file id="manual.user-manual"');
    expect(xliff).toContain('<file id="guide"');
  });

  it('is not sent to a translation manager whose audience does not reach the manual', async () => {
    const t = await setUp(contentWith(covered({ audience: 'internal' })));
    const limited = translator({ maxAudience: 'public' });
    await expect(
      t.exportManual({ type: 'manuals', manualIds: ['user-manual'] }, limited),
    ).rejects.toMatchObject({ code: 'nothing-to-translate' });
  });

  it('keeps Typst and HTML markup in a translation as plain text, and refuses one that is no alternative text', async () => {
    const t = await setUp();
    const { xliff } = await t.exportManual();
    const hostile = translated(xliff, (unit) =>
      unit === 'coverImage.default' || unit === 'title'
        ? '  #read("/etc/passwd") &lt;img src=x onerror=alert(1)&gt; "quoted"  '
        : 'x'.repeat(501),
    );
    const checked = await t.validate.handle({
      actor: translator(),
      form: form(hostile),
    });
    expect(checked.modules[0]?.units).toEqual([
      expect.objectContaining({ blockId: 'title', state: 'ok' }),
      expect.objectContaining({ blockId: 'coverImage.default', state: 'ok' }),
      expect.objectContaining({
        blockId: LARGE,
        state: 'broken-markup',
        reason: 'invalid-content',
      }),
    ]);
    const a = t.applying();
    await a.apply.handle({
      actor: translator(),
      id: checked.id,
      decisions: [],
    });
    const merged = Manifest.parse(a.saved[0]);
    expect(merged.coverImage?.default?.alt).toEqual({
      en: 'The vehicle',
      de: '#read("/etc/passwd") <img src=x onerror=alert(1)> "quoted"',
    });
    expect(merged.coverImage?.variants[0]?.alt).toBe('The large one');
    expect(merged.title).toEqual({
      en: 'Manual user-manual',
      de: '#read("/etc/passwd") <img src=x onerror=alert(1)> "quoted"',
    });
  });

  it('refuses a line break typed in the translation', async () => {
    const t = await setUp();
    const { xliff } = await t.exportManual();
    const checked = await t.validate.handle({
      actor: translator(),
      form: form(translated(xliff, () => 'Zwei\nZeilen')),
    });
    expect(checked.modules[0]?.units.map((u) => u.state)).toEqual([
      'broken-markup',
      'broken-markup',
      'broken-markup',
    ]);
    // A Unicode line separator or a control character is no one line either.
    const separated = await t.validate.handle({
      actor: translator(),
      form: form(translated(xliff, () => 'Zwei\u2028Zeilen\u0085')),
    });
    expect(separated.modules[0]?.units.map((u) => u.state)).toEqual([
      'broken-markup',
      'broken-markup',
      'broken-markup',
    ]);
  });

  it('is outside the scope of one who may not change the manual', async () => {
    const t = await setUp();
    const { xliff } = await t.exportManual();
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
      'outside-scope',
    ]);
  });

  it('never writes another manual through a <file id> the job did not send', async () => {
    const other = Manifest.parse({
      ...covered(),
      id: 'other-manual',
      title: 'Other',
    });
    const t = await setUp(
      contentWith(covered(), { manifests: [covered(), other] }),
    );
    const { xliff } = await t.exportManual();
    const forged = translated(xliff, toGerman).replace(
      'id="manual.user-manual"',
      'id="manual.other-manual"',
    );
    const checked = await t.validate.handle({
      actor: translator(),
      form: form(forged),
    });
    expect(checked.modules[0]).toMatchObject({ manualId: 'other-manual' });
    expect(checked.modules[0]?.units.map((u) => u.state)).toEqual([
      'unknown-block',
      'unknown-block',
      'unknown-block',
    ]);
    await expect(
      t.applying().apply.handle({
        actor: translator(),
        id: checked.id,
        decisions: [],
      }),
    ).rejects.toMatchObject({ code: 'nothing-to-import' });
    // A key that is no manual's (path characters) is no manual at all.
    const odd = translated(xliff, toGerman).replace(
      'id="manual.user-manual"',
      'id="manual.x..%2Fconfig"',
    );
    const read = await t.validate.handle({
      actor: translator(),
      form: form(odd),
    });
    expect(read.modules[0]?.manualId).toBeUndefined();
    expect(read.modules[0]?.units.map((u) => u.state)).toEqual([
      'unknown-module',
      'unknown-module',
      'unknown-module',
    ]);
  });
});

describe('marking a manual’s or a design’s translation current (#656)', () => {
  function marking(from: FakeContent) {
    const snapshot = new FakeSnapshot(from);
    const repo = new FakeRepository(snapshot);
    repo.branches.set('change-sets/cs-1', snapshot);
    const open = new OpenSnapshotAction(repo, new FakeAuthoredBranches());
    const audit = new FakeAuditLog();
    const unit = new FakeUnitOfWork();
    const saved: { subject: unknown; content: unknown }[] = [];
    const copies = new Set<string>();
    const commit = { fails: false };
    const discard = { handle: vi.fn(async () => undefined) };
    const mark = new MarkTranslationCurrentAction(
      {
        handle: vi.fn(async () => ({
          id: 'cs-1',
          branch: 'change-sets/cs-1',
        })),
      } as never,
      open,
      { handle: vi.fn(async () => undefined) } as never,
      {
        handle: vi.fn(
          async (input: {
            after: (tx: never, m: { commit: string }) => Promise<void>;
          }) => {
            if (commit.fails) throw new Error('the branch moved');
            await unit.run((tx) =>
              input.after(tx as never, { commit: 'd'.repeat(40) }),
            );
            return { commit: 'd'.repeat(40) };
          },
        ),
      } as never,
      {
        handle: vi.fn(async (input: { subject: unknown; content: unknown }) => {
          saved.push(input);
        }),
      } as never,
      {
        find: vi.fn(async (_cs: string, s: { type: string }) =>
          copies.has(s.type) ? {} : undefined,
        ),
      } as never,
      audit,
      discard as never,
    );
    return { mark, saved, audit, copies, commit, discard };
  }

  const germanCover = covered({
    coverImage: {
      default: {
        asset: ASSET,
        alt: { en: 'The new vehicle', de: 'Das Fahrzeug' },
      },
      variants: [],
    },
    translations: {
      de: {
        sourceCommit: 'a'.repeat(40),
        blocks: { 'coverImage.default': 'e'.repeat(64) },
      },
    },
  });

  it('takes the current source’s hash for a manual’s cover image text, its text unchanged', async () => {
    const m = marking(contentWith(germanCover));
    const done = await m.mark.handle({
      actor: translator(),
      changeSetId: 'cs-1',
      manualId: 'user-manual',
      lang: 'de',
    });
    expect(done).toMatchObject({
      moduleId: 'manual.user-manual',
      manualId: 'user-manual',
      blocks: 1,
      commit: 'd'.repeat(40),
    });
    const content = Manifest.parse(m.saved[0]?.content);
    expect(content.coverImage).toEqual(germanCover.coverImage);
    expect(content.translations?.['de']?.blocks['coverImage.default']).not.toBe(
      'e'.repeat(64),
    );
    expect(m.audit.events[0]).toMatchObject({
      action: 'translation.mark-current',
      subject: { type: 'manual', id: 'user-manual' },
      data: { lang: 'de' },
    });
    expect(m.discard.handle).not.toHaveBeenCalled();
  });

  it('discards its working copy again when the save point fails', async () => {
    const m = marking(contentWith(germanCover));
    m.commit.fails = true;
    await expect(
      m.mark.handle({
        actor: translator(),
        changeSetId: 'cs-1',
        manualId: 'user-manual',
        lang: 'de',
      }),
    ).rejects.toThrow('the branch moved');
    expect(m.discard.handle).toHaveBeenCalledWith(
      expect.objectContaining({
        changeSetId: 'cs-1',
        subject: { type: 'manual', manualId: 'user-manual' },
      }),
    );
    expect(m.audit.events).toEqual([]);
  });

  it('refuses a manual without its own text in the language, one with a working copy, and one the actor may not change', async () => {
    const m = marking(contentWith(germanCover));
    await expect(
      m.mark.handle({
        actor: translator(),
        changeSetId: 'cs-1',
        manualId: 'user-manual',
        lang: 'fr',
      }),
    ).rejects.toMatchObject({ code: 'translation-missing' });
    m.copies.add('manual');
    await expect(
      m.mark.handle({
        actor: translator(),
        changeSetId: 'cs-1',
        manualId: 'user-manual',
        lang: 'de',
      }),
    ).rejects.toMatchObject({ code: 'uncommitted-working-copies' });
    const reader = {
      ...actorWith(
        ['content.read', 'content.read.draft', 'translation.manage'],
        {},
      ),
      id: 'sample-translator',
    };
    await expect(
      m.mark.handle({
        actor: reader,
        changeSetId: 'cs-1',
        manualId: 'user-manual',
        lang: 'de',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('marks a design’s region text current', async () => {
    const d = PageDesign.parse({
      schemaVersion: 1,
      id: 'house',
      name: 'House style',
      preset: 'classic',
      colours: { primary: '#1f4e79', accent: '#2563eb', text: '#1f2328' },
      regions: {
        back: {
          en: [para('maker', 'Made by us')],
          de: [para('maker', 'Von uns')],
        },
      },
    });
    const m = marking(
      contentWith(covered(), { pageDesigns: { house: printPageDesign(d) } }),
    );
    const done = await m.mark.handle({
      actor: translator(),
      changeSetId: 'cs-1',
      designId: 'house',
      lang: 'de',
    });
    expect(done).toMatchObject({
      moduleId: 'design.house',
      designId: 'house',
      blocks: 1,
    });
    const content = PageDesign.parse(m.saved[0]?.content);
    expect(content.regions).toEqual(d.regions);
    expect(Object.keys(content.translations?.['de']?.blocks ?? {})).toEqual([
      'back.maker',
    ]);
    // Limited by more than languages: no design of theirs.
    await expect(
      m.mark.handle({
        actor: translator({ maxAudience: 'public' }),
        changeSetId: 'cs-1',
        designId: 'house',
        lang: 'de',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});
