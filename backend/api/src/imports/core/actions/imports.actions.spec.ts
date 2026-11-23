import { FakeAssetReferenceStore } from '../../../../tests/fakes/fake-asset-reference-store.js';
import { AssetReferenceIndex } from '../../../assets/core/asset-reference-index.js';
import { strToU8, zipSync } from 'fflate';
import { actorWith } from '../../../../tests/fakes/actors.js';
import { FakeAssetUploads } from '../../../../tests/fakes/fake-asset-uploads.js';
import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import { FakeChangeSetStore } from '../../../../tests/fakes/fake-change-set-store.js';
import { FakeArchivedFiles } from '../../../../tests/fakes/fake-archived-files.js';
import { FakeHeldBlobs } from '../../../../tests/fakes/fake-held-blobs.js';
import { FakeRepository } from '../../../../tests/fakes/fake-repository.js';
import { FakeWorkingCopyStore } from '../../../../tests/fakes/fake-working-copy-store.js';
import { FakeBlobStore } from '../../../../tests/fakes/fake-blob-store.js';
import {
  config,
  FakeSnapshot,
  manifest,
  readable,
} from '../../../../tests/fakes/fake-content.js';
import { FakeImportStore } from '../../../../tests/fakes/fake-import-store.js';
import { FakeJobQueue } from '../../../../tests/fakes/fake-job-queue.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import { FakeUserDirectory } from '../../../../tests/fakes/fake-user-directory.js';
import type { Actor } from '../../../access/core/actor.js';
import { AssetReferences } from '../../../assets/core/asset-references.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnavailableError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import { workingCopySubject } from '../../../change-sets/core/working-copy-rules.js';
import { BundleImporter } from '../bundle-importer.js';
import {
  IMPORT_TTL_MS,
  type ImportRecord,
  type ImportReport,
  type ImportSettings,
  newImportId,
  NO_PROGRESS,
} from '../import.js';
import type { ImportPipeline } from '../import-pipeline.js';
import type { ImportPlan, PlannedWrite } from '../import-plan.js';
import { ImportUploads } from '../import-uploads.js';
import { ImporterRegistry } from '../importer.js';
import { ApplyImportAction } from './apply-import.action.js';
import {
  CreateImportAction,
  type ImportForm,
  MAX_CONCURRENT_IMPORTS,
} from './create-import.action.js';
import { GetImportAction } from './get-import.action.js';
import { ListImportersAction } from './list-importers.action.js';
import {
  FailImportAction,
  isPermanent,
  leftOutText,
  RunImportAction,
} from './run-import.action.js';
import { SweepImportsAction } from './sweep-imports.action.js';

const importer: Actor = {
  ...actorWith(['admin.roles', 'content.edit', 'content.read']),
  id: 'sample-importer',
};
const adminOnly = actorWith(['admin.roles', 'content.read']);

const settings: ImportSettings = {
  maxBytes: 1024 * 1024,
  maxFiles: 100,
  maxUnpackedBytes: 1024 * 1024,
  maxPathDepth: 4,
  maxJsonDepth: 64,
  maxDocumentBytes: 1024 * 1024,
  commitFiles: 2,
  commitBytes: 1024 * 1024,
  maxImageBytes: 1024 * 1024,
  maxAttachmentBytes: 1024 * 1024,
  attachmentTypes: { allow: [], deny: [], open: [] } as never,
};

const COUNTS = {
  modules: 0,
  manuals: 0,
  assets: 0,
  create: 0,
  update: 0,
  skip: 0,
  refuse: 0,
  passthrough: 0,
  errors: 0,
  warnings: 0,
  converterReport: 0,
};
const report = (over: Partial<ImportReport> = {}): ImportReport => ({
  valid: true,
  applicable: true,
  applicableWithoutRefused: true,
  issues: [],
  items: [
    {
      kind: 'module',
      id: 'a',
      lang: 'en',
      pointer: '/modules/0',
      action: 'create',
      reasons: [],
      issues: [],
      issueCount: 0,
    },
  ],
  converterReport: [],
  counts: { ...COUNTS, modules: 1, create: 1 },
  ...over,
});

/** A report refusing one module and creating another: its rest stands without it (#758). */
const withRefused = (over: Partial<ImportReport> = {}): ImportReport =>
  report({
    valid: false,
    applicable: false,
    applicableWithoutRefused: true,
    items: [
      ...report().items,
      {
        kind: 'module',
        id: 'broken',
        lang: 'en',
        pointer: '/modules/1',
        action: 'refuse',
        reasons: [
          {
            severity: 'error',
            code: 'unknown-module-type',
            message: 'module type "nope" is not configured',
          },
        ],
        issues: [],
        issueCount: 1,
      },
    ],
    counts: { ...COUNTS, modules: 2, create: 1, refuse: 1, errors: 1 },
    ...over,
  });

