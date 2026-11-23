import {
  ProjectConfig,
  sourceHashes,
  translationRecordOf,
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
  module,
  type FakeContent,
} from '../../../../tests/fakes/fake-content.js';
import { FakeRepository } from '../../../../tests/fakes/fake-repository.js';
import { FakeTranslationEvents } from '../../../../tests/fakes/fake-translation-events.js';
import {
  FakeTranslationExchange,
  fakePackage,
} from '../../../../tests/fakes/fake-translation-exchange.js';
import { FakeTranslationJobs } from '../../../../tests/fakes/fake-translation-jobs.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import type { Actor, Scope } from '../../../access/core/actor.js';
import type { Permission } from '../../../access/core/permissions.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnavailableError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import type { ContentSnapshot } from '../../../content/core/content.repository.js';
import { ReadableRefs } from '../../../content/core/readable-refs.js';
import { FakeTranslationImportStore } from '../../../../tests/fakes/fake-translation-import-store.js';
import { TranslationImportCheck } from '../translation-import-check.js';
import {
  MAX_UNIT_TEXT_LENGTH,
  reportTextLength,
  reportWith,
} from '../translation-import.js';
import { ExportTranslationsAction } from './export-translations.action.js';
import { MarkTranslationCurrentAction } from './mark-translation-current.action.js';
import {
  ApplyTranslationImportAction,
  GetTranslationImportAction,
  MAX_CONCURRENT_TRANSLATION_IMPORTS,
  recordWith,
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
const as = (permissions: Permission[], scope: Scope = {}): Actor => ({
  ...actorWith(permissions, scope),
  id: 'sample-translator',
});

const para = (id: string, text: string): Block => ({
  type: 'paragraph',
  id,
  content: [{ type: 'text', text }],
});
const doc = (id: string, blocks: Block[], lang = 'en'): Module => {
  const base = module(id, lang);
  return { ...base, meta: { ...base.meta, title: `Title of ${id}` }, blocks };
};

/** `guide`: two paragraphs and an image; `secret` internal. No translation yet. */
const guide = doc('guide', [
  para('b1', 'One.'),
  {
    type: 'image',
    id: 'pic',
    asset: `sha256:${'a'.repeat(64)}`,
    alt: 'A picture',
  },
  para('b2', 'Two.'),
]);
const secret: Module = {
  ...doc('secret', [para('b1', 'Hush.')]),
  meta: { ...doc('secret', []).meta, audience: 'internal' },
};
const content: FakeContent = { config, modules: [guide, secret] };

/** Each `<source>` given a `<target>`. */
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
const toFrench = (_unit: string, source: string) => `FR ${source}`;
const bytes = (text: string) => new TextEncoder().encode(text);

async function setUp(from: FakeContent = content) {
  const snapshot = new FakeSnapshot(from);
  const repo = new FakeRepository(snapshot);
  const open = new OpenSnapshotAction(repo, new FakeAuthoredBranches());
  const jobs = new FakeTranslationJobs();
  const audit = new FakeAuditLog();
  const unit = new FakeUnitOfWork();
  const job = await new ExportTranslationsAction(
    open,
    repo,
    jobs,
    audit,
    unit,
  ).handle({
    actor: translator(),
    languages: ['fr'],
    subject: { type: 'modules', moduleIds: ['guide', 'secret'] },
    ref: 'main',
    dueDate: null,
    dryRun: false,
  });
  const file = await new TranslationJobFileAction(jobs, open).handle({
    actor: translator(),
    id: job.id,
    lang: 'fr',
  });
  const xliff = file.files[0]?.xliff as string;
  // The job's commit stays readable when main moves on.
  repo.branches.set(job.commit, snapshot);
  const branches = new FakeChangeSetBranches();
  const check = new TranslationImportCheck(
    jobs,
    open,
    new ReadableRefs(repo),
    branches,
    { maxBytes: 1024 * 1024 },
    new FakeTranslationExchange(),
  );
  const store = new FakeTranslationImportStore();
  const gate = new TranslationImportGate();
  const validate = new ValidateTranslationImportAction(check, store, gate);
  /** Moves main on to `next`. */
  const moveMain = (next: FakeContent) => {
    const moved = new FakeSnapshot(next);
    (repo as unknown as { main: ContentSnapshot }).main = moved;
    repo.branches.set('change-sets/cs-1', moved);
  };
  return {
    repo,
    jobs,
    job,
    xliff,
    check,
    store,
    gate,
    validate,
    audit,
    moveMain,
    open,
  };
}

const form = (xliff: string, baseRef?: string) => async () => ({
  bytes: bytes(xliff),
  ...(baseRef !== undefined && { baseRef }),
});

describe('ValidateTranslationImportAction', () => {
  it('decides each unit, and keeps the import an hour without writing anything else', async () => {
    const t = await setUp();
    const record = await t.validate.handle({
      actor: translator(),
      form: form(translated(t.xliff, toFrench)),
    });
    expect(record).toMatchObject({
      jobId: t.job.id,
      languages: ['fr'],
      baseRef: 'main',
      state: 'validated',
      createdBy: { kind: 'user', id: 'sample-translator' },
    });
    expect(record.expiresAt.getTime() - record.createdAt.getTime()).toBe(
      3_600_000,
    );
    expect(record.modules).toEqual([
      {
        lang: 'fr',
        moduleId: 'guide',
        title: 'Title of guide',
        units: [
          { blockId: 'b1', kind: 'paragraph', state: 'ok' },
          { blockId: 'pic', kind: 'image', state: 'ok' },
          { blockId: 'b2', kind: 'paragraph', state: 'ok' },
        ],
      },
      {
        lang: 'fr',
        moduleId: 'secret',
        title: 'Title of secret',
        units: [{ blockId: 'b1', kind: 'paragraph', state: 'ok' }],
      },
    ]);
    expect(record.counts).toMatchObject({ units: 4, ok: 4 });
    expect(t.audit.events.map((e) => e.action)).toEqual([
      'translation-job.export',
    ]);
    expect((await t.store.find(record.id))?.import.id).toBe(record.id);
  });

  it('reports a module outside the scope like a missing one, revealing nothing', async () => {
    const t = await setUp();
    const xliff = translated(t.xliff, toFrench);
    const publicOnly = translator({ maxAudience: 'public' });
    const record = await t.validate.handle({
      actor: publicOnly,
      form: form(xliff),
    });
    const secretReport = record.modules.find((m) => m.moduleId === 'secret');
    expect(secretReport?.units).toEqual([
      { blockId: 'b1', state: 'unknown-module' },
    ]);
    expect(secretReport?.units[0]).not.toHaveProperty('detail');
    expect(secretReport).not.toHaveProperty('title');
  });

  it('refuses broken markup unit by unit, and a unit the job did not send', async () => {
    const t = await setUp();
    let xliff = translated(t.xliff, (unit, source) =>
      unit === 'b1' ? 'Un <pc id="9">gras</pc>.' : toFrench(unit, source),
    );
    // A unit added by hand, and one whose source hash was changed.
    xliff = xliff
      .replace(
        '<unit id="b2"',
        '<unit id="extra"><segment><source>x</source><target>y</target></segment></unit><unit id="b2"',
      )
      .replace(
        /(<unit id="b2"[^>]*ccms:sourceHash=")[^"]+/,
        `$1${'0'.repeat(64)}`,
      );
    const record = await t.validate.handle({
      actor: translator(),
      form: form(xliff),
    });
    const units = record.modules.find((m) => m.moduleId === 'guide')?.units;
    expect(units).toEqual([
      expect.objectContaining({
        blockId: 'b1',
        state: 'broken-markup',
        reason: 'unknown-code',
      }),
      { blockId: 'pic', kind: 'image', state: 'ok' },
      expect.objectContaining({
        blockId: 'extra',
        state: 'unknown-block',
        reason: 'not-sent',
      }),
      expect.objectContaining({
        blockId: 'b2',
        state: 'broken-markup',
        reason: 'source-hash',
      }),
    ]);
  });

  it('marks a unit whose source changed since the export, and one whose block is gone', async () => {
    const t = await setUp();
    t.moveMain({
      ...content,
      modules: [
        doc('guide', [para('b1', 'One, edited.'), guide.blocks[1] as Block]),
        secret,
      ],
    });
    const record = await t.validate.handle({
      actor: translator(),
      form: form(translated(t.xliff, toFrench)),
    });
    expect(record.modules[0]?.units).toEqual([
      {
        blockId: 'b1',
        kind: 'paragraph',
        state: 'source-changed',
        texts: {
          exported: 'One.',
          current: 'One, edited.',
          target: 'FR One.',
          truncated: false,
        },
      },
      { blockId: 'pic', kind: 'image', state: 'ok' },
      expect.objectContaining({
        blockId: 'b2',
        kind: 'paragraph',
        state: 'unknown-block',
        reason: 'removed',
      }),
    ]);
  });

  it('cuts a long text, and keeps no texts past the report’s budget', async () => {
    const long = 'Long text. '.repeat(400);
    const t = await setUp({
      config,
      modules: [doc('guide', [para('b1', long), para('b2', 'Two.')]), secret],
    });
    t.moveMain({
      config,
      modules: [
        doc('guide', [para('b1', `${long}!`), para('b2', 'Two, edited.')]),
        secret,
      ],
    });
    const record = await t.validate.handle({
      actor: translator(),
      form: form(translated(t.xliff, toFrench)),
    });
    const [b1, b2] = record.modules[0]?.units ?? [];
    expect(b1?.texts?.truncated).toBe(true);
    expect(b1?.texts?.exported).toHaveLength(MAX_UNIT_TEXT_LENGTH);
    expect(b2?.texts).toEqual({
      exported: 'Two.',
      current: 'Two, edited.',
      target: 'FR Two.',
      truncated: false,
    });
    expect(reportTextLength(record.modules)).toBe(
      (b1?.texts ? 3 * MAX_UNIT_TEXT_LENGTH : 0) + 4 + 12 + 7,
    );
  });

  it('keeps only the units in one state, and the modules with one', () => {
    const modules = [
      {
        lang: 'fr',
        moduleId: 'a',
        units: [
          { blockId: 'x', state: 'ok' as const },
          { blockId: 'y', state: 'source-changed' as const },
        ],
      },
      {
        lang: 'fr',
        moduleId: 'b',
        units: [{ blockId: 'z', state: 'ok' as const }],
      },
    ];
    expect(reportWith(modules, undefined)).toBe(modules);
    expect(reportWith(modules, 'source-changed')).toEqual([
      {
        lang: 'fr',
        moduleId: 'a',
        units: [{ blockId: 'y', state: 'source-changed' }],
      },
    ]);
    expect(reportWith(modules, 'broken-markup')).toEqual([]);
  });

  it('needs translation.manage, before the form is read, and the language in scope', async () => {
    const t = await setUp();
    const read = vi.fn(form(translated(t.xliff, toFrench)));
    await expect(
      t.validate.handle({
        actor: as(['content.read', 'content.edit']),
        form: read,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(read).not.toHaveBeenCalled();
    await expect(
      t.validate.handle({
        actor: translator({ languages: ['de'] }),
        form: read,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses hostile and wrong documents whole, with a stable code', async () => {
    const t = await setUp();
    const header = '<?xml version="1.0" encoding="UTF-8"?>';
    const cases: [string, string][] = [
      [
        t.xliff.replace(
          header,
          `${header}<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>`,
        ),
        'xliff-dtd-forbidden',
      ],
      ['<a>&b;</a>', 'xliff-dtd-forbidden'],
      ['<a>', 'xliff-not-well-formed'],
      ['<a/>', 'not-xliff'],
      [t.xliff.replace(/ccms:job="[^"]+"/, 'ccms:job="nope"'), 'unknown-job'],
      [t.xliff.replace('srcLang="en"', 'srcLang="de"'), 'language-mismatch'],
    ];
    for (const [xliff, code] of cases) {
      await expect(
        t.validate.handle({ actor: translator(), form: form(xliff) }),
      ).rejects.toMatchObject({ code });
    }
    await expect(
      t.validate.handle({
        actor: translator(),
        form: async () => ({ bytes: new Uint8Array([0xff, 0xfe, 0x3c, 0x00]) }),
      }),
    ).rejects.toMatchObject({ code: 'xliff-unsupported-encoding' });
    await expect(
      t.validate.handle({
        actor: translator(),
        form: form(t.xliff, 'nowhere'),
      }),
    ).rejects.toMatchObject({ code: 'invalid-base' });
    expect(await t.store.find('anything')).toBeUndefined();
  });

  it('refuses an upload past the limit', async () => {
    const t = await setUp();
    await expect(
      t.check.documents(new Uint8Array(1024 * 1024 + 1)),
    ).rejects.toMatchObject({ code: 'too-large', meta: { max: 1024 * 1024 } });
  });

  it('checks at most a few at once', async () => {
    const t = await setUp();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = Array.from(
      { length: MAX_CONCURRENT_TRANSLATION_IMPORTS },
      () => t.gate.run(() => held),
    );
    await expect(
      t.validate.handle({ actor: translator(), form: form(t.xliff) }),
    ).rejects.toMatchObject({ code: 'import-busy' });
    release();
    await Promise.all(running);
  });

  it('takes a slot only once the upload is read', async () => {
    const t = await setUp();
    let deliver: () => void = () => undefined;
    const uploaded = new Promise<void>((resolve) => {
      deliver = resolve;
    });
    const xliff = translated(t.xliff, toFrench);
    const slow = t.validate.handle({
      actor: translator(),
      form: async () => {
        await uploaded;
        return { bytes: bytes(xliff) };
      },
    });
    // Every slot is free while the upload trickles in.
    await Promise.all(
      Array.from({ length: MAX_CONCURRENT_TRANSLATION_IMPORTS }, () =>
        t.gate.run(async () => 'ran'),
      ),
    );
    deliver();
    expect((await slow).state).toBe('validated');
  });

  it('is 503 too-many-imports once the store is full', async () => {
    const t = await setUp();
    vi.spyOn(t.store, 'add').mockResolvedValue(false);
    const refused = t.validate.handle({
      actor: translator(),
      form: form(translated(t.xliff, toFrench)),
    });
    await expect(refused).rejects.toBeInstanceOf(UnavailableError);
    await expect(refused).rejects.toMatchObject({ code: 'too-many-imports' });
  });
});

describe('GetTranslationImportAction', () => {
  it('finds an import for its uploader only', async () => {
    const t = await setUp();
    const record = await t.validate.handle({
      actor: translator(),
      form: form(translated(t.xliff, toFrench)),
    });
    const get = new GetTranslationImportAction(t.store);
    expect((await get.handle({ actor: translator(), id: record.id })).id).toBe(
      record.id,
    );
    await expect(
      get.handle({
        actor: { ...translator(), id: 'someone-else' },
        id: record.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      get.handle({ actor: translator(), id: 'nope' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('ApplyTranslationImportAction', () => {
  async function applying(t: Awaited<ReturnType<typeof setUp>>) {
    const calls: string[] = [];
    const unit = new FakeUnitOfWork();
    const events = new FakeTranslationEvents();
    const audit = new FakeAuditLog();
    const action = (
      name: string,
      answer: (input: never) => unknown = () => ({}),
    ) => ({
      handle: vi.fn(async (input: never) => {
        const { subject } = input as {
          subject?: { lang?: string; moduleId?: string };
        };
        calls.push(
          subject?.moduleId
            ? `${name} ${subject.lang}/${subject.moduleId}`
            : name,
        );
        return answer(input);
      }),
    });
    const deps = {
      createChangeSet: action('create', () => ({
        id: 'cs-1',
        branch: 'change-sets/cs-1',
      })),
      acquireLock: action('lock'),
      saveWorkingCopy: action('save'),
      commitWorkingCopies: action('commit', async (input: never) => {
        const { after } = input as {
          after: (tx: never, made: { commit: string }) => Promise<void>;
        };
        await unit.run((tx) => after(tx as never, { commit: 'c'.repeat(40) }));
        return { commit: 'c'.repeat(40) };
      }),
      abandonChangeSet: action('abandon'),
    };
    const apply = new ApplyTranslationImportAction(
      t.check,
      t.store,
      t.gate,
      t.jobs,
      deps.createChangeSet as never,
      deps.acquireLock as never,
      deps.saveWorkingCopy as never,
      deps.commitWorkingCopies as never,
      deps.abandonChangeSet as never,
      t.open,
      audit,
      events,
    );
    return { apply, calls, deps, events, audit };
  }

  it('goes through the change-set actions: one change set, a lock and a working copy per module, one save point', async () => {
    const t = await setUp();
    const record = await t.validate.handle({
      actor: translator(),
      form: form(translated(t.xliff, toFrench)),
    });
    const a = await applying(t);
    const applied = await a.apply.handle({
      actor: translator(),
      id: record.id,
      decisions: [],
    });
    expect(a.calls).toEqual([
      'create',
      'lock fr/guide',
      'lock fr/secret',
      'save fr/guide',
      'save fr/secret',
      'commit',
    ]);
    expect(applied).toMatchObject({
      state: 'applied',
      changeSetId: 'cs-1',
      commit: 'c'.repeat(40),
    });
    const created = a.deps.createChangeSet.handle.mock
      .calls[0]?.[0] as unknown as {
      title: string;
      baseRef: string;
    };
    expect(created.title).toContain(t.job.id);
    expect(created.baseRef).toBe('main');
    const saved = a.deps.saveWorkingCopy.handle.mock
      .calls[0]?.[0] as unknown as {
      content: Module;
      version: number;
    };
    expect(saved.version).toBe(0);
    expect(saved.content.meta.lang).toBe('fr');
    expect(saved.content.blocks).toEqual([
      para('b1', 'FR One.'),
      { ...guide.blocks[1], alt: 'FR A picture' },
      para('b2', 'FR Two.'),
    ]);
    const committed = a.deps.commitWorkingCopies.handle.mock
      .calls[0]?.[0] as unknown as {
      subjects: unknown[];
      translationRecords: {
        record: { sourceCommit: string; blocks: Record<string, string> };
      }[];
    };
    expect(committed.subjects).toHaveLength(2);
    expect(committed.translationRecords[0]?.record).toMatchObject({
      sourceCommit: t.job.commit,
      blocks: Object.fromEntries(sourceHashes(guide)),
    });
    // In the save point's transaction: the job returned, one audit event, one outbox row.
    expect(t.jobs.jobs.get(t.job.id)?.job.state).toBe('returned');
    expect(a.audit.events).toHaveLength(1);
    expect(a.audit.events[0]).toMatchObject({
      action: 'translation.import',
      subject: { type: 'translation-import', id: record.id },
      data: {
        jobId: t.job.id,
        changeSetId: 'cs-1',
        units: 4,
        jobState: 'returned',
      },
    });
    expect(a.events.events).toEqual([
      expect.objectContaining({
        topic: 'translation.imported',
        key: record.id,
        payload: expect.objectContaining({
          importId: record.id,
          changeSetId: 'cs-1',
          languages: ['fr'],
          modules: [
            { lang: 'fr', moduleId: 'guide' },
            { lang: 'fr', moduleId: 'secret' },
          ],
        }),
      }),
    ]);
    // Once.
    await expect(
      a.apply.handle({ actor: translator(), id: record.id, decisions: [] }),
    ).rejects.toMatchObject({
      code: 'invalid-state',
      meta: { state: 'applied' },
    });
  });

  it('writes translated callout legends back to their callouts, and reports one the source no longer has (#548)', async () => {
    const pictured = doc('guide', [
      {
        type: 'image',
        id: 'pic',
        asset: `sha256:${'a'.repeat(64)}`,
        alt: 'A picture',
        callouts: [
          {
            id: 'lid',
            anchor: { x: 0.1, y: 0.1 },
            legend: [
              { type: 'text', text: 'Lid, see ' },
              { type: 'calloutRef', block: 'pic', callout: 'seal' },
            ],
          },
          {
            id: 'seal',
            anchor: { x: 0.5, y: 0.5 },
            legend: [{ type: 'text', text: 'Seal' }],
            when: { op: 'in', attr: 'model', values: ['large'] },
          },
          {
            id: 'plug',
            anchor: { x: 0.9, y: 0.9 },
            legend: [{ type: 'text', text: 'Plug' }],
          },
        ],
      },
    ]);
    const t = await setUp({ config, modules: [pictured, secret] });
    // Every legend is sent, the hidden one too.
    expect(t.xliff).toMatch(
      /<unit id="seal" [^>]*ccms:kind="callout" ccms:image="pic">/,
    );
    const image = pictured.blocks[0] as Extract<Block, { type: 'image' }>;
    const withoutPlug: Module = {
      ...pictured,
      blocks: [{ ...image, callouts: image.callouts?.slice(0, 2) }],
    };
    t.moveMain({ config, modules: [withoutPlug, secret] });
    const record = await t.validate.handle({
      actor: translator(),
      form: form(translated(t.xliff, toFrench)),
    });
    expect(record.modules.find((m) => m.moduleId === 'guide')?.units).toEqual([
      { blockId: 'pic', kind: 'image', state: 'ok' },
      { blockId: 'lid', kind: 'callout', state: 'ok' },
      { blockId: 'seal', kind: 'callout', state: 'ok' },
      expect.objectContaining({
        blockId: 'plug',
        kind: 'callout',
        state: 'unknown-block',
        reason: 'removed',
      }),
    ]);
    const a = await applying(t);
    await a.apply.handle({ actor: translator(), id: record.id, decisions: [] });
    const saved = a.deps.saveWorkingCopy.handle.mock
      .calls[0]?.[0] as unknown as { content: Module };
    const callouts = (
      saved.content.blocks[0] as Extract<Block, { type: 'image' }>
    ).callouts;
    expect(callouts?.map((c) => [c.id, c.legend, c.when])).toEqual([
      [
        'lid',
        [
          { type: 'text', text: 'FR Lid, see ' },
          { type: 'calloutRef', block: 'pic', callout: 'seal' },
        ],
        undefined,
      ],
      [
        'seal',
        [{ type: 'text', text: 'FR Seal' }],
        { op: 'in', attr: 'model', values: ['large'] },
      ],
    ]);
  });

  it('keeps a source-changed unit by default (its record keeps the exported hash), and leaves it out on skip', async () => {
    const t = await setUp();
    const edited = doc('guide', [
      para('b1', 'One, edited.'),
      ...guide.blocks.slice(1),
    ]);
    t.moveMain({ ...content, modules: [edited, secret] });
    const xliff = translated(t.xliff, toFrench);
    const exported = Object.fromEntries(sourceHashes(guide));

    const kept = await t.validate.handle({
      actor: translator(),
      form: form(xliff),
    });
    const a = await applying(t);
    await a.apply.handle({ actor: translator(), id: kept.id, decisions: [] });
    const keptRecord = (
      a.deps.commitWorkingCopies.handle.mock.calls[0]?.[0] as unknown as {
        translationRecords: { record: { blocks: Record<string, string> } }[];
      }
    ).translationRecords[0]?.record;
    expect(keptRecord?.blocks['b1']).toBe(exported['b1']);
    expect(keptRecord?.blocks['b1']).not.toBe(
      Object.fromEntries(sourceHashes(edited))['b1'],
    );

    // The job was returned: a re-import of the same file still works.
    const skipped = await t.validate.handle({
      actor: translator(),
      form: form(xliff),
    });
    const b = await applying(t);
    await b.apply.handle({
      actor: translator(),
      id: skipped.id,
      decisions: [
        { lang: 'fr', moduleId: 'guide', blockId: 'b1', decision: 'skip' },
      ],
    });
    const saved = b.deps.saveWorkingCopy.handle.mock
      .calls[0]?.[0] as unknown as {
      content: Module;
    };
    // Not translated: with no French file yet, it keeps the source's text (and no record).
    expect(saved.content.blocks.find((x) => x.id === 'b1')).toEqual(
      para('b1', 'One, edited.'),
    );
    const skippedRecord = (
      b.deps.commitWorkingCopies.handle.mock.calls[0]?.[0] as unknown as {
        translationRecords: { record: { blocks: Record<string, string> } }[];
      }
    ).translationRecords[0]?.record;
    expect(Object.keys(skippedRecord?.blocks ?? {})).toEqual(['pic', 'b2']);
  });

  it('abandons the change set on a failure and leaves the import validated', async () => {
    const t = await setUp();
    const record = await t.validate.handle({
      actor: translator(),
      form: form(translated(t.xliff, toFrench)),
    });
    const a = await applying(t);
    a.deps.acquireLock.handle.mockImplementationOnce(async () => {
      a.calls.push('lock fr/guide');
      throw new ConflictError('locked', 'Someone else holds it.');
    });
    await expect(
      a.apply.handle({ actor: translator(), id: record.id, decisions: [] }),
    ).rejects.toMatchObject({ code: 'locked' });
    expect(a.calls).toEqual(['create', 'lock fr/guide', 'abandon']);
    expect((await t.store.find(record.id))?.import.state).toBe('validated');
    expect(t.jobs.jobs.get(t.job.id)?.job.state).toBe('sent');
    expect(a.audit.events).toEqual([]);
  });

  it('needs content.edit, is the uploader’s only, and refuses nothing to import', async () => {
    const t = await setUp();
    const record = await t.validate.handle({
      actor: translator(),
      form: form(
        translated(t.xliff, (unit) =>
          unit === 'pic' ? 'x' : '<pc id="7">y</pc>',
        ),
      ),
    });
    const a = await applying(t);
    await expect(
      a.apply.handle({
        actor: as(['content.read', 'content.read.draft', 'translation.manage']),
        id: record.id,
        decisions: [],
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      a.apply.handle({
        actor: { ...translator(), id: 'other' },
        id: record.id,
        decisions: [],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // Only `pic` is ok: skip nothing, so it imports; then make everything broken.
    const broken = await t.validate.handle({
      actor: translator(),
      form: form(translated(t.xliff, () => '<pc id="7">y</pc>')),
    });
    await expect(
      a.apply.handle({ actor: translator(), id: broken.id, decisions: [] }),
    ).rejects.toBeInstanceOf(UnprocessableError);
    expect(a.calls).toEqual([]);
    expect((await t.store.find(broken.id))?.import.state).toBe('validated');
  });
});

describe('recordWith', () => {
  it('takes the new hashes in over the old record, never a prototype key', () => {
    const old = translationRecordOf(guide, 'a'.repeat(40));
    const made = recordWith(
      old,
      'b'.repeat(40),
      new Map([
        ['b1', 'x'],
        ['__proto__', 'y'],
      ]),
    );
    expect(made.sourceCommit).toBe('b'.repeat(40));
    expect(made.blocks).toEqual({ ...old.blocks, b1: 'x' });
    expect(Object.getPrototypeOf(made.blocks)).toBe(Object.prototype);
  });
});

describe('MarkTranslationCurrentAction', () => {
  function marking(from: FakeContent) {
    const snapshot = new FakeSnapshot(from);
    const audit = new FakeAuditLog();
    const unit = new FakeUnitOfWork();
    const calls: string[] = [];
    const deps = {
      getChangeSet: {
        handle: vi.fn(async () => ({
          id: 'cs-1',
          branch: 'change-sets/cs-1',
          author: { kind: 'user', id: 'sample-translator' },
          state: 'draft',
        })),
      },
      openSnapshot: { handle: vi.fn(async () => snapshot) },
      acquireLock: { handle: vi.fn(async () => calls.push('lock')) },
      commitWorkingCopies: {
        handle: vi.fn(
          async (input: {
            after: (tx: never, m: { commit: string }) => Promise<void>;
          }) => {
            calls.push('commit');
            await unit.run((tx) =>
              input.after(tx as never, { commit: 'd'.repeat(40) }),
            );
            return { commit: 'd'.repeat(40) };
          },
        ),
      },
    };
    const mark = new MarkTranslationCurrentAction(
      deps.getChangeSet as never,
      deps.openSnapshot as never,
      deps.acquireLock as never,
      deps.commitWorkingCopies as never,
      { handle: vi.fn() } as never,
      { find: vi.fn(async () => undefined) } as never,
      audit,
      { handle: vi.fn() } as never,
    );
    return { mark, deps, audit, calls, snapshot };
  }

  const french = doc('guide', [para('b1', 'Un.'), para('b2', 'Deux.')], 'fr');
  const withFrench: FakeContent = {
    ...content,
    modules: [guide, secret, french],
    translationRecords: {
      'fr/guide': {
        ...translationRecordOf(guide, 'a'.repeat(40)),
        blocks: { b1: 'old' },
      },
    },
  };

  it('gives the record the current source hashes of the blocks the translation has', async () => {
    const m = marking(withFrench);
    const done = await m.mark.handle({
      actor: translator(),
      changeSetId: 'cs-1',
      moduleId: 'guide',
      lang: 'fr',
    });
    expect(m.calls).toEqual(['lock', 'commit']);
    expect(done).toMatchObject({ commit: 'd'.repeat(40), blocks: 2 });
    const committed = m.deps.commitWorkingCopies.handle.mock
      .calls[0]?.[0] as unknown as {
      subjects: unknown[];
      translationRecords: {
        record: { sourceCommit: string; blocks: Record<string, string> };
      }[];
    };
    expect(committed.subjects).toEqual([]);
    const hashes = Object.fromEntries(sourceHashes(guide));
    expect(committed.translationRecords[0]?.record).toEqual({
      schemaVersion: 1,
      sourceCommit: m.snapshot.commit,
      blocks: { b1: hashes['b1'], b2: hashes['b2'] },
    });
    expect(m.audit.events).toEqual([
      expect.objectContaining({
        action: 'translation.mark-current',
        subject: { type: 'module', id: 'fr/guide' },
      }),
    ]);
  });

  it('records the callout legends the translation has too (#548)', async () => {
    const image = (lang: string, legends: string[]): Module =>
      doc(
        'guide',
        [
          {
            type: 'image',
            id: 'pic',
            asset: `sha256:${'a'.repeat(64)}`,
            alt: 'A picture',
            callouts: legends.map((text, i) => ({
              id: `c${i + 1}`,
              anchor: { x: 0.5, y: 0.5 },
              legend: [{ type: 'text' as const, text }],
            })),
          },
        ],
        lang,
      );
    const source = image('en', ['Lid', 'Plug']);
    // The French picture has the first callout only.
    const m = marking({
      ...content,
      modules: [source, secret, image('fr', ['Couvercle'])],
    });
    await m.mark.handle({
      actor: translator(),
      changeSetId: 'cs-1',
      moduleId: 'guide',
      lang: 'fr',
    });
    const committed = m.deps.commitWorkingCopies.handle.mock
      .calls[0]?.[0] as unknown as {
      translationRecords: { record: { blocks: Record<string, string> } }[];
    };
    const hashes = Object.fromEntries(sourceHashes(source));
    expect(committed.translationRecords[0]?.record.blocks).toEqual({
      pic: hashes['pic'],
      c1: hashes['c1'],
    });
  });

  it('refuses outside the scope, without a translation, or for no target language', async () => {
    const m = marking(withFrench);
    await expect(
      m.mark.handle({
        actor: translator({ languages: ['de'] }),
        changeSetId: 'cs-1',
        moduleId: 'guide',
        lang: 'fr',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      m.mark.handle({
        actor: translator(),
        changeSetId: 'cs-1',
        moduleId: 'guide',
        lang: 'de',
      }),
    ).rejects.toMatchObject({ code: 'translation-missing' });
    await expect(
      m.mark.handle({
        actor: translator(),
        changeSetId: 'cs-1',
        moduleId: 'guide',
        lang: 'en',
      }),
    ).rejects.toMatchObject({ code: 'invalid-parameter' });
    await expect(
      m.mark.handle({
        actor: translator(),
        changeSetId: 'cs-1',
        moduleId: 'nope',
        lang: 'fr',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(m.calls).toEqual([]);
  });
});

describe('a returned package (#140)', () => {
  const packaged =
    (
      t: Awaited<ReturnType<typeof setUp>>,
      xliff: string,
      envelope: Partial<{
        jobId: string;
        sourceLanguage: string;
        targetLanguage: string;
      }> = {},
    ) =>
    async () => ({
      bytes: fakePackage({
        'project/fr.xlf': {
          xliff,
          envelope: {
            jobId: t.job.id,
            sourceLanguage: 'en',
            targetLanguage: 'fr',
            ...envelope,
          },
        },
      }),
    });

  it('is checked exactly as its XLIFF is, the path naming the file in the package', async () => {
    const t = await setUp();
    const xliff = translated(t.xliff, toFrench);
    const plain = await t.validate.handle({
      actor: translator(),
      form: form(xliff),
    });
    const fromPackage = await t.validate.handle({
      actor: translator(),
      form: packaged(t, xliff),
    });
    expect(fromPackage.jobId).toBe(t.job.id);
    expect(fromPackage.modules).toEqual(plain.modules);
    expect(fromPackage.counts).toEqual(plain.counts);
    const stored = await t.store.find(fromPackage.id);
    expect(stored?.documents).toEqual([
      {
        path: 'project/fr.xlf',
        xliff,
        envelope: {
          jobId: t.job.id,
          sourceLanguage: 'en',
          targetLanguage: 'fr',
        },
      },
    ]);
  });

  it('takes its job from the package when the XLIFF names none', async () => {
    const t = await setUp();
    const xliff = translated(t.xliff, toFrench).replace(
      / ccms:job="[^"]+"/,
      '',
    );
    const record = await t.validate.handle({
      actor: translator(),
      form: packaged(t, xliff),
    });
    expect(record.jobId).toBe(t.job.id);
  });

  it('refuses a document of another job or other languages than its package says', async () => {
    const t = await setUp();
    const xliff = translated(t.xliff, toFrench);
    await expect(
      t.validate.handle({
        actor: translator(),
        form: packaged(t, xliff, { jobId: 'another-job' }),
      }),
    ).rejects.toMatchObject({
      code: 'coti-job-mismatch',
      meta: { path: 'project/fr.xlf' },
    });
    await expect(
      t.validate.handle({
        actor: translator(),
        form: packaged(t, xliff, { targetLanguage: 'de' }),
      }),
    ).rejects.toMatchObject({ code: 'language-mismatch' });
    await expect(
      t.validate.handle({
        actor: translator(),
        form: packaged(t, xliff, { sourceLanguage: 'de' }),
      }),
    ).rejects.toMatchObject({ code: 'language-mismatch' });
  });

  it('refuses a package of an unknown or a cancelled job, with stable codes', async () => {
    const t = await setUp();
    const xliff = translated(t.xliff, toFrench).replace(
      / ccms:job="[^"]+"/,
      '',
    );
    await expect(
      t.validate.handle({
        actor: translator(),
        form: packaged(t, xliff, { jobId: 'no-such-job' }),
      }),
    ).rejects.toMatchObject({ code: 'unknown-job' });
    await new FakeUnitOfWork().run((tx) => t.jobs.cancel(tx, t.job.id));
    await expect(
      t.validate.handle({ actor: translator(), form: packaged(t, xliff) }),
    ).rejects.toMatchObject({ code: 'job-not-open' });
  });

  it('is checked again from its stored documents, as an apply does', async () => {
    const t = await setUp();
    const record = await t.validate.handle({
      actor: translator(),
      form: packaged(t, translated(t.xliff, toFrench)),
    });
    const stored = await t.check.check(
      translator(),
      (await t.store.find(record.id))?.documents ?? [],
      'main',
    );
    expect(stored.job.id).toBe(t.job.id);
    expect(stored.modules.flatMap((m) => m.units.map((u) => u.state))).toEqual(
      record.modules.flatMap((m) => m.units.map((u) => u.state)),
    );
  });
});
