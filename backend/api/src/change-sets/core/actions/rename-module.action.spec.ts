import { addressSettings } from '../../../../tests/fakes/fake-address-settings.js';
import {
  type Module,
  parseManifest,
  parseModule,
  parseTranslationRecord,
  sourceHashes,
  compareWithRecord,
} from '@openfolia/content-model';
import { actorWith } from '../../../../tests/fakes/actors.js';
import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import { FakeBlobStore } from '../../../../tests/fakes/fake-blob-store.js';
import { FakeChangeSetBranches } from '../../../../tests/fakes/fake-change-set-branches.js';
import { FakeChangeSetCommits } from '../../../../tests/fakes/fake-change-set-commits.js';
import { FakeChangeSetStore } from '../../../../tests/fakes/fake-change-set-store.js';
import { FakeCommentStore } from '../../../../tests/fakes/fake-comment-store.js';
import { FakeCommitIntents } from '../../../../tests/fakes/fake-commit-intents.js';
import {
  type FakeContent,
  FakeSnapshot,
  manifest,
  module,
} from '../../../../tests/fakes/fake-content.js';
import { FakeLockStore } from '../../../../tests/fakes/fake-lock-store.js';
import { FakeTranslationJobs } from '../../../../tests/fakes/fake-translation-jobs.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import { FakeWorkingCopyStore } from '../../../../tests/fakes/fake-working-copy-store.js';
import { RecordingRenderer } from '../../../../tests/fakes/recording-pdf-renderer.js';
import type { Actor, Scope } from '../../../access/core/actor.js';
import type { Permission } from '../../../access/core/permissions.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import { ReadableContent } from '../../../content/core/readable-content.js';
import {
  ContentRepository,
  type ContentSnapshot,
} from '../../../content/core/content.repository.js';
import { newCommentId } from '../../../comments/core/comment.js';
import { ContentChecks } from '../../../checks/core/content-checks.js';
import { ChangeSetAuthoredBranches } from '../change-set-authored-branches.js';
import {
  type ChangeSet,
  changeSetBranch,
  newChangeSetId,
} from '../change-set.js';
import type { BranchChange } from '../commit.js';
import { CommitRecorder } from '../commit-recorder.js';
import { type LockSubject, newLockId } from '../lock.js';
import {
  RENAME_OUTSIDE_EDIT,
  recordRewrites,
  renameScope,
} from '../module-rename.js';
import { GetModuleReferencesAction } from './get-module-references.action.js';
import { RenameModuleAction } from './rename-module.action.js';

const EDITING: Permission[] = [
  'content.read',
  'content.read.draft',
  'content.edit',
];
const editor = (scope: Scope = {}): Actor => ({
  ...actorWith(EDITING, scope),
  id: 'sample-author',
});
const author = editor();

const mod = (lang: string, moduleId: string): LockSubject => ({
  type: 'module',
  lang,
  moduleId,
});
const manual = (manualId: string): LockSubject => ({
  type: 'manual',
  manualId,
});

class FakeRepository extends ContentRepository {
  readonly branches = new Map<string, ContentSnapshot>();
  readonly commits = new Map<string, ContentSnapshot>();
  main: ContentSnapshot = new FakeSnapshot();

  async at(ref: string): Promise<ContentSnapshot | undefined> {
    return ref === 'main'
      ? this.main
      : (this.branches.get(ref) ?? this.commits.get(ref));
  }

  async refs() {
    return { branches: [], tags: [] };
  }
}

/** Applies a commit's changes to the content, as Git would to the files. */
function applied(
  content: FakeContent,
  changes: readonly BranchChange[],
): FakeContent {
  let modules = [...(content.modules ?? [])];
  let manifests = [...(content.manifests ?? [])];
  const records = { ...content.translationRecords };
  for (const change of changes) {
    const record = /^modules\/([^/]+\/[^/]+)\.translation\.yaml$/.exec(
      change.path,
    );
    if (record) {
      const key = record[1] as string;
      if ('delete' in change) delete records[key];
      else records[key] = parseTranslationRecord(change.content);
      continue;
    }
    const m = /^modules\/([^/]+)\/([^/]+)\.adoc$/.exec(change.path);
    if (m) {
      modules = modules.filter((x) => !(x.id === m[2] && x.meta.lang === m[1]));
      if (!('delete' in change)) {
        modules.push(parseModule(change.content, { id: m[2] as string }));
      }
      continue;
    }
    const id = /^manuals\/([^/]+)\.yaml$/.exec(change.path)?.[1] as string;
    manifests = manifests.filter((x) => x.id !== id);
    if (!('delete' in change)) {
      manifests.push(parseManifest(change.content, { id }));
    }
  }
  return { ...content, modules, manifests, translationRecords: records };
}