const ZIP = zipSync({ 'import.json': strToU8('{}') });
const BASE_COMMIT = 'c'.repeat(40);

function setup() {
  const store = new FakeImportStore();
  const blobs = new FakeBlobStore();
  const assets = new FakeAssetUploads();
  const unit = new FakeUnitOfWork();
  const jobs = new FakeJobQueue();
  const audit = new FakeAuditLog();
  const workingCopies = new FakeWorkingCopyStore();
  const repository = new FakeRepository(new FakeSnapshot({ modules: [] }));
  const references = new AssetReferences(
    repository,
    new FakeChangeSetStore(),
    workingCopies,
    assets,
    new FakeHeldBlobs(),
    new AssetReferenceIndex(repository, new FakeAssetReferenceStore()),
  );
  // What holds bytes, read under the hash's lock (#602): apart from the
  // imports, and from what `references` read (so taken on after its look).
  const archived = new FakeArchivedFiles();
  const held = new FakeHeldBlobs();
  const uploads = new ImportUploads(
    blobs,
    assets,
    store,
    unit,
    settings,
    references,
    archived,
    held,
  );
  const registry = new ImporterRegistry([new BundleImporter()]);
  let checked: ImportPlan = { report: report(), writes: [], uploads: [] };
  const pipeline = {
    check: vi.fn(async () => ({
      plan: checked,
      baseRef: 'main',
      baseCommit: BASE_COMMIT,
    })),
    replay: vi.fn(async () => ({
      writes: checked.writes,
      uploads: checked.uploads,
    })),
  };
  const create = new CreateImportAction(
    registry,
    pipeline as unknown as ImportPipeline,
    uploads,
    unit,
  );
  const form =
    (over: Partial<ImportForm> = {}) =>
    async (): Promise<ImportForm> => ({
      file: { bytes: ZIP, fileName: 'bundle.zip' },
      updateExisting: false,
      dryRun: false,
      ...over,
    });
  return {
    store,
    blobs,
    assets,
    unit,
    jobs,
    audit,
    uploads,
    references,
    workingCopies,
    archived,
    held,
    registry,
    pipeline,
    plan: (next: ImportPlan) => {
      checked = next;
    },
    create,
    form,
    apply: new ApplyImportAction(store, jobs, unit),
    get: new GetImportAction(store),
    sweep: new SweepImportsAction(store, uploads),
  };
}

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).name;
  }
  throw new Error('it succeeded');
};

