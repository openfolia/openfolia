import {
  ProjectConfig,
  translationRecordOf,
  type Block,
  type Module,
} from '@openfolia/content-model';
import { actorWith } from '../../../../tests/fakes/actors.js';
import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import { FakeAuthoredBranches } from '../../../../tests/fakes/fake-authored-branches.js';
import {
  config as baseConfig,
  FakeSnapshot,
  manifest,
  module,
  type FakeContent,
} from '../../../../tests/fakes/fake-content.js';
import { FakeRepository } from '../../../../tests/fakes/fake-repository.js';
import { FakeTranslationExchange } from '../../../../tests/fakes/fake-translation-exchange.js';
import { FakeTranslationJobs } from '../../../../tests/fakes/fake-translation-jobs.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import type { Actor, Scope } from '../../../access/core/actor.js';
import type { Permission } from '../../../access/core/permissions.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableProblems,
} from '../../../base/core/errors.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import type { ExportSubject } from '../translation-job.js';
import { CancelTranslationJobAction } from './cancel-translation-job.action.js';
import {
  ExportTranslationsAction,
  type ExportTranslationsInput,
} from './export-translations.action.js';
import {
  GetTranslationJobAction,
  ListTranslationJobsAction,
} from './read-translation-jobs.action.js';
import { TranslationJobFileAction } from './translation-job-file.action.js';
import { TranslationJobPackageAction } from './translation-job-package.action.js';

const config = ProjectConfig.parse({
  ...baseConfig,
  languages: { source: 'en', targets: ['de', 'fr'] },
  audiences: [
    { id: 'public', label: 'Public' },
    { id: 'internal', label: 'Internal' },
  ],
});

const COMMIT = 'e'.repeat(40);
/** Manages translations and may change the configuration, so the project labels go too (#731). */
const manager = (scope: Scope = {}): Actor => ({
  ...actorWith(
    ['content.read', 'content.edit', 'translation.manage', 'admin.roles'],
    scope,
  ),
  id: 'sample-manager',
});
/** Another translation manager than the exporter. */
const colleague = (scope: Scope = {}): Actor => ({
  ...manager(scope),
  id: 'other-manager',
});
const as = (permissions: Permission[], scope: Scope = {}) =>
  actorWith(permissions, scope);

const para = (id: string, text: string): Block => ({
  type: 'paragraph',
  id,
  content: [{ type: 'text', text }],
});
const doc = (
  id: string,
  texts: string[],
  lang = 'en',
  meta: Partial<Module['meta']> = {},
): Module => {
  const base = module(id, lang);
  return {
    ...base,
    meta: { ...base.meta, title: `Title of ${id}`, ...meta },
    blocks: texts.map((text, i) => para(`b${i + 1}`, text)),
  };
};

/**
 * `guide` was translated into German from its old text; two of its three
 * paragraphs changed since. `snippet` (no translation) is reached from
 * `guide` and `other` through module references; `secret` is internal.
 */
const old = doc('guide', ['One.', 'Two.', 'Three.']);
const guide: Module = {
  ...doc('guide', ['One, edited.', 'Two, edited.', 'Three.']),
};
guide.blocks.push({ type: 'moduleRef', id: 'ref', module: 'snippet' });
const other: Module = {
  ...doc('other', []),
  blocks: [{ type: 'moduleRef', id: 'ref', module: 'snippet' }],
};
const snippet = doc('snippet', ['Reused words here.']);
const secret = doc('secret', ['Hush.'], 'en', { audience: 'internal' });

const content: FakeContent = {
  config,
  modules: [
    guide,
    doc('guide', ['Eins.', 'Zwei.', 'Drei.'], 'de'),
    other,
    snippet,
    secret,
  ],
  manifests: [manifest('op', ['guide', 'other'])],
  translationRecords: { 'de/guide': translationRecordOf(old, COMMIT) },
};

