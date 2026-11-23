import { ProjectConfig, StrictProjectConfig } from '@openfolia/content-model';
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
import { FakeTranslationExchange } from '../../../../tests/fakes/fake-translation-exchange.js';
import { FakeTranslationImportStore } from '../../../../tests/fakes/fake-translation-import-store.js';
import { FakeTranslationJobs } from '../../../../tests/fakes/fake-translation-jobs.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import type { Actor, Scope } from '../../../access/core/actor.js';
import type { Permission } from '../../../access/core/permissions.js';
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

/** Two labels to translate: a module type and an audience. */
const config = ProjectConfig.parse({
  ...baseConfig,
  languages: { source: 'en', targets: ['de', 'fr'] },
  variantAttributes: [],
});

const ALL: Permission[] = [
  'content.read',
  'content.read.draft',
  'content.edit',
  'translation.manage',
  'admin.roles',
];

/** A translation manager who may change the configuration. */
const manager = (scope: Scope = {}): Actor => ({
  ...actorWith(ALL, scope),
  id: 'sample-translator',
});

/** Manages translations, may not change the configuration (no `admin.roles`). */
const translator = (): Actor => ({
  ...actorWith(
    [
      'content.read',
      'content.read.draft',
      'content.edit',
      'translation.manage',
    ],
    {},
  ),
  id: 'sample-translator',
});

const guide = module('guide', 'en');

const contentWith = (c: ProjectConfig = config): FakeContent => ({
  config: c,
  modules: [guide],
  manifests: [manifest('user-manual', ['guide'])],
});

/** Each `<source>` of the document given a `<target>`. */
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
const GERMAN: Record<string, string> = {
  Concept: 'Konzept',
  Public: 'Öffentlich',
  'Manual user-manual': 'Handbuch',
  'Title of guide': 'Titel',
  'Hello.': 'Hallo.',
};
const toGerman = (_unit: string, source: string) => GERMAN[source] ?? source;

const form = (xliff: string) => async () => ({
  bytes: new TextEncoder().encode(xliff),
});