describe('ListImportersAction', () => {
  it('lists the installed importers, paged; admin.roles only', async () => {
    const list = new ListImportersAction(
      new ImporterRegistry([new BundleImporter()]),
    );
    const page = await list.handle({
      actor: importer,
      page: { number: 1, size: 10 },
    });
    expect(page.items.map((i) => i.id)).toEqual(['bundle']);
    expect(page.total).toBe(1);
    await expect(
      list.handle({
        actor: actorWith(['content.edit']),
        page: { number: 1, size: 10 },
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('CreateImportAction', () => {
  it('answers a dry run and stores nothing', async () => {
    const t = setup();
    const view = await t.create.handle({
      actor: importer,
      form: t.form({ dryRun: true }),
    });
    expect(view).toMatchObject({
      dryRun: true,
      state: 'dry-run',
      importerId: 'bundle',
      baseRef: 'main',
      baseCommit: BASE_COMMIT,
      fileName: 'bundle.zip',
      upload: { size: ZIP.byteLength },
    });
    expect(t.blobs.blobs.size).toBe(0);
    expect(t.store.rows.size).toBe(0);
  });

  it('stores the upload and the report for an hour', async () => {
    const t = setup();
    const view = await t.create.handle({ actor: importer, form: t.form() });
    expect(view).toMatchObject({ dryRun: false, state: 'validated' });
    const row = t.store.rows.get(view.id);
    expect(row?.upload).toMatchObject({ size: ZIP.byteLength, created: true });
    expect(row && row.expiresAt.getTime() - row.createdAt.getTime()).toBe(
      IMPORT_TTL_MS,
    );
    expect(t.blobs.blobs.has(row?.upload.sha256 ?? '')).toBe(true);
    expect(row?.createdBy).toEqual({ kind: 'user', id: importer.id });
  });

  it('removes the stored bytes when recording the import fails', async () => {
    const t = setup();
    vi.spyOn(t.store, 'insert').mockRejectedValueOnce(new Error('db down'));
    await expect(
      t.create.handle({ actor: importer, form: t.form() }),
    ).rejects.toThrow('db down');
    expect(t.blobs.blobs.size).toBe(0);
  });

  it('needs admin.roles, and content.edit too, before the form is read', async () => {
    const t = setup();
    const form = vi.fn(t.form());
    await expect(
      t.create.handle({ actor: actorWith(['content.edit']), form }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      t.create.handle({ actor: adminOnly, form }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(form).not.toHaveBeenCalled();
  });

  it('refuses an unknown importer and options its schema does not take', async () => {
    const t = setup();
    expect(
      await codeOf(
        t.create.handle({
          actor: importer,
          form: t.form({ importerId: 'other' }),
        }),
      ),
    ).toBe('unknown-importer');
    expect(
      await codeOf(
        t.create.handle({
          actor: importer,
          form: t.form({ options: { unexpected: true } }),
        }),
      ),
    ).toBe('invalid-options');
  });

  it('checks at most a few imports at once: 503 import-busy', async () => {
    const t = setup();
    const gates: (() => void)[] = [];
    const slow = () =>
      new Promise<ImportForm>((resolve) =>
        gates.push(() => void t.form()().then(resolve)),
      );
    const running = Array.from({ length: MAX_CONCURRENT_IMPORTS }, () =>
      t.create.handle({ actor: importer, form: slow }),
    );
    await Promise.resolve();
    const busy = t.create.handle({ actor: importer, form: t.form() });
    await expect(busy).rejects.toBeInstanceOf(UnavailableError);
    expect(await codeOf(busy)).toBe('import-busy');
    for (const open of gates) open();
    await Promise.all(running);
    // Free again.
    await t.create.handle({ actor: importer, form: t.form({ dryRun: true }) });
  });
});

async function stored(
  t: ReturnType<typeof setup>,
  over: Partial<ImportRecord> = {},
) {
  const view = await t.create.handle({ actor: importer, form: t.form() });
  const row = t.store.rows.get(view.id);
  if (!row) throw new Error('not stored');
  const next = { ...row, ...over };
  t.store.rows.set(view.id, next);
  return next;
}

describe('GetImportAction', () => {
  it('shows an import to its uploader only', async () => {
    const t = setup();
    const record = await stored(t);
    await expect(
      t.get.handle({ actor: importer, id: record.id }),
    ).resolves.toMatchObject({ id: record.id });
    const other = { ...importer, id: 'someone-else' };
    await expect(
      t.get.handle({ actor: other, id: record.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      t.get.handle({ actor: importer, id: 'not-a-uuid' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('ApplyImportAction', () => {
  it('starts applying and queues its job in the same transaction', async () => {
    const t = setup();
    const record = await stored(t);
    const applying = await t.apply.handle({ actor: importer, id: record.id });
    expect(applying.state).toBe('applying');
    expect(t.store.rows.get(record.id)?.state).toBe('applying');
    expect(t.jobs.jobs.map((j) => [j.queue, j.key, j.payload])).toEqual([
      ['import.apply', record.id, { importId: record.id }],
    ]);
    expect(
      await codeOf(t.apply.handle({ actor: importer, id: record.id })),
    ).toBe('invalid-state');
  });

  it('refuses someone else’s, an expired and an inapplicable import', async () => {
    const t = setup();
    const record = await stored(t);
    await expect(
      t.apply.handle({ actor: { ...importer, id: 'other' }, id: record.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const expired = await stored(t, { expiresAt: new Date(Date.now() - 1) });
    expect(
      await codeOf(t.apply.handle({ actor: importer, id: expired.id })),
    ).toBe('import-expired');
    const refused = await stored(t, {
      report: report({ applicable: false, applicableWithoutRefused: false }),
    });
    await expect(
      t.apply.handle({ actor: importer, id: refused.id }),
    ).rejects.toBeInstanceOf(UnprocessableError);
    await expect(
      t.apply.handle({ actor: importer, id: refused.id, skipRefused: true }),
    ).rejects.toMatchObject({
      code: 'import-not-applicable',
      meta: { skipRefused: false },
    });
    await expect(
      t.apply.handle({ actor: adminOnly, id: record.id }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(t.jobs.jobs).toEqual([]);
  });
});

describe('ApplyImportAction with skipRefused (#758)', () => {
  it('refuses an import with a refused item without the flag, as before', async () => {
    const t = setup();
    const record = await stored(t, { report: withRefused() });
    await expect(
      t.apply.handle({ actor: importer, id: record.id }),
    ).rejects.toMatchObject({
      code: 'import-not-applicable',
      meta: { skipRefused: true },
    });
    await expect(
      t.apply.handle({ actor: importer, id: record.id, skipRefused: false }),
    ).rejects.toBeInstanceOf(UnprocessableError);
    expect(t.store.rows.get(record.id)?.state).toBe('validated');
    expect(t.jobs.jobs).toEqual([]);
  });

  it('applies the rest with the flag when it stands without the refused items', async () => {
    const t = setup();
    const record = await stored(t, { report: withRefused() });
    const applying = await t.apply.handle({
      actor: importer,
      id: record.id,
      skipRefused: true,
    });
    expect(applying.state).toBe('applying');
    expect(t.jobs.jobs.map((j) => j.payload)).toEqual([
      { importId: record.id },
    ]);
  });

  it('refuses with the flag when the rest does not stand alone', async () => {
    const t = setup();
    const record = await stored(t, {
      report: withRefused({ applicableWithoutRefused: false }),
    });
    expect(
      await codeOf(
        t.apply.handle({ actor: importer, id: record.id, skipRefused: true }),
      ),
    ).toBe('import-not-applicable');
    expect(t.jobs.jobs).toEqual([]);
  });

  it('applies an applicable import with the flag as without it, and keeps expiry and state', async () => {
    const t = setup();
    const record = await stored(t);
    await expect(
      t.apply.handle({ actor: importer, id: record.id, skipRefused: true }),
    ).resolves.toMatchObject({ state: 'applying' });
    expect(
      await codeOf(
        t.apply.handle({ actor: importer, id: record.id, skipRefused: true }),
      ),
    ).toBe('invalid-state');
    const expired = await stored(t, {
      report: withRefused(),
      expiresAt: new Date(Date.now() - 1),
    });
    expect(
      await codeOf(
        t.apply.handle({ actor: importer, id: expired.id, skipRefused: true }),
      ),
    ).toBe('import-expired');
  });
});

describe('SweepImportsAction', () => {
  it('removes expired imports and the bytes only they stored', async () => {
    const t = setup();
    const record = await stored(t);
    const later = new Date(Date.now() + 2 * IMPORT_TTL_MS);
    expect(await t.sweep.handle({ now: new Date() })).toEqual({
      removed: [],
      failed: [],
    });
    expect(await t.sweep.handle({ now: later })).toEqual({
      removed: [record.id],
      failed: [],
    });
    expect(t.store.rows.size).toBe(0);
    expect(t.blobs.blobs.size).toBe(0);
  });

  it('keeps bytes another import names (handing the duty over), and an applying import', async () => {
    const t = setup();
    const first = await stored(t);
    const second = await stored(t);
    expect(second.upload.created).toBe(false);
    await stored(t, { state: 'applying' });
    t.store.rows.set(second.id, {
      ...second,
      expiresAt: new Date(Date.now() + 4 * IMPORT_TTL_MS),
    });
    const later = new Date(Date.now() + 2 * IMPORT_TTL_MS);
    const { removed } = await t.sweep.handle({ now: later });
    expect(removed).toEqual([first.id]);
    expect(t.blobs.blobs.size).toBe(1);
    expect(t.store.rows.get(second.id)?.upload.created).toBe(true);
  });

  it('keeps bytes content refers to, and marks them deleted only while it looks', async () => {
    const t = setup();
    const record = await stored(t);
    const hash = record.upload.sha256;
    // A working copy names the bytes as a file (by their hash).
    const places = vi
      .spyOn(t.references, 'placesOf')
      .mockImplementationOnce(async () => {
        // The mark is in while where they are used is read.
        expect(t.assets.deleted.has(hash)).toBe(true);
        return new Map([[hash, [{ in: 'working-copy' }]]]);
      });
    await t.sweep.handle({ now: new Date(Date.now() + 2 * IMPORT_TTL_MS) });
    expect(places).toHaveBeenCalledTimes(1);
    expect(t.store.rows.size).toBe(0);
    expect(t.blobs.blobs.has(hash)).toBe(true);
    expect(t.assets.deleted.size).toBe(0);
  });

  it('does not count the import itself as a use, and deletes its bytes', async () => {
    const t = setup();
    const record = await stored(t);
    const hash = record.upload.sha256;
    vi.spyOn(t.references, 'placesOf').mockResolvedValueOnce(
      new Map([[hash, [{ in: 'import' }]]]),
    );
    await t.sweep.handle({ now: new Date(Date.now() + 2 * IMPORT_TTL_MS) });
    expect(t.store.rows.size).toBe(0);
    expect(t.blobs.blobs.has(hash)).toBe(false);
    expect(t.assets.deleted.size).toBe(0);
  });

  it('leaves the import and its bytes, unmarked, when reading where they are used fails', async () => {
    const t = setup();
    const record = await stored(t);
    vi.spyOn(t.references, 'placesOf').mockRejectedValueOnce(
      new UnavailableError('too-many-change-sets', 'Too many.', 60),
    );
    const { failed } = await t.sweep.handle({
      now: new Date(Date.now() + 2 * IMPORT_TTL_MS),
    });
    expect(failed.map((f) => f.id)).toEqual([record.id]);
    expect(t.store.rows.has(record.id)).toBe(true);
    expect(t.blobs.blobs.has(record.upload.sha256)).toBe(true);
    expect(t.assets.deleted.size).toBe(0);
    // The next sweep removes both.
    await t.sweep.handle({ now: new Date(Date.now() + 2 * IMPORT_TTL_MS) });
    expect(t.store.rows.size).toBe(0);
    expect(t.blobs.blobs.size).toBe(0);
  });

  it('keeps a deletion mark it did not set', async () => {
    const t = setup();
    const record = await stored(t);
    const hash = record.upload.sha256;
    t.assets.deleted.add(hash);
    await t.sweep.handle({ now: new Date(Date.now() + 2 * IMPORT_TTL_MS) });
    expect(t.blobs.blobs.has(hash)).toBe(false);
    expect(t.assets.deleted.has(hash)).toBe(true);
  });

  it('leaves the import for the next sweep when another’s mark is cleared while it looks', async () => {
    const t = setup();
    const record = await stored(t);
    const hash = record.upload.sha256;
    t.assets.deleted.add(hash);
    vi.spyOn(t.references, 'placesOf').mockImplementationOnce(async () => {
      t.assets.deleted.delete(hash);
      return new Map();
    });
    const later = new Date(Date.now() + 2 * IMPORT_TTL_MS);
    await t.sweep.handle({ now: later });
    expect(t.store.rows.has(record.id)).toBe(true);
    expect(t.blobs.blobs.has(hash)).toBe(true);
    // The next sweep marks the bytes itself and removes both.
    await t.sweep.handle({ now: later });
    expect(t.store.rows.size).toBe(0);
    expect(t.blobs.blobs.has(hash)).toBe(false);
  });

  it('keeps bytes uploaded as a file while it looks, and clears its mark', async () => {
    const t = setup();
    const record = await stored(t);
    const recorded = vi.spyOn(t.assets, 'recorded');
    // Not recorded at the first look; an upload of them came in meanwhile.
    recorded.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await t.sweep.handle({ now: new Date(Date.now() + 2 * IMPORT_TTL_MS) });
    expect(t.store.rows.size).toBe(0);
    expect(t.blobs.blobs.has(record.upload.sha256)).toBe(true);
    expect(t.assets.deleted.size).toBe(0);
  });

  it('keeps bytes an asset upload records', async () => {
    const t = setup();
    const record = await stored(t);
    vi.spyOn(t.assets, 'recorded').mockResolvedValue(true);
    await t.sweep.handle({ now: new Date(Date.now() + 2 * IMPORT_TTL_MS) });
    expect(t.store.rows.size).toBe(0);
    expect(t.blobs.blobs.has(record.upload.sha256)).toBe(true);
  });
});

describe('ImportUploads, bytes something else took on (#602)', () => {
  it('keeps the bytes of a failed import that a done release output records, or the branding holds', async () => {
    for (const take of ['archived', 'branding'] as const) {
      const t = setup();
      vi.spyOn(t.store, 'insert').mockImplementationOnce(async () => {
        // Meanwhile a render of exactly these bytes recorded its output
        // `done`, or the branding took them on.
        const hash = [...t.blobs.blobs.keys()][0] ?? '';
        if (take === 'archived') t.archived.files.add(hash);
        else t.held.branding.add(hash);
        throw new Error('db down');
      });
      await expect(
        t.create.handle({ actor: importer, form: t.form() }),
      ).rejects.toThrow('db down');
      expect(t.blobs.blobs.size).toBe(1);
    }
  });

  it('keeps the bytes of an expired import that a done release output records, or the branding holds', async () => {
    for (const take of ['archived', 'branding'] as const) {
      const t = setup();
      const record = await stored(t);
      if (take === 'archived') t.archived.files.add(record.upload.sha256);
      else t.held.branding.add(record.upload.sha256);
      await t.sweep.handle({ now: new Date(Date.now() + 2 * IMPORT_TTL_MS) });
      expect(t.store.rows.size).toBe(0);
      expect(t.blobs.blobs.has(record.upload.sha256)).toBe(true);
    }
  });
});

describe('RunImportAction', () => {
  const subjectOf = (moduleId: string) =>
    workingCopySubject({ type: 'module', lang: 'en', moduleId });
  const writes = (...ids: string[]): PlannedWrite[] =>
    ids.map((id) => ({
      subject: subjectOf(id),
      content: { id } as never,
      bytes: 10,
    }));

  function runner(t: ReturnType<typeof setup>, users = [importer]) {
    const calls: string[] = [];
    let commit = 0;
    const action = (
      name: string,
      answer: (input: never) => unknown = () => ({}),
    ) => ({
      handle: vi.fn(async (input: never) => {
        const { subject } = input as { subject?: { moduleId?: string } };
        calls.push(subject?.moduleId ? `${name} ${subject.moduleId}` : name);
        return answer(input);
      }),
    });
    const deps = {
      createChangeSet: action('create', () => ({ id: newImportId() })),
      uploadAsset: action('upload'),
      acquireLock: action('lock'),
      saveWorkingCopy: action('save'),
      commitWorkingCopies: action('commit', () => ({
        commit: String(++commit).padStart(40, '0'),
      })),
      openSnapshot: {
        handle: vi.fn(async () => ({ config: async () => config })),
      },
    };
    const run = new RunImportAction(
      t.store,
      new FakeUserDirectory(users),
      t.blobs,
      t.registry,
      t.pipeline as unknown as ImportPipeline,
      settings,
      deps.createChangeSet as never,
      deps.uploadAsset as never,
      deps.acquireLock as never,
      deps.saveWorkingCopy as never,
      deps.commitWorkingCopies as never,
      deps.openSnapshot as never,
      t.audit,
      t.unit,
    );
    return { run, calls, deps };
  }

  it('writes through the change-set actions, in save points, and records one audit event', async () => {
    const t = setup();
    const plan = {
      report: report(),
      writes: writes('a', 'b', 'c'),
      uploads: [
        { sha256: 'f'.repeat(64), kind: 'image' as const, bytes: strToU8('x') },
      ],
    };
    t.plan(plan);
    const record = await stored(t, { state: 'applying' });
    const { run, calls } = runner(t);
    await run.handle({ importId: record.id });
    expect(calls).toEqual([
      'create',
      'upload',
      'lock a',
      'save a',
      'lock b',
      'save b',
      'commit',
      'lock c',
      'save c',
      'commit',
    ]);
    const done = t.store.rows.get(record.id);
    expect(done).toMatchObject({
      state: 'applied',
      failure: null,
      progress: {
        phase: 'done',
        assets: { done: 1, total: 1 },
        files: { done: 3, total: 3 },
      },
    });
    expect(done?.progress.commits).toHaveLength(2);
    expect(done?.changeSetId).not.toBeNull();
    expect(t.audit.events).toHaveLength(1);
    expect(t.audit.events[0]).toMatchObject({
      action: 'import.apply',
      subject: { type: 'import', id: record.id },
      data: { state: 'applied', commits: 2 },
    });
  });

  it('commits a save point the commit finds too large in halves', async () => {
    const t = setup();
    t.plan({ report: report(), writes: writes('a', 'b'), uploads: [] });
    const record = await stored(t, { state: 'applying' });
    const { run, calls, deps } = runner(t);
    deps.commitWorkingCopies.handle.mockImplementationOnce(async () => {
      calls.push('commit refused');
      throw new UnprocessableError('too-large', 'too large');
    });
    await run.handle({ importId: record.id });
    expect(calls).toEqual([
      'create',
      'lock a',
      'save a',
      'lock b',
      'save b',
      'commit refused',
      'commit',
      'commit',
    ]);
    expect(t.store.rows.get(record.id)).toMatchObject({
      state: 'applied',
      progress: { files: { done: 2, total: 2 } },
    });
    expect(t.store.rows.get(record.id)?.progress.commits).toHaveLength(2);
  });

  it('leaves exactly the refused items out, and says what and why in the description and the commits (#758)', async () => {
    const t = setup();
    t.plan({ report: withRefused(), writes: writes('a'), uploads: [] });
    const record = await stored(t, {
      state: 'applying',
      report: withRefused(),
    });
    const { run, calls, deps } = runner(t);
    await run.handle({ importId: record.id });
    expect(calls).toEqual(['create', 'lock a', 'save a', 'commit']);
    const description = (
      deps.createChangeSet.handle.mock.calls[0]?.[0] as unknown as {
        description: string;
      }
    ).description;
    const message = (
      deps.commitWorkingCopies.handle.mock.calls[0]?.[0] as unknown as {
        message: string;
      }
    ).message;
    const leftOut = [
      'Left out: 1 item the check refused.',
      '- module en/broken (unknown-module-type: module type "nope" is not configured)',
    ].join('\n');
    expect(description).toContain(leftOut);
    expect(message).toBe(`Import of bundle.zip\n\n${leftOut}`);
    expect(t.store.rows.get(record.id)?.state).toBe('applied');
    expect(t.audit.events[0]?.data).toMatchObject({
      state: 'applied',
      counts: { create: 1, refuse: 1 },
    });
  });

  it('fails an import applied without its refused items once the rest no longer stands', async () => {
    const t = setup();
    t.plan({
      report: withRefused({ applicableWithoutRefused: false }),
      writes: writes('a'),
      uploads: [],
    });
    const record = await stored(t, {
      state: 'applying',
      report: withRefused(),
    });
    const { run, calls } = runner(t);
    await run.handle({ importId: record.id });
    expect(calls).toEqual([]);
    expect(t.store.rows.get(record.id)).toMatchObject({
      state: 'failed',
      failure: { code: 'import-outdated' },
    });
  });

  it('fails an import whose check now refuses other items than the ones left out', async () => {
    const t = setup();
    const refusedNow = withRefused();
    t.plan({
      report: {
        ...refusedNow,
        items: refusedNow.items.map((item) => ({ ...item, action: 'refuse' })),
      },
      writes: [],
      uploads: [],
    });
    const record = await stored(t, {
      state: 'applying',
      report: withRefused(),
    });
    const { run, calls } = runner(t);
    await run.handle({ importId: record.id });
    expect(calls).toEqual([]);
    expect(t.store.rows.get(record.id)?.failure?.code).toBe('import-outdated');
  });

  it('names at most 25 left-out items, each on one line', () => {
    const many = withRefused().items[1];
    if (!many) throw new Error('no refused item');
    const text = leftOutText(
      report({
        items: Array.from({ length: 30 }, (_, i) => ({
          ...many,
          id: `m${i}`,
          reasons: [
            {
              severity: 'error' as const,
              code: 'invalid-schema',
              message: `line one\nline two ${'x'.repeat(400)}`,
            },
          ],
        })),
      }),
    );
    const lines = text?.split('\n') ?? [];
    expect(lines[0]).toBe('Left out: 30 items the check refused.');
    expect(lines).toHaveLength(1 + 25 + 1);
    expect(lines.at(-1)).toBe(
      "- and 5 more; the import's report lists them all.",
    );
    expect(lines[1]).toMatch(
      /^- module en\/m0 \(invalid-schema: line one line two x+…$/,
    );
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(300);
    expect(leftOutText(report())).toBeUndefined();
    // Control and format characters (C1, bidi overrides) never reach a commit message.
    const odd = leftOutText(
      report({
        items: [
          {
            ...many,
            id: 'a\u0085b\u202ec',
            reasons: [
              { severity: 'error', code: 'x', message: '\u2066y\u0000' },
            ],
          },
        ],
      }),
    );
    expect(odd?.split('\n')[1]).toBe('- module en/a b c (x:  y )');
  });

  it('fails the import when the target changed since it was checked', async () => {
    const t = setup();
    const record = await stored(t, { state: 'applying' });
    t.plan({
      report: report({
        items: report().items.map((item) => ({ ...item, action: 'skip' })),
      }),
      writes: [],
      uploads: [],
    });
    const { run, calls } = runner(t);
    await run.handle({ importId: record.id });
    expect(calls).toEqual([]);
    expect(t.store.rows.get(record.id)).toMatchObject({
      state: 'failed',
      failure: { code: 'import-outdated' },
    });
    expect(t.audit.events[0]?.data).toMatchObject({
      state: 'failed',
      failure: 'import-outdated',
    });
  });

  it('resumes a retried attempt after the save points it made', async () => {
    const t = setup();
    t.plan({ report: report(), writes: writes('a', 'b', 'c'), uploads: [] });
    const changeSetId = newImportId();
    const record = await stored(t, {
      state: 'applying',
      changeSetId,
      progress: {
        ...NO_PROGRESS,
        phase: 'files',
        files: { done: 2, total: 3 },
        commits: ['1'.padStart(40, '0')],
      },
    });
    const { run, calls, deps } = runner(t);
    // The working copy an earlier attempt saved: saved again at its version.
    deps.saveWorkingCopy.handle.mockRejectedValueOnce(
      new ConflictError('version-conflict', 'moved', { version: 1 }),
    );
    await run.handle({ importId: record.id });
    expect(calls).toEqual(['lock c', 'save c', 'commit']);
    expect(deps.saveWorkingCopy.handle).toHaveBeenLastCalledWith(
      expect.objectContaining({ version: 1 }),
    );
    expect(t.pipeline.replay).toHaveBeenCalled();
    expect(t.store.rows.get(record.id)?.state).toBe('applied');
  });

  it('saves a manual with the translation record its file has on the change set’s branch (#663)', async () => {
    const t = setup();
    const subject = workingCopySubject({ type: 'manual', manualId: 'guide' });
    const translations = {
      de: { sourceCommit: 'a'.repeat(40), blocks: {} },
    };
    // A retry rebuilds the write from the bundle: no record.
    t.plan({
      report: report(),
      writes: [
        {
          subject,
          content: { ...manifest('guide', ['a']), title: 'New' },
          bytes: 10,
        },
      ],
      uploads: [],
    });
    const record = await stored(t, {
      state: 'applying',
      changeSetId: newImportId(),
      progress: { ...NO_PROGRESS, phase: 'files' },
    });
    const { run, deps } = runner(t);
    const branch = readable({
      config,
      manifests: [{ ...manifest('guide', ['a']), translations }],
    });
    deps.openSnapshot.handle.mockImplementation(async () => branch as never);
    await run.handle({ importId: record.id });
    expect(deps.saveWorkingCopy.handle).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({ title: 'New', translations }),
      }),
    );
  });

  it('throws a passing failure for the queue to retry, and fails for good otherwise', async () => {
    const t = setup();
    t.plan({ report: report(), writes: writes('a'), uploads: [] });
    const record = await stored(t, { state: 'applying' });
    const { run, deps } = runner(t);
    deps.acquireLock.handle.mockRejectedValueOnce(
      new UnavailableError('database-unavailable', 'down', 1),
    );
    await expect(run.handle({ importId: record.id })).rejects.toBeInstanceOf(
      UnavailableError,
    );
    expect(t.store.rows.get(record.id)?.state).toBe('applying');
    deps.acquireLock.handle.mockRejectedValueOnce(
      new ConflictError('locked', 'held by someone else'),
    );
    await run.handle({ importId: record.id });
    expect(t.store.rows.get(record.id)).toMatchObject({
      state: 'failed',
      failure: { code: 'locked' },
    });
  });

  it('fails the import when its uploader can no longer act, and leaves others alone', async () => {
    const t = setup();
    const record = await stored(t, { state: 'applying' });
    const { run, calls } = runner(t, []);
    await run.handle({ importId: record.id });
    expect(calls).toEqual([]);
    expect(t.store.rows.get(record.id)?.failure?.code).toBe('importer-gone');
    const validated = await stored(t);
    await run.handle({ importId: validated.id });
    expect(t.store.rows.get(validated.id)?.state).toBe('validated');
  });

  it('fails the import when its uploader may no longer import', async () => {
    const t = setup();
    const record = await stored(t, { state: 'applying' });
    const demoted = {
      ...importer,
      roles: importer.roles.map((r) => ({
        ...r,
        permissions: r.permissions.filter((p) => p !== 'admin.roles'),
      })),
    };
    const { run, calls } = runner(t, [demoted]);
    await run.handle({ importId: record.id });
    expect(calls).toEqual([]);
    expect(t.store.rows.get(record.id)?.failure?.code).toBe('forbidden');
  });

  it('fails an import whose upload is gone', async () => {
    const t = setup();
    const record = await stored(t, { state: 'applying' });
    t.blobs.blobs.clear();
    await runner(t).run.handle({ importId: record.id });
    expect(t.store.rows.get(record.id)?.failure?.code).toBe('upload-missing');
  });

  it('FailImportAction marks an import failed once its job gave up', async () => {
    const t = setup();
    const record = await stored(t, { state: 'applying' });
    const fail = new FailImportAction(
      t.store,
      new FakeUserDirectory([importer]),
      t.audit,
      t.unit,
    );
    await fail.handle({ importId: record.id });
    expect(t.store.rows.get(record.id)?.failure?.code).toBe('import-failed');
    // Once only.
    await fail.handle({ importId: record.id });
    expect(t.audit.events).toHaveLength(1);
  });

  it('isPermanent tells a passing failure from one for good', () => {
    expect(isPermanent(new ConflictError('locked', 'x'))).toBe(true);
    expect(isPermanent(new ConflictError('branch-moved', 'x'))).toBe(false);
    expect(isPermanent(new UnavailableError('x', 'y', 1))).toBe(false);
    expect(isPermanent(new Error('x'))).toBe(false);
  });
});