function setUp(from: FakeContent = content, { released = true } = {}) {
  const snapshot = new FakeSnapshot(from);
  const repo = new FakeRepository(snapshot, { released });
  const open = new OpenSnapshotAction(repo, new FakeAuthoredBranches());
  const jobs = new FakeTranslationJobs();
  const audit = new FakeAuditLog();
  const unit = new FakeUnitOfWork();
  const exporter = new ExportTranslationsAction(open, repo, jobs, audit, unit);
  const run = (over: Partial<ExportTranslationsInput> = {}) =>
    exporter.handle({
      actor: manager(),
      languages: ['de'],
      subject: { type: 'manual', manualId: 'op' },
      ref: 'main',
      dueDate: null,
      dryRun: false,
      ...over,
    });
  const exchange = new FakeTranslationExchange();
  const file = new TranslationJobFileAction(jobs, open);
  return {
    snapshot,
    repo,
    jobs,
    audit,
    run,
    exchange,
    pack: new TranslationJobPackageAction(jobs, file, exchange),
    list: new ListTranslationJobsAction(jobs),
    get: new GetTranslationJobAction(jobs),
    file,
    cancel: new CancelTranslationJobAction(jobs, audit, unit),
  };
}

/** The modules' units sent; `own` the manual's own text's and the project labels' too (#731). */
const sent = (jobs: FakeTranslationJobs, own = false) =>
  [...jobs.jobs.values()].flatMap(({ units }) =>
    units
      .filter((u) => own || !u.moduleId.includes('.'))
      .map((u) => `${u.lang}/${u.moduleId}#${u.blockId}`),
  );
/** A manual's export also sends the project labels (6 units) and the manual's title (#731). */
const OWN = 7;

describe('ExportTranslationsAction', () => {
  it('sends exactly the changed blocks per language, a module reached twice once', async () => {
    const { run, jobs, audit, snapshot } = setUp();
    const job = await run({ languages: ['fr', 'de'] });
    // In the configured order of languages.
    expect(job.languages).toEqual(['de', 'fr']);
    expect(job).toMatchObject({
      state: 'sent',
      ref: 'main',
      commit: snapshot.commit,
      released: true,
      createdBy: { kind: 'user', id: 'sample-manager' },
    });
    expect(sent(jobs)).toEqual([
      // German: the two edited paragraphs, and the snippet (no translation).
      'de/guide#b1',
      'de/guide#b2',
      'de/snippet#b1',
      // French: everything, the snippet once.
      'fr/guide#b1',
      'fr/guide#b2',
      'fr/guide#b3',
      'fr/snippet#b1',
    ]);
    expect(
      sent(jobs, true).filter((u) => u.startsWith('de/') && u.includes('.')),
    ).toEqual([
      'de/config.project#moduleTypes.concept',
      'de/config.project#audiences.public',
      'de/config.project#audiences.internal',
      'de/config.project#variantAttributes.model',
      'de/config.project#variantAttributes.model.small',
      'de/config.project#variantAttributes.model.large',
      'de/manual.op#title',
    ]);
    expect(job.counts).toMatchObject({ modules: 4, units: 7 + 2 * OWN });
    expect(job.perLanguage).toMatchObject([
      { lang: 'de', modules: 4, units: 3 + OWN },
      { lang: 'fr', modules: 4, units: 4 + OWN },
    ]);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      action: 'translation-job.export',
      subject: { type: 'translation-job', id: job.id },
      data: {
        languages: ['de', 'fr'],
        subject: { type: 'manual', manualId: 'op' },
        units: 7 + 2 * OWN,
      },
    });
  });

  it('writes nothing on a dry run', async () => {
    const { run, jobs, audit } = setUp();
    const job = await run({ dryRun: true });
    expect(job.counts.units).toBe(3 + OWN);
    expect(jobs.jobs.size).toBe(0);
    expect(audit.events).toEqual([]);
  });

  it('leaves out what is at a provider, and says when nothing is left', async () => {
    const { run } = setUp();
    await run();
    await expect(run()).rejects.toMatchObject({
      code: 'nothing-to-translate',
    });
    // French was not sent yet.
    expect((await run({ languages: ['fr'] })).counts.units).toBe(4 + OWN);
  });

  it('takes a list of modules or a folder', async () => {
    const { run, jobs } = setUp();
    await run({
      subject: { type: 'modules', moduleIds: ['snippet', 'nope', 'secret'] },
    });
    expect(sent(jobs)).toEqual(['de/snippet#b1', 'de/secret#b1']);
    const folder: ExportSubject = { type: 'folder', folder: 'concept' };
    expect((await run({ subject: folder, dryRun: true })).counts).toEqual({
      modules: 1,
      units: 2,
      words: 4,
    });
  });

  it('needs translation.manage, and every language within its scope, before reading a module', async () => {
    const { run, snapshot } = setUp();
    await expect(
      run({ actor: as(['content.read', 'content.read.draft']) }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const reads = vi.spyOn(snapshot, 'module');
    const refused = run({
      actor: manager({ languages: ['en', 'de'] }),
      languages: ['de', 'fr', 'xx'],
    });
    await expect(refused).rejects.toBeInstanceOf(UnprocessableProblems);
    await expect(refused).rejects.toMatchObject({
      code: 'invalid-parameter',
      problems: [
        { pointer: '/data/attributes/languages/1' },
        { pointer: '/data/attributes/languages/2' },
      ],
    });
    expect(reads).not.toHaveBeenCalled();
  });

  it('sends only modules within the exporter’s scope, in every dimension', async () => {
    const { run, jobs } = setUp();
    await run({
      actor: manager({ maxAudience: 'public' }),
      subject: { type: 'modules', moduleIds: ['secret', 'snippet'] },
    });
    expect(sent(jobs)).toEqual(['de/snippet#b1']);
    // Reading it all, but managing only public translations.
    const { run: again, jobs: theirs } = setUp();
    await again({
      actor: {
        ...actorWith(['content.read'], {}),
        roles: [
          { id: 'r', name: 'R', permissions: ['content.read'], scope: {} },
          {
            id: 't',
            name: 'T',
            permissions: ['translation.manage'],
            scope: { maxAudience: 'public' },
          },
        ],
      },
      subject: { type: 'modules', moduleIds: ['secret', 'snippet'] },
    });
    expect(sent(theirs)).toEqual(['de/snippet#b1']);
  });

  it('is a conflict when another export took a unit meanwhile', async () => {
    const { run, jobs, audit } = setUp();
    vi.spyOn(jobs, 'create').mockResolvedValueOnce(false);
    await expect(run()).rejects.toBeInstanceOf(ConflictError);
    await expect(run({ dryRun: true })).resolves.toBeDefined();
    expect(audit.events).toEqual([]);
  });

  it('refuses an export of too many units', async () => {
    const big = doc(
      'big',
      Array.from({ length: 10_001 }, (_, i) => `Text ${i}.`),
    );
    const { run } = setUp({ ...content, modules: [big] });
    await expect(
      run({
        languages: ['de', 'fr'],
        subject: { type: 'modules', moduleIds: ['big'] },
      }),
    ).rejects.toMatchObject({ code: 'too-many-units' });
  });
});