const xrefTo = (target: string, id = 'x'): Module['blocks'][number] => ({
  type: 'paragraph',
  id,
  content: [
    { type: 'text', text: 'See ' },
    { type: 'xref', module: target },
  ],
});

/** `charging` in English and German, named by a manual and a module. */
function sample(): FakeContent {
  return {
    modules: [
      {
        ...module('charging'),
        blocks: [...module('charging').blocks, xrefTo('charging', 'self')],
      },
      module('charging', 'de', 'Hallo.'),
      { ...module('storage'), blocks: [xrefTo('charging')] },
      {
        ...module('storage', 'de'),
        blocks: [{ type: 'moduleRef', id: 'r', module: 'charging' }],
      },
      module('other'),
    ],
    manifests: [
      manifest('operating', ['charging', 'other']),
      manifest('quick', ['other']),
    ],
    translationRecords: {
      'de/charging': {
        schemaVersion: 1,
        sourceCommit: 'a'.repeat(40),
        blocks: { p: 'b'.repeat(64) },
      },
    },
  };
}

function setUp(content: FakeContent = sample()) {
  const id = newChangeSetId();
  const now = new Date();
  const repository = new FakeRepository();
  const branch = new FakeSnapshot(content);
  const mine: ChangeSet = {
    id,
    title: 'x',
    description: null,
    author: { kind: 'user', id: author.id },
    baseRef: 'main',
    baseCommit: branch.commit,
    baseReleased: true,
    branch: changeSetBranch(id),
    state: 'draft',
    createdAt: now,
    updatedAt: now,
  };
  repository.branches.set(mine.branch, branch);
  repository.commits.set(branch.commit, branch);
  const branches = new FakeChangeSetBranches();
  branches.heads.set(mine.branch, branch.commit);
  const made: { changes: readonly BranchChange[]; message: string }[] = [];
  branches.onCommit = (commit, commitMade) => {
    made.push(commitMade);
    const before = repository.branches.get(commitMade.branch) as FakeSnapshot;
    const after = new FakeSnapshot(
      applied(before.content, commitMade.changes),
      commit,
    );
    repository.branches.set(commitMade.branch, after);
    repository.commits.set(commit, after);
  };
  const changeSets = new FakeChangeSetStore([mine]);
  const locks = new FakeLockStore();
  const copies = new FakeWorkingCopyStore();
  const audit = new FakeAuditLog();
  const unit = new FakeUnitOfWork();
  const intents = new FakeCommitIntents();
  const comments = new FakeCommentStore();
  const jobs = new FakeTranslationJobs();
  const open = new OpenSnapshotAction(
    repository,
    new ChangeSetAuthoredBranches(changeSets),
  );
  const recorder = new CommitRecorder(
    new FakeChangeSetCommits(),
    branches,
    audit,
    copies,
    intents,
  );
  const lock = (...subjects: LockSubject[]) => {
    for (const subject of subjects) {
      locks.locks.push({
        id: newLockId(),
        subject,
        changeSetId: id,
        holder: { kind: 'user', id: author.id },
        since: now,
      });
    }
  };
  const head = () =>
    repository.branches.get(mine.branch) as FakeSnapshot | undefined;
  return {
    mine,
    branches,
    copies,
    audit,
    comments,
    jobs,
    made,
    lock,
    head,
    /** Saves a working copy of `subject` holding `content`. */
    copy: (subject: LockSubject, content: Module) =>
      unit.run((tx) =>
        copies.save(
          tx,
          {
            changeSetId: id,
            subject,
            content,
            baseCommit: branch.commit,
            updatedBy: { kind: 'user', id: author.id },
          },
          0,
        ),
      ),
    /** `subject` locked by another revision. */
    lockedElsewhere: (subject: LockSubject) =>
      locks.locks.push({
        id: newLockId(),
        subject,
        changeSetId: newChangeSetId(),
        holder: { kind: 'user', id: 'sample-other' },
        since: now,
      }),
    /** Every lock renaming `charging` to `battery` in `sample()` needs. */
    lockAll: () =>
      lock(
        mod('de', 'charging'),
        mod('en', 'charging'),
        mod('de', 'battery'),
        mod('en', 'battery'),
        manual('operating'),
        mod('de', 'storage'),
        mod('en', 'storage'),
      ),
    rename: new RenameModuleAction(
      changeSets,
      locks,
      copies,
      branches,
      recorder,
      intents,
      open,
      comments,
      jobs,
      audit,
      unit,
    ),
    references: new GetModuleReferencesAction(
      changeSets,
      locks,
      copies,
      branches,
      recorder,
      intents,
      open,
      unit,
    ),
  };
}