function setUp(from: FakeContent = contentWith()) {
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
    actor: Actor = manager(),
    by: 'status' | 'row' = 'status',
  ) =>
    (
      await list.handle({
        actor,
        snapshot: readable(current, actor),
        filter,
        page: { number: 1, size: 50 },
        by,
      })
    ).items.map(
      (s) =>
        `${s.kind} ${s.lang}/${s.moduleId} ${s.state} ${s.outdatedBlocks}/${s.blocks.length}`,
    );
  const exportOf = async (
    subject: Parameters<ExportTranslationsAction['handle']>[0]['subject'] = {
      type: 'config',
    },
    actor: Actor = manager(),
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
    const saved: { subject: unknown; content: unknown }[] = [];
    const calls: string[] = [];
    const unit = new FakeUnitOfWork();
    const events = new FakeTranslationEvents();
    const step = (
      name: string,
      answer: (input: never) => unknown = () => ({}),
    ) => ({
      handle: vi.fn(async (input: never) => {
        const { subject, content } = input as {
          subject?: { type: string; moduleId?: string; manualId?: string };
          content?: unknown;
        };
        calls.push(
          subject
            ? `${name} ${subject.moduleId ?? subject.manualId ?? subject.type}`
            : name,
        );
        if (name === 'save') saved.push({ subject, content });
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
    return { apply, saved, calls, events };
  };
  return {
    repo,
    jobs,
    validate,
    rows,
    get,
    exportOf,
    moveMain,
    applying,
    audit,
  };
}

describe('the project labels in the translation status (#731)', () => {
  it('come first, missing, then up to date after an import, then outdated once a source label changes', async () => {
    const t = setUp();
    const before = contentWith();
    expect(await t.rows(before, { lang: 'de' })).toEqual([
      'config de/config.project missing 2/2',
      'manual de/manual.user-manual missing 1/1',
      'module de/guide missing 1/1',
    ]);

    const { job, xliff } = await t.exportOf();
    expect(job.counts).toMatchObject({ modules: 1, units: 2 });
    expect(xliff).toContain(
      '<file id="config.project" original="openfolia.yaml"',
    );
    expect(await t.rows(before, { lang: 'de', kind: 'config' })).toEqual([
      'config de/config.project at-provider 0/2',
    ]);
    expect(t.audit.events.at(-1)).toMatchObject({
      action: 'translation-job.export',
      data: { subject: { type: 'config' } },
    });

    const checked = await t.validate.handle({
      actor: manager(),
      form: form(translated(xliff, toGerman)),
    });
    expect(checked.counts).toMatchObject({ units: 2, ok: 2 });
    expect(checked.modules).toEqual([
      expect.objectContaining({
        lang: 'de',
        moduleId: 'config.project',
        config: true,
        title: 'Project labels',
      }),
    ]);

    const a = t.applying();
    const applied = await a.apply.handle({
      actor: manager(),
      id: checked.id,
      decisions: [],
    });
    expect(applied.state).toBe('applied');
    expect(a.calls).toEqual(['create', 'lock config', 'save config', 'commit']);
    // The working copy is a configuration as stored: the strict schema takes it.
    const merged = StrictProjectConfig.parse(a.saved[0]?.content);
    expect(merged.moduleTypes).toEqual([
      expect.objectContaining({
        id: 'concept',
        label: { en: 'Concept', de: 'Konzept' },
      }),
    ]);
    expect(merged.audiences).toEqual([
      expect.objectContaining({
        id: 'public',
        label: { en: 'Public', de: 'Öffentlich' },
      }),
    ]);
    expect(Object.keys(merged.translations?.['de']?.blocks ?? {})).toEqual([
      'moduleTypes.concept',
      'audiences.public',
    ]);
    expect(merged.translations?.['de']?.sourceCommit).toBe(job.commit);
    expect(await t.jobs.unitsAtProvider({ lang: 'de' })).toEqual([]);
    expect(t.audit.events.at(-1)).toMatchObject({
      action: 'translation.import',
      data: { config: true },
    });
    expect(a.events.events.at(-1)?.payload).toMatchObject({
      configLanguages: ['de'],
    });

    const after = contentWith(merged);
    expect(await t.rows(after, { lang: 'de', kind: 'config' })).toEqual([
      'config de/config.project up-to-date 0/2',
    ]);
    const edited = contentWith({
      ...merged,
      moduleTypes: merged.moduleTypes.map((m) =>
        m.id === 'concept'
          ? { ...m, label: { en: 'Concepts', de: 'Konzept' } }
          : m,
      ),
    });
    const one = await t.get.handle({
      actor: manager(),
      snapshot: readable(edited, manager()),
      config: true,
      lang: 'de',
    });
    expect(one).toMatchObject({ kind: 'config', state: 'outdated' });
    expect(one.blocks).toEqual([
      { blockId: 'moduleTypes.concept', state: 'outdated' },
      { blockId: 'audiences.public', state: 'up-to-date' },
    ]);
  });

  it('keeps them with filter[manual] (not for a manual the reader may not see), none with filter[folder] or filter[module], and matches “labels” and “config” with filter[q]', async () => {
    const t = setUp();
    const c = contentWith();
    expect(await t.rows(c, { lang: 'de', manual: 'user-manual' })).toEqual([
      'config de/config.project missing 2/2',
      'manual de/manual.user-manual missing 1/1',
      'module de/guide missing 1/1',
    ]);
    expect(await t.rows(c, { lang: 'de', manual: 'nope' })).toEqual([]);
    expect(await t.rows(c, { lang: 'de', folder: guide.meta.type })).toEqual([
      'module de/guide missing 1/1',
    ]);
    expect(
      await t.rows(c, { lang: 'de', modules: new Set([guide.id]) }),
    ).toEqual(['module de/guide missing 1/1']);
    for (const q of ['labels', 'config']) {
      expect(await t.rows(c, { lang: 'de', q })).toEqual([
        'config de/config.project missing 2/2',
      ]);
    }
    expect(await t.rows(c, { lang: 'de', kind: 'module' })).toEqual([
      'module de/guide missing 1/1',
    ]);
  });

  it('counts as one row of the matrix, with a status per language', async () => {
    const t = setUp();
    const listed = await t.rows(contentWith(), {}, manager(), 'row');
    expect(listed.slice(0, 2)).toEqual([
      'config de/config.project missing 2/2',
      'config fr/config.project missing 2/2',
    ]);
  });

  it('is shown to every status reader in each language their scope holds', async () => {
    const t = setUp();
    const reader = {
      ...actorWith(['content.read', 'content.read.draft'], {
        languages: ['en', 'fr'],
        maxAudience: 'public',
      }),
      id: 'reader',
    };
    expect(await t.rows(contentWith(), { kind: 'config' }, reader)).toEqual([
      'config de/config.project missing 2/2',
      'config fr/config.project missing 2/2',
    ]);
  });

  it('is not found without a label to translate, or for no target language', async () => {
    const t = setUp();
    // Read leniently, labels without source-language text are no units.
    const none = contentWith(
      ProjectConfig.parse({
        ...config,
        moduleTypes: [{ id: 'concept', label: { de: 'Konzept' } }],
        audiences: [{ id: 'public', label: { de: 'Öffentlich' } }],
      }),
    );
    expect(await t.rows(none, { kind: 'config' })).toEqual([]);
    for (const [content, lang] of [
      [none, 'de'],
      [contentWith(), 'it'],
    ] as const) {
      await expect(
        t.get.handle({
          actor: manager(),
          snapshot: readable(content, manager()),
          config: true,
          lang,
        }),
      ).rejects.toThrow(NotFoundError);
    }
  });
});

describe('the project labels in an export and an import (#731)', () => {
  it('go with a manual’s export, beside its own text and modules', async () => {
    const t = setUp();
    const { job, xliff } = await t.exportOf({
      type: 'manual',
      manualId: 'user-manual',
    });
    expect(job.counts).toMatchObject({ modules: 3, units: 4 });
    expect(xliff).toContain('<file id="config.project"');
    expect(xliff).toContain('<file id="manual.user-manual"');
    expect(xliff).toContain('<file id="guide"');
  });

  it('are not sent to a translation manager whose role is limited by more than languages', async () => {
    const t = setUp();
    await expect(
      t.exportOf(
        { type: 'config' },
        manager({ languages: ['de'], maxAudience: 'public' }),
      ),
    ).rejects.toMatchObject({ code: 'nothing-to-translate' });
  });

  it('are not sent to one who may not change the configuration, so none waits at a provider for an import that could not apply it', async () => {
    const t = setUp();
    await expect(
      t.exportOf({ type: 'config' }, translator()),
    ).rejects.toMatchObject({ code: 'nothing-to-translate' });
    const { xliff } = await t.exportOf(
      { type: 'manual', manualId: 'user-manual' },
      translator(),
    );
    expect(xliff).not.toContain('<file id="config.project"');
    expect(xliff).toContain('<file id="manual.user-manual"');
    // The labels are still due for one who may import them.
    const later = await t.exportOf({ type: 'config' });
    expect(later.xliff).toContain('<file id="config.project"');
  });

  it('keep markup in a translation as plain text, and refuse one that is no label', async () => {
    const t = setUp();
    const { xliff } = await t.exportOf();
    const hostile = translated(xliff, (unit) =>
      unit === 'moduleTypes.concept'
        ? '#read("/etc/passwd") *bold* &lt;b&gt;'
        : 'x'.repeat(501),
    );
    const checked = await t.validate.handle({
      actor: manager(),
      form: form(hostile),
    });
    expect(checked.modules[0]?.units).toEqual([
      expect.objectContaining({ blockId: 'moduleTypes.concept', state: 'ok' }),
      expect.objectContaining({
        blockId: 'audiences.public',
        state: 'broken-markup',
        reason: 'invalid-content',
      }),
    ]);
    const a = t.applying();
    await a.apply.handle({ actor: manager(), id: checked.id, decisions: [] });
    const merged = StrictProjectConfig.parse(a.saved[0]?.content);
    expect(merged.moduleTypes[0]?.label).toEqual({
      en: 'Concept',
      de: '#read("/etc/passwd") *bold* <b>',
    });
    expect(merged.audiences[0]?.label).toBe('Public');
    expect(Object.keys(merged.translations?.['de']?.blocks ?? {})).toEqual([
      'moduleTypes.concept',
    ]);
  });

  it('refuse a line break typed in the translation', async () => {
    const t = setUp();
    const { xliff } = await t.exportOf();
    const broken = translated(xliff, (unit, source) =>
      unit === 'audiences.public' ? 'Öffent&#10;lich' : toGerman(unit, source),
    );
    const checked = await t.validate.handle({
      actor: manager(),
      form: form(broken),
    });
    expect(
      checked.modules[0]?.units.find((u) => u.blockId === 'audiences.public'),
    ).toMatchObject({ state: 'broken-markup' });
  });

  it('are outside the scope of one who may not change the configuration, or manages more than languages', async () => {
    const t = setUp();
    const { xliff } = await t.exportOf();
    for (const actor of [translator(), manager({ maxAudience: 'public' })]) {
      const checked = await t.validate.handle({
        actor,
        form: form(translated(xliff, toGerman)),
      });
      expect(checked.modules[0]?.units.map((u) => u.state)).toEqual([
        'outside-scope',
        'outside-scope',
      ]);
      expect(checked.modules[0]).not.toHaveProperty('title');
    }
  });

  it('are source-changed where a label changed on the base since, and gone where it was removed', async () => {
    const t = setUp();
    const { xliff } = await t.exportOf();
    t.moveMain(
      contentWith(
        ProjectConfig.parse({
          ...config,
          moduleTypes: [{ id: 'concept', label: 'Concepts' }],
          audiences: [{ id: 'everyone', label: 'Everyone' }],
        }),
      ),
    );
    const checked = await t.validate.handle({
      actor: manager(),
      form: form(translated(xliff, toGerman)),
    });
    expect(checked.modules[0]?.units).toEqual([
      expect.objectContaining({
        blockId: 'moduleTypes.concept',
        state: 'source-changed',
        texts: expect.objectContaining({
          exported: 'Concept',
          current: 'Concepts',
          target: 'Konzept',
        }),
      }),
      expect.objectContaining({
        blockId: 'audiences.public',
        state: 'unknown-block',
        reason: 'removed',
      }),
    ]);
  });
});

describe('marking the project labels’ translation current (#731)', () => {
  function marking(from: FakeContent) {
    const snapshot = new FakeSnapshot(from);
    const repo = new FakeRepository(snapshot);
    repo.branches.set('change-sets/cs-1', snapshot);
    const open = new OpenSnapshotAction(repo, new FakeAuthoredBranches());
    const audit = new FakeAuditLog();
    const unit = new FakeUnitOfWork();
    const saved: { subject: unknown; content: unknown }[] = [];
    const locked: unknown[] = [];
    const copies = new Set<string>();
    const mark = new MarkTranslationCurrentAction(
      {
        handle: vi.fn(async () => ({
          id: 'cs-1',
          branch: 'change-sets/cs-1',
        })),
      } as never,
      open,
      {
        handle: vi.fn(async (input: { subject: unknown }) => {
          locked.push(input.subject);
        }),
      } as never,
      {
        handle: vi.fn(
          async (input: {
            after: (tx: never, m: { commit: string }) => Promise<void>;
          }) => {
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
      { handle: vi.fn(async () => undefined) } as never,
    );
    return { mark, saved, locked, audit, copies };
  }

  const german = ProjectConfig.parse({
    ...config,
    moduleTypes: [{ id: 'concept', label: { en: 'Concept', de: 'Konzept' } }],
    translations: {
      de: {
        sourceCommit: 'a'.repeat(40),
        blocks: { 'moduleTypes.concept': 'e'.repeat(64) },
      },
    },
  });

  it('takes the current source’s hash for each label with a version of its own, the labels unchanged', async () => {
    const m = marking(contentWith(german));
    const done = await m.mark.handle({
      actor: manager(),
      changeSetId: 'cs-1',
      config: true,
      lang: 'de',
    });
    expect(done).toMatchObject({
      moduleId: 'config.project',
      config: true,
      blocks: 1,
      commit: 'd'.repeat(40),
    });
    expect(m.locked).toEqual([{ type: 'config' }]);
    const content = StrictProjectConfig.parse(m.saved[0]?.content);
    expect(content.moduleTypes).toEqual(german.moduleTypes);
    expect(content.audiences).toEqual(german.audiences);
    expect(Object.keys(content.translations?.['de']?.blocks ?? {})).toEqual([
      'moduleTypes.concept',
    ]);
    expect(
      content.translations?.['de']?.blocks['moduleTypes.concept'],
    ).not.toBe('e'.repeat(64));
    expect(m.audit.events[0]).toMatchObject({
      action: 'translation.mark-current',
      subject: { type: 'config', id: 'ccms.yaml' },
      data: { lang: 'de' },
    });
  });

  it('refuses labels without a version in the language, a working copy of the configuration, and one who may not change it', async () => {
    const m = marking(contentWith(german));
    await expect(
      m.mark.handle({
        actor: manager(),
        changeSetId: 'cs-1',
        config: true,
        lang: 'fr',
      }),
    ).rejects.toMatchObject({ code: 'translation-missing' });
    for (const actor of [translator(), manager({ maxAudience: 'public' })]) {
      await expect(
        m.mark.handle({ actor, changeSetId: 'cs-1', config: true, lang: 'de' }),
      ).rejects.toMatchObject({ code: 'forbidden' });
    }
    m.copies.add('config');
    await expect(
      m.mark.handle({
        actor: manager(),
        changeSetId: 'cs-1',
        config: true,
        lang: 'de',
      }),
    ).rejects.toMatchObject({ code: 'uncommitted-working-copies' });
    await expect(
      m.mark.handle({
        actor: manager(),
        changeSetId: 'cs-1',
        config: true,
        moduleId: 'guide',
        lang: 'de',
      }),
    ).rejects.toMatchObject({ code: 'invalid-parameter' });
    expect(m.saved).toEqual([]);
  });
});