describe('translation jobs', () => {
  it('lists and reads only the jobs whose every language one manages', async () => {
    const { run, list, get } = setUp();
    const both = await run({ languages: ['de', 'fr'], dryRun: false });
    const page = { number: 1, size: 50 };
    expect((await list.handle({ actor: manager(), page })).total).toBe(1);
    const deOnly = colleague({ languages: ['de'] });
    expect((await list.handle({ actor: deOnly, page })).total).toBe(0);
    await expect(
      get.handle({ actor: deOnly, id: both.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect((await get.handle({ actor: manager(), id: both.id })).id).toBe(
      both.id,
    );
    await expect(
      list.handle({ actor: as(['content.read']), page }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('shows another’s job only to readers of everything in its languages, a draft’s only with content.read.draft', async () => {
    const { run, list, get } = setUp();
    const job = await run({
      subject: { type: 'modules', moduleIds: ['secret', 'snippet'] },
    });
    const page = { number: 1, size: 50 };
    const sees = async (actor: Actor) => {
      const listed = (await list.handle({ actor, page })).items.map(
        (j) => j.id,
      );
      const read = await get
        .handle({ actor, id: job.id })
        .then(() => true)
        .catch((error: unknown) => {
          expect(error).toBeInstanceOf(NotFoundError);
          return false;
        });
      expect(listed.includes(job.id)).toBe(read);
      return read;
    };
    expect(await sees(colleague())).toBe(true);
    expect(await sees(colleague({ languages: ['en', 'de'] }))).toBe(true);
    // Its subject names `secret`: not for a reader of public modules only,
    // nor for one who manages everything but reads only public content.
    expect(await sees(colleague({ maxAudience: 'public' }))).toBe(false);
    expect(
      await sees({
        kind: 'user',
        id: 'split-roles',
        roles: [
          {
            id: 'r',
            name: 'Reader',
            permissions: ['content.read'],
            scope: { maxAudience: 'public' },
          },
          {
            id: 't',
            name: 'Manager',
            permissions: ['translation.manage'],
            scope: {},
          },
        ],
      }),
    ).toBe(false);
    // Nor for one who does not read the source language.
    expect(await sees(colleague({ languages: ['de'] }))).toBe(false);
    // The exporter sees their own, whatever their scope now.
    expect(await sees(manager({ maxAudience: 'public' }))).toBe(true);
  });

  it('shows a job of a draft only to readers of drafts, its ref and commit included', async () => {
    const drafts = setUp(content, { released: false });
    const drafter = (id: string, draft = true): Actor => ({
      ...actorWith(
        draft
          ? ['content.read', 'content.read.draft', 'translation.manage']
          : ['content.read', 'translation.manage'],
      ),
      id,
    });
    const job = await drafts.run({ actor: drafter('exporter'), ref: 'draft' });
    expect(job.released).toBe(false);
    const page = { number: 1, size: 50 };
    for (const actor of [drafter('exporter', false), drafter('other', false)]) {
      expect((await drafts.list.handle({ actor, page })).total).toBe(0);
      await expect(
        drafts.get.handle({ actor, id: job.id }),
      ).rejects.toBeInstanceOf(NotFoundError);
    }
    expect(
      (await drafts.get.handle({ actor: drafter('other'), id: job.id })).ref,
    ).toBe('draft');
  });

  it('shows another’s draft job only to readers of drafts in all of its languages', async () => {
    const drafts = setUp(content, { released: false });
    const exporter = {
      ...actorWith([
        'content.read',
        'content.read.draft',
        'translation.manage',
      ]),
      id: 'exporter',
    };
    const job = await drafts.run({ actor: exporter, ref: 'draft' });
    const reader = (draftScope: Scope): Actor => ({
      kind: 'user',
      id: 'reader',
      roles: [
        {
          id: 'm',
          name: 'M',
          permissions: ['content.read', 'translation.manage'],
          scope: {},
        },
        {
          id: 'd',
          name: 'D',
          permissions: ['content.read.draft'],
          scope: draftScope,
        },
      ],
    });
    const sees = (actor: Actor) =>
      drafts.get.handle({ actor, id: job.id }).then(
        () => true,
        () => false,
      );
    // Drafts of public modules only: the job could name internal ones.
    expect(await sees(reader({ maxAudience: 'public' }))).toBe(false);
    expect(await sees(reader({ languages: ['en'] }))).toBe(false);
    expect(await sees(reader({ languages: ['en', 'de'] }))).toBe(true);
    expect(await sees(reader({}))).toBe(true);
  });

  it('records a job as released only when its ref names released content', async () => {
    const { run, snapshot } = setUp();
    // A branch at `main`'s commit is still a draft's name.
    const branch = await run({ ref: 'some-branch', dryRun: true });
    expect(branch.commit).toBe(snapshot.commit);
    expect(branch.released).toBe(false);
    expect((await run({ ref: snapshot.commit, dryRun: true })).released).toBe(
      true,
    );
  });

  it('cancels a sent job once, freeing its units', async () => {
    const { run, cancel, audit, jobs } = setUp();
    const job = await run();
    const cancelled = await cancel.handle({ actor: manager(), id: job.id });
    expect(cancelled.state).toBe('cancelled');
    expect(await jobs.unitsAtProvider({})).toEqual([]);
    expect(audit.events.map((e) => e.action)).toEqual([
      'translation-job.export',
      'translation-job.cancel',
    ]);
    await expect(
      cancel.handle({ actor: manager(), id: job.id }),
    ).rejects.toMatchObject({ code: 'job-not-open' });
    // Sent again by the next export.
    expect((await run()).counts.units).toBe(3 + OWN);
    await expect(
      cancel.handle({ actor: colleague({ languages: ['fr'] }), id: job.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('makes the XLIFF of each language from the job’s commit, as the reader may read it', async () => {
    const { run, file } = setUp();
    const job = await run({ languages: ['de', 'fr'] });
    const { files } = await file.handle({ actor: manager(), id: job.id });
    expect(files.map((f) => f.lang)).toEqual(['de', 'fr']);
    const de = files[0]?.xliff ?? '';
    expect(de).toContain('srcLang="en" trgLang="de"');
    // Each file names both sides' directions (#458).
    expect(de).toContain('srcDir="ltr" trgDir="ltr"');
    expect(de).toContain(`ccms:job="${job.id}"`);
    expect(
      [...de.matchAll(/<unit id="([^"]+)"/g)].map((m) => m[1]).slice(OWN),
    ).toEqual(['b1', 'b2', 'b1']);
    expect([...de.matchAll(/<file id="([^"]+)"/g)].map((m) => m[1])).toEqual([
      'config.project',
      'manual.op',
      'guide',
      'snippet',
    ]);
    const one = await file.handle({ actor: manager(), id: job.id, lang: 'fr' });
    expect(one.files.map((f) => f.lang)).toEqual(['fr']);
    await expect(
      file.handle({ actor: manager(), id: job.id, lang: 'es' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('leaves out of a file what the reader may not read now', async () => {
    const { run, file } = setUp();
    const job = await run({
      subject: { type: 'modules', moduleIds: ['secret', 'snippet'] },
    });
    const { files } = await file.handle({
      actor: manager({ maxAudience: 'public' }),
      id: job.id,
    });
    expect(files[0]?.xliff).toContain('<file id="snippet"');
    expect(files[0]?.xliff).not.toContain('secret');
    const onlySecret = await run({
      subject: { type: 'modules', moduleIds: ['secret'] },
      languages: ['fr'],
    });
    await expect(
      file.handle({
        actor: manager({ maxAudience: 'public' }),
        id: onlySecret.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('reads a job’s commit as released once main moved on, a draft’s only with content.read.draft', async () => {
    const { run, file, repo } = setUp();
    const job = await run();
    expect(job.released).toBe(true);
    // `main` moves on: the job's commit is no longer released.
    (repo as unknown as { main: FakeSnapshot }).main = new FakeSnapshot(
      content,
    );
    expect(
      (await file.handle({ actor: manager(), id: job.id })).files,
    ).toHaveLength(1);

    const drafts = setUp(content, { released: false });
    const drafter = actorWith([
      'content.read',
      'content.read.draft',
      'translation.manage',
    ]);
    const draft = await drafts.run({ actor: drafter, ref: 'draft' });
    expect(draft.released).toBe(false);
    await expect(
      drafts.file.handle({ actor: manager(), id: draft.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(
      (await drafts.file.handle({ actor: drafter, id: draft.id })).files,
    ).toHaveLength(1);
  });
});

describe('TranslationJobPackageAction (#140)', () => {
  it('wraps exactly the job’s files, every language’s, in the exchange’s package', async () => {
    const { run, file, pack, exchange } = setUp();
    const job = await run({ languages: ['de', 'fr'] });
    const before = Date.now();
    const made = await pack.handle({ actor: manager(), id: job.id });
    expect(made.job.id).toBe(job.id);
    expect(made.package).toMatchObject({
      fileName: `job-${job.id}.pkg`,
      mediaType: 'application/zip',
    });
    const [packed] = exchange.packed;
    expect(packed?.files).toEqual(
      (await file.handle({ actor: manager(), id: job.id })).files,
    );
    expect(packed?.at.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('holds only what the reader may read now, and is 404 where the file is', async () => {
    const { run, pack, exchange } = setUp();
    const job = await run({
      subject: { type: 'modules', moduleIds: ['secret', 'snippet'] },
    });
    await pack.handle({
      actor: manager({ maxAudience: 'public' }),
      id: job.id,
    });
    expect(exchange.packed[0]?.files[0]?.xliff).not.toContain('secret');
    await expect(
      pack.handle({ actor: manager(), id: 'no-such-job' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      pack.handle({ actor: as(['content.read']), id: job.id }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses a cancelled job: 409 job-not-open', async () => {
    const { run, pack, cancel, exchange } = setUp();
    const job = await run();
    await cancel.handle({ actor: manager(), id: job.id });
    await expect(
      pack.handle({ actor: manager(), id: job.id }),
    ).rejects.toMatchObject({ code: 'job-not-open' });
    await expect(
      pack.handle({ actor: manager(), id: job.id }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(exchange.packed).toEqual([]);
  });
});