const renaming = (
  s: ReturnType<typeof setUp>,
  to = 'battery',
  from = 'charging',
  actor = author,
) => s.rename.handle({ actor, changeSetId: s.mine.id, from, to });

describe('RenameModuleAction', () => {
  it('moves every language and rewrites what names it, in one commit', async () => {
    const s = setUp();
    s.lockAll();
    const outcome = await renaming(s);
    expect(outcome).toMatchObject({
      from: 'charging',
      to: 'battery',
      languages: ['de', 'en'],
      rewritten: [
        manual('operating'),
        mod('de', 'storage'),
        mod('en', 'storage'),
      ],
    });
    expect(s.made).toHaveLength(1);
    expect(s.made[0]?.message).toBe('Rename module charging to battery');
    const after = s.head()?.content;
    const ids = after?.modules?.map((m) => `${m.meta.lang}/${m.id}`).sort();
    expect(ids).toEqual([
      'de/battery',
      'de/storage',
      'en/battery',
      'en/other',
      'en/storage',
    ]);
    const all = JSON.stringify(after?.modules);
    expect(all).not.toContain('"module":"charging"');
    // The module's cross-reference to itself follows it too.
    const moved = after?.modules?.find(
      (m) => m.id === 'battery' && m.meta.lang === 'en',
    );
    expect(JSON.stringify(moved?.blocks)).toContain('"module":"battery"');
    expect(
      after?.manifests?.find((m) => m.id === 'operating')?.entries,
    ).toEqual([{ module: 'battery' }, { module: 'other' }]);
    // A manual not naming it is not touched.
    expect(
      s.made[0]?.changes.some((c) => c.path === 'manuals/quick.yaml'),
    ).toBe(false);
    // The translation record moved with it.
    expect(Object.keys(after?.translationRecords ?? {})).toEqual([
      'de/battery',
    ]);
    // The commit records the new files and the rewritten ones as written.
    const commit = s.audit.events.find((e) => e.action === 'change-set.commit');
    expect(commit?.data).toMatchObject({ written: 5, deleted: 2 });
    const files = (action: string) =>
      s.audit.events
        .filter((e) => e.action === action)
        .map((e) => `${e.subject.type}/${e.subject.id}`)
        .sort();
    expect([...files('module.write'), ...files('manual.write')]).toEqual([
      'module/de/battery',
      'module/de/storage',
      'module/en/battery',
      'module/en/storage',
      'manual/operating',
    ]);
    expect(files('module.delete')).toEqual([
      'module/de/charging',
      'module/en/charging',
    ]);
    const renames = s.audit.events.filter((e) => e.action === 'module.rename');
    expect(renames.map((e) => e.subject)).toEqual([
      { type: 'module', id: 'de/charging' },
      { type: 'module', id: 'en/charging' },
    ]);
    expect(renames[0]?.data).toEqual({
      changeSetId: s.mine.id,
      commit: outcome.commit,
      from: 'charging',
      to: 'battery',
      rewritten: 3,
      comments: 0,
    });
  });

  it('keeps translations up to date: records take the hashes of the rewritten cross-references', async () => {
    const content = sample();
    const modules = content.modules ?? [];
    const of = (id: string) =>
      modules.find((m) => m.id === id && m.meta.lang === 'en') as Module;
    const recordOf = (m: Module) => ({
      schemaVersion: 1 as const,
      sourceCommit: 'a'.repeat(40),
      blocks: Object.fromEntries(sourceHashes(m)),
    });
    const s = setUp({
      ...content,
      translationRecords: {
        'de/charging': recordOf(of('charging')),
        'de/storage': recordOf(of('storage')),
      },
    });
    s.lockAll();
    await renaming(s);
    const after = s.head()?.content;
    const records = after?.translationRecords ?? {};
    const en = (id: string) =>
      after?.modules?.find(
        (m) => m.id === id && m.meta.lang === 'en',
      ) as Module;
    for (const [id, key] of [
      ['battery', 'de/battery'],
      ['storage', 'de/storage'],
    ] as const) {
      const states = compareWithRecord(en(id), records[key]).map(
        (b) => b.state,
      );
      expect(states.length).toBeGreaterThan(0);
      expect(states).not.toContain('outdated');
    }
  });

  it('copies a file that does not name itself byte for byte', async () => {
    const s = setUp();
    s.lockAll();
    const before = await s.head()?.file('modules/de/charging.adoc');
    await renaming(s);
    const written = s.made[0]?.changes.find(
      (c) => c.path === 'modules/de/battery.adoc',
    );
    expect(written && 'content' in written && written.content).toBe(
      new TextDecoder().decode(before),
    );
  });

  it('takes the change set’s comments on the module along', async () => {
    const s = setUp();
    s.lockAll();
    const comment = {
      id: newCommentId(),
      changeSetId: s.mine.id,
      subject: { type: 'module' as const, lang: 'en', moduleId: 'charging' },
      blockId: 'p',
      commit: 'c'.repeat(40),
      author: { kind: 'user' as const, id: 'sample-reviewer' },
      body: 'Hm.',
      createdAt: new Date(),
    };
    s.comments.comments.push({ ...comment, threadId: comment.id });
    const outcome = await renaming(s);
    expect(outcome.comments).toBe(1);
    expect(s.comments.comments[0]?.subject).toEqual({
      type: 'module',
      lang: 'en',
      moduleId: 'battery',
    });
  });

  it('refuses an ID that is none, the same one, or one taken', async () => {
    const s = setUp();
    s.lockAll();
    await expect(renaming(s, 'Not an ID')).rejects.toMatchObject({
      code: 'invalid-id',
      meta: { member: 'to' },
    });
    await expect(renaming(s, 'battery', '../x')).rejects.toMatchObject({
      code: 'invalid-id',
      meta: { member: 'from' },
    });
    await expect(renaming(s, 'charging')).rejects.toBeInstanceOf(
      UnprocessableError,
    );
    await expect(renaming(s, 'other')).rejects.toMatchObject({
      code: 'id-taken',
      meta: { moduleId: 'other' },
    });
    await expect(renaming(s, 'nope', 'missing')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(s.made).toEqual([]);
  });

  it('needs every lock: the module under both IDs and each file it rewrites', async () => {
    const s = setUp();
    s.lock(mod('de', 'charging'), mod('en', 'charging'), manual('operating'));
    await expect(renaming(s)).rejects.toMatchObject({
      code: 'lock-required',
      meta: { subject: mod('de', 'battery') },
    });
    s.lock(mod('de', 'battery'), mod('en', 'battery'), mod('de', 'storage'));
    await expect(renaming(s)).rejects.toMatchObject({
      code: 'lock-required',
      meta: { subject: mod('en', 'storage') },
    });
    expect(s.made).toEqual([]);
  });

  it('refuses while a subject it touches has a working copy', async () => {
    const s = setUp();
    s.lockAll();
    await s.copy(mod('de', 'storage'), module('storage', 'de'));
    const refusal = await renaming(s).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ConflictError);
    expect(refusal).toMatchObject({
      code: 'uncommitted-working-copies',
      meta: { subjects: [mod('de', 'storage')] },
    });
  });

  it('refuses while blocks of the module are at a translation provider', async () => {
    const s = setUp();
    s.lockAll();
    s.jobs.units = [{ lang: 'de', moduleId: 'charging', blockId: 'p' }];
    await expect(renaming(s)).rejects.toMatchObject({
      code: 'translation-at-provider',
      meta: { langs: ['de'] },
    });
  });

  it('answers one 403 for anything outside the scope, whatever it is', async () => {
    const answers: unknown[] = [];
    // German not edited: the module has a German file.
    // An audience the role does not reach: the module and a manual naming it.
    const outside: [Scope, FakeContent][] = [
      [{ languages: ['en'] }, sample()],
      [
        { maxAudience: 'public' },
        {
          ...sample(),
          config: {
            ...(await new FakeSnapshot().config()),
            audiences: [
              { id: 'public', label: 'Public' },
              { id: 'internal', label: 'Internal' },
            ],
          },
          manifests: [
            { ...manifest('service', ['charging']), audience: 'internal' },
          ],
        },
      ],
    ];
    for (const [scope, content] of outside) {
      const s = setUp(content);
      s.lockAll();
      const actor = editor(scope);
      const refusal = await renaming(s, 'battery', 'charging', actor).catch(
        (e: unknown) => e,
      );
      expect(refusal).toBeInstanceOf(ForbiddenError);
      answers.push((refusal as Error).message);
      await expect(
        s.references.handle({
          actor,
          changeSetId: s.mine.id,
          moduleId: 'charging',
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(s.made).toEqual([]);
    }
    expect(answers).toEqual([RENAME_OUTSIDE_EDIT, RENAME_OUTSIDE_EDIT]);
  });

  it('answers the same whether or not a hidden module has the new ID in another language', async () => {
    const english = editor({ languages: ['en'] });
    const answers: unknown[] = [];
    for (const hidden of [true, false]) {
      const s = setUp({
        modules: [module('solo'), ...(hidden ? [module('taken', 'de')] : [])],
      });
      s.lock(mod('en', 'solo'), mod('en', 'taken'));
      const refusal = await renaming(s, 'taken', 'solo', english).catch(
        (e: unknown) => e,
      );
      answers.push([
        (refusal as Error).constructor.name,
        (refusal as Error).message,
      ]);
    }
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[0]).toEqual(['ForbiddenError', RENAME_OUTSIDE_EDIT]);
  });

  it('answers a missing module as a hidden one to an actor who does not read everything', async () => {
    const s = setUp();
    await expect(
      renaming(s, 'x', 'missing', editor({ languages: ['en'] })),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('GetModuleReferencesAction', () => {
  it('lists the languages, the files naming the module and their working copies', async () => {
    const s = setUp();
    s.lock(mod('en', 'storage'));
    await s.copy(mod('en', 'storage'), module('storage'));
    const found = await s.references.handle({
      actor: author,
      changeSetId: s.mine.id,
      moduleId: 'charging',
    });
    expect(found).toEqual({
      moduleId: 'charging',
      head: s.mine.baseCommit,
      languages: ['de', 'en'],
      references: [
        manual('operating'),
        mod('de', 'storage'),
        mod('en', 'storage'),
      ],
      translations: [],
      workingCopies: [mod('en', 'storage')],
    });
  });
});

/**
 * `sample()` with `tips`, whose English names `charging` by a
 * cross-reference and whose German does not, translated up to date: a
 * rename rewrites `tips`'s German record but not its German file.
 */
function withTranslatedTips(): FakeContent {
  const content = sample();
  const tips: Module = { ...module('tips'), blocks: [xrefTo('charging')] };
  return {
    ...content,
    modules: [
      ...(content.modules ?? []),
      tips,
      module('tips', 'de', 'Siehe dort.'),
    ],
    translationRecords: {
      ...content.translationRecords,
      'de/tips': {
        schemaVersion: 1,
        sourceCommit: 'a'.repeat(40),
        blocks: Object.fromEntries(sourceHashes(tips)),
      },
    },
  };
}

describe('RenameModuleAction: the translation records it rewrites (#354)', () => {
  it('locks their modules too, and names them in module.write', async () => {
    const s = setUp(withTranslatedTips());
    s.lockAll();
    s.lock(mod('en', 'tips'));
    await expect(renaming(s)).rejects.toMatchObject({
      code: 'lock-required',
      meta: { subject: mod('de', 'tips') },
    });
    expect(s.made).toEqual([]);

    s.lock(mod('de', 'tips'));
    await renaming(s);
    const paths = s.made[0]?.changes.map((c) => c.path);
    expect(paths).toContain('modules/de/tips.translation.yaml');
    expect(paths).not.toContain('modules/de/tips.adoc');
    const writes = s.audit.events
      .filter((e) => e.action === 'module.write')
      .map((e) => e.subject);
    expect(writes).toContainEqual({ type: 'module', id: 'de/tips' });
    // Still up to date after the rename.
    const after = s.head()?.content;
    const en = after?.modules?.find(
      (m) => m.id === 'tips' && m.meta.lang === 'en',
    ) as Module;
    const states = compareWithRecord(
      en,
      after?.translationRecords?.['de/tips'],
    ).map((b) => b.state);
    expect(states.length).toBeGreaterThan(0);
    expect(states).not.toContain('outdated');
  });

  it('is refused while another revision holds the lock of such a module', async () => {
    const s = setUp(withTranslatedTips());
    s.lockAll();
    s.lock(mod('en', 'tips'));
    s.lockedElsewhere(mod('de', 'tips'));
    await expect(renaming(s)).rejects.toMatchObject({
      code: 'lock-required',
      meta: { subject: mod('de', 'tips') },
    });
    expect(s.made).toEqual([]);
  });

  it('refuses while such a module has a working copy', async () => {
    const s = setUp(withTranslatedTips());
    s.lockAll();
    s.lock(mod('en', 'tips'), mod('de', 'tips'));
    await s.copy(mod('de', 'tips'), module('tips', 'de', 'Getippt.'));
    await expect(renaming(s)).rejects.toMatchObject({
      code: 'uncommitted-working-copies',
      meta: { subjects: [mod('de', 'tips')] },
    });
  });

  it('lists them in the plan, and gives the one 403 for one outside the scope', async () => {
    const s = setUp(withTranslatedTips());
    const found = await s.references.handle({
      actor: author,
      changeSetId: s.mine.id,
      moduleId: 'charging',
    });
    expect(found.translations).toEqual([mod('de', 'tips')]);
    // An author of public content only: the German translation of `tips`
    // is internal, out of reach, though the rest of the plan is not.
    const content = withTranslatedTips();
    const hidden = setUp({
      ...content,
      modules: (content.modules ?? []).map((m) =>
        m.id === 'tips' && m.meta.lang === 'de'
          ? { ...m, meta: { ...m.meta, audience: 'internal' } }
          : m,
      ),
    });
    const publicOnly = editor({ maxAudience: 'public' });
    // The same plan with the translation public is theirs to read.
    await expect(
      s.references.handle({
        actor: publicOnly,
        changeSetId: s.mine.id,
        moduleId: 'charging',
      }),
    ).resolves.toMatchObject({ translations: [mod('de', 'tips')] });
    const refusal = await hidden.references
      .handle({
        actor: publicOnly,
        changeSetId: hidden.mine.id,
        moduleId: 'charging',
      })
      .catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ForbiddenError);
    expect((refusal as ForbiddenError).message).toBe(RENAME_OUTSIDE_EDIT);
  });

  it('gives the one 403 for a record outside the scope on the rename too', async () => {
    // The rename itself needs an author of all of every configured language
    // (#265), who reaches every record: so the check is shown on the
    // function the rename calls, with the actor it is given.
    const content = withTranslatedTips();
    const snapshot = new FakeSnapshot({
      ...content,
      modules: (content.modules ?? []).map((m) =>
        m.id === 'tips' && m.meta.lang === 'de'
          ? { ...m, meta: { ...m.meta, audience: 'internal' } }
          : m,
      ),
    });
    const publicOnly = editor({ maxAudience: 'public' });
    const as = (actor: Actor) =>
      new ReadableContent(snapshot, actor, 'content.read.draft');
    const hidden = as(publicOnly);
    const scope = await renameScope(publicOnly, hidden, 'charging');
    const refusal = await recordRewrites(
      publicOnly,
      hidden,
      scope,
      'battery',
    ).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ForbiddenError);
    expect((refusal as ForbiddenError).message).toBe(RENAME_OUTSIDE_EDIT);
    await expect(
      recordRewrites(author, as(author), scope, 'battery'),
    ).resolves.toMatchObject([{ subject: mod('de', 'tips') }]);

    // And the rename by that actor writes nothing.
    const s = setUp({ ...snapshot.content });
    s.lockAll();
    s.lock(mod('en', 'tips'), mod('de', 'tips'));
    await expect(
      renaming(s, 'battery', 'charging', publicOnly),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(s.made).toEqual([]);
  });

  it('leaves a record whose translation was deleted alone', async () => {
    const content = withTranslatedTips();
    const s = setUp({
      ...content,
      modules: (content.modules ?? []).filter(
        (m) => !(m.id === 'tips' && m.meta.lang === 'de'),
      ),
    });
    s.lockAll();
    s.lock(mod('en', 'tips'));
    await renaming(s);
    const paths = s.made[0]?.changes.map((c) => c.path);
    expect(paths).not.toContain('modules/de/tips.translation.yaml');
  });
});

const deprecated = (m: Module, replacedBy: string): Module => ({
  ...m,
  meta: { ...m.meta, deprecated: { reason: 'Superseded.', replacedBy } },
});

/**
 * `sample()` with `legacy` deprecated in favour of `charging` (its German
 * file holding no deprecation of its own), the manual `old-guide`
 * deprecated in favour of the manual `operating` and including `charging`,
 * and the manual `retired` deprecated in favour of `quick`.
 */
function withReplacements(): FakeContent {
  const content = sample();
  return {
    ...content,
    modules: [
      ...(content.modules ?? []),
      deprecated(module('legacy'), 'charging'),
      module('legacy', 'de', 'Alt.'),
    ],
    manifests: [
      ...(content.manifests ?? []),
      {
        ...manifest('old-guide', ['charging']),
        deprecated: { reason: 'Merged.', replacedBy: 'operating' },
      },
      {
        ...manifest('retired', ['other']),
        deprecated: { reason: 'Gone.', replacedBy: 'quick' },
      },
    ],
  };
}

/** The codes of the checks of `subjects` at `snapshot`, read by the author. */
async function checkCodes(
  snapshot: FakeSnapshot | undefined,
  subjects: LockSubject[],
): Promise<string[]> {
  const checked = await new ContentChecks(
    new FakeBlobStore(),
    new RecordingRenderer(),
    addressSettings(),
  ).changes(
    new ReadableContent(snapshot as FakeSnapshot, author, 'content.read.draft'),
    subjects,
  );
  return checked.checks.map((c) => c.code);
}

describe('RenameModuleAction: replacements naming the module (#360)', () => {
  const lockReplacements = (s: ReturnType<typeof setUp>) => {
    s.lockAll();
    s.lock(mod('en', 'legacy'), manual('old-guide'));
  };

  it('rewrites a module’s replacedBy, lists and locks it with the rest', async () => {
    const s = setUp(withReplacements());
    expect(
      await checkCodes(s.head(), [mod('en', 'legacy'), manual('old-guide')]),
    ).not.toContain('unknown-replacement');
    const plan = await s.references.handle({
      actor: author,
      changeSetId: s.mine.id,
      moduleId: 'charging',
    });
    expect(plan.references).toEqual([
      manual('old-guide'),
      manual('operating'),
      mod('de', 'storage'),
      mod('en', 'legacy'),
      mod('en', 'storage'),
    ]);
    // Named only as a replacement: no block changes, no record to rewrite.
    expect(plan.translations).toEqual([]);

    lockReplacements(s);
    const outcome = await renaming(s);
    expect(outcome.rewritten).toEqual(plan.references);
    const after = s.head();
    const of = (id: string, lang = 'en') =>
      after?.content.modules?.find((m) => m.id === id && m.meta.lang === lang);
    expect(of('legacy')?.meta.deprecated).toEqual({
      reason: 'Superseded.',
      replacedBy: 'battery',
    });
    // The rest of it as it was.
    expect(of('legacy')?.blocks).toEqual(module('legacy').blocks);
    // A manual's replacement is a manual: kept, though its entries follow.
    const guide = after?.content.manifests?.find((m) => m.id === 'old-guide');
    expect(guide?.deprecated).toEqual({
      reason: 'Merged.',
      replacedBy: 'operating',
    });
    expect(guide?.entries).toEqual([{ module: 'battery' }]);
    const paths = s.made[0]?.changes.map((c) => c.path);
    expect(paths).toContain('modules/en/legacy.adoc');
    expect(paths).not.toContain('modules/de/legacy.adoc');
    expect(paths).not.toContain('manuals/retired.yaml');
    const writes = s.audit.events
      .filter((e) => e.action === 'module.write' || e.action === 'manual.write')
      .map((e) => `${e.subject.type}/${e.subject.id}`);
    expect(writes).toEqual(
      expect.arrayContaining(['module/en/legacy', 'manual/old-guide']),
    );
    expect(
      s.audit.events.find((e) => e.action === 'module.rename')?.data,
    ).toMatchObject({ rewritten: 5 });
    expect(
      await checkCodes(after, [
        mod('en', 'legacy'),
        manual('old-guide'),
        manual('retired'),
      ]),
    ).not.toContain('unknown-replacement');
  });

  it('needs its lock, and is refused while another revision holds it', async () => {
    const s = setUp(withReplacements());
    s.lockAll();
    s.lock(manual('old-guide'));
    await expect(renaming(s)).rejects.toMatchObject({
      code: 'lock-required',
      meta: { subject: mod('en', 'legacy') },
    });
    s.lockedElsewhere(mod('en', 'legacy'));
    await expect(renaming(s)).rejects.toMatchObject({
      code: 'lock-required',
      meta: { subject: mod('en', 'legacy') },
    });
    expect(s.made).toEqual([]);
  });

  it('refuses while it has a working copy', async () => {
    const s = setUp(withReplacements());
    lockReplacements(s);
    await s.copy(mod('en', 'legacy'), module('legacy'));
    await expect(renaming(s)).rejects.toMatchObject({
      code: 'uncommitted-working-copies',
      meta: { subjects: [mod('en', 'legacy')] },
    });
    expect(s.made).toEqual([]);
  });

  it('gives the one 403 when it lies outside the actor’s scope', async () => {
    const content = withReplacements();
    const s = setUp({
      ...content,
      modules: (content.modules ?? []).map((m) =>
        m.id === 'legacy' && m.meta.lang === 'en'
          ? { ...m, meta: { ...m.meta, audience: 'internal' } }
          : m,
      ),
    });
    lockReplacements(s);
    const refusal = await renaming(
      s,
      'battery',
      'charging',
      editor({ maxAudience: 'public' }),
    ).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ForbiddenError);
    expect((refusal as ForbiddenError).message).toBe(RENAME_OUTSIDE_EDIT);
    expect(s.made).toEqual([]);
  });

  it('only reads a deprecation in the source language', async () => {
    const content = withReplacements();
    const s = setUp({
      ...content,
      modules: (content.modules ?? []).map((m) =>
        m.id === 'legacy' ? deprecated(m, 'charging') : m,
      ),
    });
    lockReplacements(s);
    const outcome = await renaming(s);
    expect(outcome.rewritten).toContainEqual(mod('en', 'legacy'));
    expect(outcome.rewritten).not.toContainEqual(mod('de', 'legacy'));
  });

  it('moves a deprecation naming the module itself along with it', async () => {
    const content = sample();
    const s = setUp({
      ...content,
      modules: (content.modules ?? []).map((m) =>
        m.id === 'charging' && m.meta.lang === 'en'
          ? deprecated({ ...m, blocks: module('charging').blocks }, 'charging')
          : m,
      ),
    });
    // Its own warning (a module replaced by itself), nothing more.
    const replacements = async (id: string) =>
      (await checkCodes(s.head(), [mod('en', id)])).filter(
        (c) => c === 'unknown-replacement',
      );
    expect(await replacements('charging')).toHaveLength(1);
    s.lockAll();
    await renaming(s);
    const moved = s
      .head()
      ?.content.modules?.find(
        (m) => m.id === 'battery' && m.meta.lang === 'en',
      );
    expect(moved?.meta.deprecated?.replacedBy).toBe('battery');
    expect(await replacements('battery')).toHaveLength(1);
  });
});
