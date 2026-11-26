import { FakeRefreshConflicts } from '../../../../tests/fakes/fake-refresh-conflicts.js';
import { FakeAssetUploads } from '../../../../tests/fakes/fake-asset-uploads.js';
import { ReadableAssets } from '../../../assets/core/readable-assets.js';
import {
  type Manifest,
  type Module,
  parseConfig,
  parseManifest,
  parseModule,
  PageDesign,
  parsePageDesign,
  printPageDesign,
  printConfig,
  parseTranslationRecord,
  printModule,
  printTranslationRecord,
  ProjectConfig,
  type TranslationRecord,
} from '@openfolia/content-model';
import { actorWith } from '../../../../tests/fakes/actors.js';
import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import { FakeChangeSetBranches } from '../../../../tests/fakes/fake-change-set-branches.js';
import { FakeChangeSetCommits } from '../../../../tests/fakes/fake-change-set-commits.js';
import { FakeCommitIntents } from '../../../../tests/fakes/fake-commit-intents.js';
import { FakeChangeSetStore } from '../../../../tests/fakes/fake-change-set-store.js';
import {
  config as fakeConfig,
  type FakeContent,
  FakeSnapshot,
  manifest,
  module,
} from '../../../../tests/fakes/fake-content.js';
import { FakeLockStore } from '../../../../tests/fakes/fake-lock-store.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import { FakeWorkingCopyStore } from '../../../../tests/fakes/fake-working-copy-store.js';
import type { Actor, Scope } from '../../../access/core/actor.js';
import type { Permission } from '../../../access/core/permissions.js';
import type { CheckedAuditEvent } from '../../../audit/core/audit-log.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
  UnprocessableProblems,
} from '../../../base/core/errors.js';
import type { Transaction } from '../../../base/core/unit-of-work.js';
import { ChangeSetAuthoredBranches } from '../change-set-authored-branches.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import {
  ContentRepository,
  type ContentSnapshot,
} from '../../../content/core/content.repository.js';
import {
  type ChangeSet,
  changeSetBranch,
  newChangeSetId,
} from '../change-set.js';
import { INTENT_TTL_MS } from '../commit-intents.js';
import { CommitRecorder } from '../commit-recorder.js';
import { type BranchChange, MAX_COMMIT_CHANGES } from '../commit.js';
import { type LockSubject, newLockId } from '../lock.js';
import type { WorkingCopyContent } from '../working-copy.js';
import { CommitWorkingCopiesAction } from './commit-working-copies.action.js';
import { ReconcileChangeSetCommitsAction } from './reconcile-change-set-commits.action.js';
import { RevertChangesAction } from './revert-changes.action.js';
import { SaveWorkingCopyAction } from './save-working-copy.action.js';
import { MarkTranslationCurrentAction } from '../../../translations/core/actions/mark-translation-current.action.js';

const EDITING: Permission[] = [
  'content.read',
  'content.read.draft',
  'content.edit',
];
const editor = (scope: Scope = {}, id = 'sample-author'): Actor => ({
  ...actorWith(EDITING, scope),
  id,
});
const author = editor();

const charging: LockSubject = {
  type: 'module',
  lang: 'en',
  moduleId: 'charging',
};
const safety: LockSubject = { type: 'module', lang: 'en', moduleId: 'safety' };
const operating: LockSubject = { type: 'manual', manualId: 'operating' };

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
    return {
      branches: [
        { name: 'main', commit: this.main.commit },
        ...[...this.branches].map(([name, s]) => ({ name, commit: s.commit })),
      ],
      tags: [],
    };
  }
}

/** An audit log that fails while `failing` is set, as a database outage would. */
class FailingAuditLog extends FakeAuditLog {
  failing = false;
  protected override append(
    tx: Transaction,
    event: CheckedAuditEvent,
  ): Promise<void> {
    if (this.failing) return Promise.reject(new Error('the database is down'));
    return super.append(tx, event);
  }
}

/** Applies a commit's changes to the content, as Git would to the files. */
function applied(
  content: FakeContent,
  changes: readonly (
    { path: string; content: string } | { path: string; delete: true }
  )[],
): FakeContent {
  let modules = [...(content.modules ?? [])];
  let manifests = [...(content.manifests ?? [])];
  let config = content.config;
  const terms = { ...content.terms };
  const designs = { ...content.pageDesigns };
  const templates: NonNullable<FakeContent['designTemplates']> =
    Object.fromEntries(
      Object.entries(content.designTemplates ?? {}).map(([id, files]) => [
        id,
        { ...files },
      ]),
    );
  const records = { ...content.translationRecords };
  for (const change of changes) {
    if (change.path === 'openfolia.yaml') {
      if (!('delete' in change)) config = parseConfig(change.content);
      continue;
    }
    const template = /^templates\/([^/]+)\/(.+)$/.exec(change.path);
    if (template) {
      const [, id, path] = template as unknown as [string, string, string];
      const files = (templates[id] ??= {});
      if ('delete' in change) delete files[path];
      else files[path] = change.content;
      continue;
    }
    const design = /^design\/([^/]+)\.yaml$/.exec(change.path)?.[1];
    if (design !== undefined) {
      if ('delete' in change) delete designs[design];
      else designs[design] = change.content;
      continue;
    }
    const term = /^terms\/([^/]+)\.yaml$/.exec(change.path)?.[1];
    if (term !== undefined) {
      if ('delete' in change) delete terms[term];
      else terms[term] = change.content;
      continue;
    }
    const record = /^modules\/([^/]+\/[^/]+)\.translation\.yaml$/.exec(
      change.path,
    )?.[1];
    if (record !== undefined) {
      if ('delete' in change) delete records[record];
      else records[record] = parseTranslationRecord(change.content);
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
  return {
    ...content,
    modules,
    manifests,
    terms,
    pageDesigns: designs,
    designTemplates: templates,
    translationRecords: records,
    ...(config && { config }),
  };
}

function setUp(content: FakeContent = {}) {
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
  branches.onCommit = (commit, made) => {
    const before = repository.branches.get(made.branch) as FakeSnapshot;
    const after = new FakeSnapshot(
      applied(before.content, made.changes),
      commit,
    );
    repository.branches.set(made.branch, after);
    repository.commits.set(commit, after);
  };
  const changeSets = new FakeChangeSetStore([mine]);
  const locks = new FakeLockStore();
  const copies = new FakeWorkingCopyStore();
  const audit = new FailingAuditLog();
  const unit = new FakeUnitOfWork();
  const commits = new FakeChangeSetCommits();
  const intents = new FakeCommitIntents();
  const open = new OpenSnapshotAction(
    repository,
    new ChangeSetAuthoredBranches(changeSets),
  );
  const recorder = new CommitRecorder(
    commits,
    branches,
    audit,
    copies,
    intents,
  );
  const lock = (subject: LockSubject) =>
    locks.locks.push({
      id: newLockId(),
      subject,
      changeSetId: id,
      holder: { kind: 'user', id: author.id },
      since: now,
    });
  const assets = new FakeAssetUploads();
  const readable = new ReadableAssets(assets);
  const save = new SaveWorkingCopyAction(
    changeSets,
    locks,
    copies,
    open,
    branches,
    unit,
    assets,
    readable,
    new FakeRefreshConflicts(),
  );
  const head = () => branches.heads.get(mine.branch) as string;
  const file = async (path: string) => {
    const bytes = await (
      repository.branches.get(mine.branch) as FakeSnapshot
    ).file(path);
    return bytes && new TextDecoder().decode(bytes);
  };
  return {
    mine,
    repository,
    branches,
    changeSets,
    locks,
    copies,
    audit,
    commits,
    intents,
    unit,
    lock,
    head,
    file,
    /** Saves `content` as the next version of the subject's working copy. */
    saved: async (subject: LockSubject, content: WorkingCopyContent) => {
      const version = (await copies.find(id, subject))?.version ?? 0;
      return save.handle({
        actor: author,
        changeSetId: id,
        subject,
        content,
        version,
      });
    },
    save,
    assets,
    commit: new CommitWorkingCopiesAction(
      changeSets,
      locks,
      copies,
      branches,
      recorder,
      intents,
      open,
      unit,
      readable,
    ),
    revert: new RevertChangesAction(
      changeSets,
      locks,
      copies,
      branches,
      recorder,
      intents,
      open,
      audit,
      unit,
    ),
    reconcile: new ReconcileChangeSetCommitsAction(
      branches,
      changeSets,
      commits,
      intents,
      recorder,
      open,
      unit,
    ),
  };
}

const text = (t: string, id = 'charging'): Module => module(id, 'en', t);
const actions = (events: readonly { action: string }[]) =>
  events.map((e) => e.action);

describe('an author without content.read.draft (#126)', () => {
  const plain: Actor = {
    ...actorWith(['content.read', 'content.edit']),
    id: author.id,
  };
  const save = (
    s: ReturnType<typeof setUp>,
    subject: LockSubject,
    content: WorkingCopyContent,
    at: { version: number; baseCommit?: string },
  ) =>
    s.save.handle({
      actor: plain,
      changeSetId: s.mine.id,
      subject,
      content,
      ...at,
    });

  it('saves and commits on their own branch once it moved, based on its own earlier commits', async () => {
    const s = setUp({ modules: [text('A.'), text('B.', 'safety')] });
    const base = s.head();
    s.lock(charging);
    s.lock(safety);
    await save(s, charging, text('A2.'), { version: 0 });
    await save(s, safety, text('B2.', 'safety'), { version: 0 });
    const first = await s.commit.handle({
      actor: plain,
      changeSetId: s.mine.id,
      subjects: [charging],
    });
    expect(first.written).toEqual([charging]);
    // The branch moved past its base: a draft. Safety's working copy is
    // still based on the base commit, which this author cannot open by its
    // ID: their branch's own history says the file did not change since.
    expect(s.head()).not.toBe(base);
    const second = await s.commit.handle({
      actor: plain,
      changeSetId: s.mine.id,
    });
    expect(second.written).toEqual([safety]);
    expect(second.parent).toBe(first.commit);
  });

  it('is told a working copy is stale when its own branch changed the file since', async () => {
    const s = setUp({ modules: [text('A.')] });
    const base = s.head();
    s.lock(charging);
    await save(s, charging, text('A2.'), { version: 0 });
    await s.commit.handle({ actor: plain, changeSetId: s.mine.id });
    const stale = await save(s, charging, text('A3.'), {
      version: 0,
      baseCommit: base,
    }).catch((e: unknown) => e);
    expect(stale).toMatchObject({ code: 'stale-working-copy' });
    // Draft commits outside the branch's own work are no base either, even
    // with the file the same there: another branch's commit, and one from
    // before the change set's base commit.
    const elsewhere = new FakeSnapshot({ modules: [text('A2.')] });
    s.repository.commits.set(elsewhere.commit, elsewhere);
    const before = new FakeSnapshot({ modules: [text('A2.')] });
    s.repository.commits.set(before.commit, before);
    s.branches.commits.set(base, {
      branch: 'draft',
      parent: before.commit,
      changes: [],
      tree: s.branches.treeOf(before.commit),
      message: 'Before the change set.',
      author: { kind: 'user', id: 'sample-other' },
      changeSetId: s.mine.id,
    });
    for (const baseCommit of [elsewhere.commit, before.commit]) {
      const refused = await save(s, charging, text('A2.'), {
        version: 0,
        baseCommit,
      }).catch((e: unknown) => e);
      expect([baseCommit, refused]).toMatchObject([
        baseCommit,
        { code: 'stale-working-copy' },
      ]);
    }
    // The head itself is fine.
    const ok = await save(s, charging, text('A2.'), {
      version: 0,
      baseCommit: s.head(),
    });
    expect(ok.version).toBe(1);
  });

  it('cannot open, save or commit another author’s change set: not found, like a missing one', async () => {
    const s = setUp({ modules: [text('A.')] });
    s.lock(charging);
    const stranger: Actor = { ...plain, id: 'sample-stranger' };
    const refused = await s.save
      .handle({
        actor: stranger,
        changeSetId: s.mine.id,
        subject: charging,
        content: text('X.'),
        version: 0,
      })
      .catch((e: unknown) => e);
    expect(refused).toMatchObject({
      code: 'not-found',
      message: `No change set "${s.mine.id}".`,
    });
    const commit = await s.commit
      .handle({ actor: stranger, changeSetId: s.mine.id })
      .catch((e: unknown) => e);
    expect(commit).toMatchObject({
      code: 'not-found',
      message: `No change set "${s.mine.id}".`,
    });
  });
});

describe('CommitWorkingCopiesAction', () => {
  describe('the files a module names (#335)', () => {
    const image = (hash: string): Module => ({
      ...text('With a picture.'),
      blocks: [{ type: 'image', id: 'i', asset: `sha256:${hash}`, alt: 'x' }],
    });
    /** Stored as a save before #335 would have: unchecked. */
    const unchecked = (s: ReturnType<typeof setUp>, content: Module) =>
      s.unit.run((tx) =>
        s.copies.save(
          tx,
          {
            changeSetId: s.mine.id,
            subject: charging,
            content,
            baseCommit: s.head(),
            updatedBy: { kind: 'user', id: author.id },
          },
          0,
        ),
      );

    it('refuses a working copy naming a file the author may not read, stored or not, and commits nothing', async () => {
      const s = setUp({ modules: [text('Committed.')] });
      s.lock(charging);
      const others = '1'.repeat(64);
      const otherSet = newChangeSetId();
      s.assets.authors.set(otherSet, { kind: 'user', id: 'sample-other' });
      await s.unit.run((tx) =>
        s.assets.record(tx, {
          changeSetId: otherSet,
          sha256: others,
          size: 1,
          contentType: 'image/png',
          uploadedBy: { kind: 'user', id: 'sample-other' },
        }),
      );
      const head = s.head();
      for (const hash of [others, '2'.repeat(64)]) {
        s.copies.copies.clear();
        await unchecked(s, image(hash));
        await expect(
          s.commit.handle({ actor: author, changeSetId: s.mine.id }),
        ).rejects.toMatchObject({
          code: 'unknown-asset',
          meta: { assets: [`sha256:${hash}`] },
        });
      }
      expect(s.head()).toBe(head);
    });

    it('commits one the author uploaded into the change set, or one the branch uses', async () => {
      const onBranch = 'b'.repeat(64);
      const s = setUp({
        modules: [text('Committed.'), { ...image(onBranch), id: 'safety' }],
      });
      s.lock(charging);
      const own = 'd'.repeat(64);
      await s.unit.run((tx) =>
        s.assets.record(tx, {
          changeSetId: s.mine.id,
          sha256: own,
          size: 1,
          contentType: 'image/png',
          uploadedBy: { kind: 'user', id: author.id },
        }),
      );
      await s.saved(charging, {
        ...image(own),
        blocks: [
          ...image(own).blocks,
          { ...image(onBranch).blocks[0]!, id: 'j' },
        ],
      });
      const outcome = await s.commit.handle({
        actor: author,
        changeSetId: s.mine.id,
      });
      expect(outcome.written).toEqual([charging]);
    });
  });

  it('commits a working copy printed canonically, drops it and records the commit', async () => {
    const s = setUp({ modules: [text('Committed.')] });
    s.lock(charging);
    await s.saved(charging, text('Edited.'));
    const parent = s.head();

    const outcome = await s.commit.handle({
      actor: author,
      changeSetId: s.mine.id,
    });

    expect(outcome).toEqual({
      changeSetId: s.mine.id,
      branch: s.mine.branch,
      commit: s.head(),
      parent,
      message: 'Update module en/charging',
      written: [charging],
      deleted: [],
      unchanged: [],
    });
    const made = s.branches.commits.get(s.head());
    expect(made).toMatchObject({
      parent,
      author: { kind: 'user', id: 'sample-author' },
      changeSetId: s.mine.id,
      changes: [
        {
          path: 'modules/en/charging.adoc',
          content: printModule(text('Edited.')),
        },
      ],
    });
    const written = await s.file('modules/en/charging.adoc');
    expect(printModule(parseModule(written ?? '', { id: 'charging' }))).toBe(
      written,
    );
    expect(await s.copies.find(s.mine.id, charging)).toBeUndefined();
    expect(s.commits.records.map((r) => r.commit)).toEqual([s.head()]);
    expect(actions(s.audit.events)).toEqual([
      'change-set.commit',
      'module.write',
    ]);
    expect(s.audit.events[0]).toMatchObject({
      actor: { kind: 'user', id: 'sample-author' },
      subject: { type: 'change-set', id: s.mine.id },
      data: { commit: s.head(), parent, written: 1, deleted: 0 },
    });
    expect(s.audit.events[1]).toMatchObject({
      subject: { type: 'module', id: 'en/charging' },
      data: { changeSetId: s.mine.id, commit: s.head() },
    });
  });

  it('commits several working copies and deletions in one commit, or only those listed', async () => {
    const s = setUp({
      modules: [text('A.'), text('B.', 'safety'), text('Old.', 'old')],
      manifests: [manifest('operating', ['charging'])],
    });
    const old: LockSubject = { type: 'module', lang: 'en', moduleId: 'old' };
    for (const subject of [charging, safety, operating, old]) s.lock(subject);
    await s.saved(charging, text('A2.'));
    await s.saved(safety, text('B2.', 'safety'));
    await s.saved(operating, {
      ...manifest('operating', ['charging', 'safety']),
    } as Manifest);

    // Only the listed one.
    const first = await s.commit.handle({
      actor: author,
      changeSetId: s.mine.id,
      subjects: [safety],
      message: 'Safety first',
    });
    expect(first).toMatchObject({ written: [safety], message: 'Safety first' });
    expect(await s.copies.find(s.mine.id, charging)).toBeDefined();
    expect(s.audit.events[0]).toMatchObject({ comment: 'Safety first' });

    // The rest, with a deletion.
    const second = await s.commit.handle({
      actor: author,
      changeSetId: s.mine.id,
      deletes: [old],
    });
    expect(second).toMatchObject({
      parent: first.commit,
      written: [operating, charging],
      deleted: [old],
      message: 'Update 2 and delete 1 modules and manuals',
    });
    expect(s.branches.commits.get(s.head())?.changes).toHaveLength(3);
    expect(await s.file('modules/en/old.adoc')).toBeUndefined();
    expect(await s.file('manuals/operating.yaml')).toContain('safety');
    expect(s.copies.copies.size).toBe(0);
    expect(actions(s.audit.events).slice(2)).toEqual([
      'change-set.commit',
      'manual.write',
      'module.write',
      'module.delete',
    ]);
  });

  it('commits a template file’s text as it is, a new one and a deletion, under their locks (#396)', async () => {
    const s = setUp({
      designTemplates: {
        house: {
          'manual.typ': '#import "old.typ": *\n',
          'old.typ': '#let x = 1\n',
          'logo.png': new Uint8Array([1, 2, 3]),
        },
      },
    });
    const entry: LockSubject = {
      type: 'template',
      templateId: 'house',
      path: 'manual.typ',
    };
    const added: LockSubject = {
      type: 'template',
      templateId: 'house',
      path: 'parts/notice.typ',
    };
    const old: LockSubject = {
      type: 'template',
      templateId: 'house',
      path: 'old.typ',
    };
    for (const subject of [entry, added, old]) s.lock(subject);
    // Not trimmed, not reformatted: the file holds exactly the text.
    const manual = '#import "parts/notice.typ": *\r\n  // ünïcode  \n\n';
    await s.saved(entry, { schemaVersion: 1, text: manual });
    await s.saved(added, { schemaVersion: 1, text: '#let notice = 2' });
    const outcome = await s.commit.handle({
      actor: author,
      changeSetId: s.mine.id,
      deletes: [old],
    });
    expect(outcome).toMatchObject({
      written: [entry, added],
      deleted: [old],
      message: 'Update 2 and delete 1 files',
    });
    expect(await s.file('templates/house/manual.typ')).toBe(manual);
    expect(await s.file('templates/house/parts/notice.typ')).toBe(
      '#let notice = 2',
    );
    expect(await s.file('templates/house/old.typ')).toBeUndefined();
    // The template's other files stay as they are.
    expect(await s.file('templates/house/logo.png')).toBeDefined();
    expect(actions(s.audit.events)).toEqual([
      'change-set.commit',
      'template.write',
      'template.write',
      'template.delete',
    ]);
    expect(s.audit.events[1]).toMatchObject({
      subject: { type: 'template', id: 'house/manual.typ' },
    });
  });

  it('commits a template file only for one who may change page designs, under its lock (#396)', async () => {
    const s = setUp({
      designTemplates: { house: { 'manual.typ': '// a\n' } },
    });
    const entry: LockSubject = {
      type: 'template',
      templateId: 'house',
      path: 'manual.typ',
    };
    await expect(
      s.saved(entry, { schemaVersion: 1, text: '// b\n' }),
    ).rejects.toMatchObject({ code: 'lock-required' });
    s.lock(entry);
    await s.saved(entry, { schemaVersion: 1, text: '// b\n' });
    await expect(
      s.commit.handle({
        actor: editor({ languages: ['en'] }),
        changeSetId: s.mine.id,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await s.file('templates/house/manual.typ')).toBe('// a\n');
  });

  it('makes no commit for unchanged content, and drops the working copy', async () => {
    const s = setUp({ modules: [text('Same.')] });
    s.lock(charging);
    await s.saved(charging, text('Same.'));
    const head = s.head();
    expect(
      await s.commit.handle({ actor: author, changeSetId: s.mine.id }),
    ).toEqual({
      changeSetId: s.mine.id,
      branch: s.mine.branch,
      parent: head,
      written: [],
      deleted: [],
      unchanged: [charging],
    });
    expect(s.head()).toBe(head);
    expect(s.branches.commits.size).toBe(0);
    expect(s.copies.copies.size).toBe(0);
    expect(s.audit.events).toEqual([]);
    // Nothing at all to commit: no commit either.
    const nothing = await s.commit.handle({
      actor: author,
      changeSetId: s.mine.id,
    });
    expect(nothing).toMatchObject({ unchanged: [] });
    expect(nothing.commit).toBeUndefined();
  });

  it('refuses invalid content with every problem, naming the subject and block', async () => {
    const s = setUp({ modules: [text('A.'), text('B.', 'safety')] });
    s.lock(charging);
    s.lock(safety);
    const broken = text('Broken.');
    await s.saved(charging, {
      ...broken,
      meta: { ...broken.meta, type: 'nope' },
      blocks: [
        {
          type: 'variant',
          id: 'v',
          when: { op: 'in', attr: 'nope', values: ['x'] },
          blocks: broken.blocks,
        },
      ],
    } as Module);
    await s.saved(safety, text('Fine.', 'safety'));
    const head = s.head();
    const refused = await s.commit
      .handle({ actor: author, changeSetId: s.mine.id })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(UnprocessableProblems);
    const problems = (refused as UnprocessableProblems).problems;
    expect((refused as UnprocessableProblems).code).toBe(
      'invalid-working-copy',
    );
    expect(problems.length).toBeGreaterThanOrEqual(2);
    expect(problems.map((p) => p.pointer)).toEqual(
      expect.arrayContaining([
        '/module/en/charging',
        '/module/en/charging/blocks/v',
      ]),
    );
    expect(problems.every((p) => p.meta?.['subject'])).toBe(true);
    expect(s.head()).toBe(head);
    expect(s.copies.copies.size).toBe(2);
  });

  it('refuses a manifest that cannot be stored yet (no entries)', async () => {
    const s = setUp({ manifests: [manifest('operating', ['charging'])] });
    s.lock(operating);
    await s.saved(operating, { ...manifest('operating', []), entries: [] });
    await expect(
      s.commit.handle({ actor: author, changeSetId: s.mine.id }),
    ).rejects.toMatchObject({
      problems: [
        expect.objectContaining({
          pointer: '/manual/operating',
          meta: expect.objectContaining({ issue: 'not-a-manifest' }),
        }),
      ],
    });
  });

  it('needs the lock still held, and a draft', async () => {
    const s = setUp({ modules: [text('A.')] });
    s.lock(charging);
    await s.saved(charging, text('B.'));
    s.locks.locks.length = 0;
    await expect(
      s.commit.handle({ actor: author, changeSetId: s.mine.id }),
    ).rejects.toMatchObject({
      code: 'lock-required',
      meta: { subject: charging },
    });
    await expect(
      s.commit.handle({
        actor: author,
        changeSetId: s.mine.id,
        deletes: [safety],
        subjects: [],
      }),
    ).rejects.toMatchObject({ code: 'lock-required' });

    s.lock(charging);
    s.changeSets.changeSets[0] = { ...s.mine, state: 'abandoned' };
    await expect(
      s.commit.handle({ actor: author, changeSetId: s.mine.id }),
    ).rejects.toMatchObject({
      code: 'invalid-state',
      meta: { state: 'abandoned' },
    });
    expect(s.branches.commits.size).toBe(0);
  });

  it('is the author’s alone', async () => {
    const s = setUp({ modules: [text('A.')] });
    await expect(
      s.commit.handle({
        actor: editor({}, 'sample-other'),
        changeSetId: s.mine.id,
      }),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      s.commit.handle({
        actor: { ...actorWith(['content.edit', 'content.read']), id: 'x' },
        changeSetId: s.mine.id,
      }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      s.commit.handle({ actor: author, changeSetId: newChangeSetId() }),
    ).rejects.toThrow(NotFoundError);
  });

  it('checks scope again with the actor’s current roles', async () => {
    const s = setUp({ modules: [text('A.')] });
    s.lock(charging);
    await s.saved(charging, text('B.'));
    // The author's role now covers German only.
    const narrowed = { ...author, roles: editor({ languages: ['de'] }).roles };
    await expect(
      s.commit.handle({ actor: narrowed, changeSetId: s.mine.id }),
    ).rejects.toThrow(ForbiddenError);
    expect(s.branches.commits.size).toBe(0);
  });

  it('answers a delete of a hidden module and of a missing one alike', async () => {
    const internal = text('Secret.', 'secret');
    const s = setUp({
      modules: [
        { ...internal, meta: { ...internal.meta, audience: 'internal' } },
      ],
    });
    const scoped = editor({ maxAudience: 'public' });
    const secret: LockSubject = {
      type: 'module',
      lang: 'en',
      moduleId: 'secret',
    };
    const missing: LockSubject = {
      type: 'module',
      lang: 'en',
      moduleId: 'missing',
    };
    s.lock(secret);
    s.lock(missing);
    const refusal = (subject: LockSubject) =>
      s.commit
        .handle({ actor: scoped, changeSetId: s.mine.id, deletes: [subject] })
        .catch((e: unknown) => e as ForbiddenError);
    const [hidden, gone] = [await refusal(secret), await refusal(missing)];
    expect(hidden).toBeInstanceOf(ForbiddenError);
    expect(gone).toBeInstanceOf(ForbiddenError);
    expect(hidden.message).toBe(gone.message);
    // One who sees all of the language is told there is nothing to delete.
    await expect(
      s.commit.handle({
        actor: author,
        changeSetId: s.mine.id,
        deletes: [missing],
      }),
    ).rejects.toMatchObject({ code: 'nothing-to-delete' });
  });

  it('refuses a working copy whose file changed on the branch since its base', async () => {
    const s = setUp({ modules: [text('A.'), text('S.', 'safety')] });
    s.lock(charging);
    s.lock(safety);
    // Read at the start, saved later: based on the first commit.
    const base = s.head();
    await s.saved(charging, text('Mine.'));
    await s.saved(safety, text('S2.', 'safety'));
    // Another tab commits the module meanwhile, then saves on top of the old read.
    await s.commit.handle({
      actor: author,
      changeSetId: s.mine.id,
      subjects: [charging],
    });
    await s.save
      .handle({
        actor: author,
        changeSetId: s.mine.id,
        subject: charging,
        content: text('Stale tab.'),
        version: 0,
        baseCommit: base,
      })
      .then(
        () => expect.unreachable('a stale save is refused'),
        (e: unknown) =>
          expect(e).toMatchObject({
            code: 'stale-working-copy',
            meta: { subjects: [charging], head: s.head() },
          }),
      );
    // The safety module's file did not change: its old base is fine.
    expect(
      await s.commit.handle({ actor: author, changeSetId: s.mine.id }),
    ).toMatchObject({ written: [safety] });
  });

  it('refuses a stale working copy at commit time too', async () => {
    const s = setUp({ modules: [text('A.')] });
    s.lock(charging);
    await s.saved(charging, text('Mine.'));
    // The file changes on the branch (a commit made elsewhere).
    const moved = new FakeSnapshot({ modules: [text('Theirs.')] });
    s.repository.branches.set(s.mine.branch, moved);
    s.repository.commits.set(moved.commit, moved);
    s.branches.heads.set(s.mine.branch, moved.commit);
    await expect(
      s.commit.handle({ actor: author, changeSetId: s.mine.id }),
    ).rejects.toMatchObject({
      code: 'stale-working-copy',
      meta: { subjects: [charging], head: moved.commit },
    });
    expect(await s.file('modules/en/charging.adoc')).toContain('Theirs.');
    // Saved again with the head as its base (merged by the editor): committed.
    const copy = await s.copies.find(s.mine.id, charging);
    await s.save.handle({
      actor: author,
      changeSetId: s.mine.id,
      subject: charging,
      content: text('Merged.'),
      version: copy?.version ?? 0,
      baseCommit: moved.commit,
    });
    expect(
      await s.commit.handle({ actor: author, changeSetId: s.mine.id }),
    ).toMatchObject({ written: [charging] });
  });

  it('tries a moved branch once more, then answers 409', async () => {
    const s = setUp({ modules: [text('A.')] });
    s.lock(charging);
    await s.saved(charging, text('B.'));
    let moves = 1;
    s.branches.beforeCommit = (name) => {
      if (moves-- > 0) s.branches.heads.set(name, 'e'.repeat(40));
    };
    // Moved once (and back, as if the first try raced a stale read): retried.
    const original = s.head();
    s.branches.beforeCommit = (name) => {
      if (moves-- > 0) s.branches.heads.set(name, 'e'.repeat(40));
      else s.branches.heads.set(name, original);
    };
    expect(
      await s.commit.handle({ actor: author, changeSetId: s.mine.id }),
    ).toMatchObject({ written: [charging] });

    await s.saved(charging, text('C.'));
    s.branches.beforeCommit = (name) =>
      s.branches.heads.set(name, 'e'.repeat(40));
    await expect(
      s.commit.handle({ actor: author, changeSetId: s.mine.id }),
    ).rejects.toMatchObject({
      code: 'branch-moved',
      meta: { head: 'e'.repeat(40) },
    });
    expect(await s.copies.find(s.mine.id, charging)).toBeDefined();
  });

  it('recovers a commit whose recording failed: the next commit and the reconciler record it', async () => {
    const s = setUp({ modules: [text('A.'), text('S.', 'safety')] });
    s.lock(charging);
    s.lock(safety);
    await s.saved(charging, text('Landed.'));
    s.audit.failing = true;
    await expect(
      s.commit.handle({ actor: author, changeSetId: s.mine.id }),
    ).rejects.toThrow('the database is down');
    // In Git, but not recorded; the working copy is still there.
    const landed = s.head();
    expect(s.branches.commits.has(landed)).toBe(true);
    expect(s.commits.records).toEqual([]);
    expect(s.audit.events).toEqual([]);
    expect(await s.copies.find(s.mine.id, charging)).toBeDefined();
    s.audit.failing = false;

    // The reconciler records it from its commit intent and drops the
    // working copy, which holds exactly what landed.
    const report = await s.reconcile.handle();
    expect(report).toMatchObject({
      recovered: [landed],
      dropped: 1,
      failed: [],
    });
    expect(s.commits.records).toEqual([
      expect.objectContaining({
        commit: landed,
        actor: { kind: 'user', id: 'sample-author' },
        written: [charging],
      }),
    ]);
    expect(s.audit.events[0]).toMatchObject({
      action: 'change-set.commit',
      data: { commit: landed, recovered: true },
    });
    expect(await s.copies.find(s.mine.id, charging)).toBeUndefined();
    // Run again: nothing more to do.
    expect(await s.reconcile.handle()).toMatchObject({
      recovered: [],
      unrecorded: [],
    });

    // A failed recording caught up by the next commit instead.
    await s.saved(safety, text('S2.', 'safety'));
    s.audit.failing = true;
    await expect(
      s.commit.handle({ actor: author, changeSetId: s.mine.id }),
    ).rejects.toThrow();
    const second = s.head();
    s.audit.failing = false;
    await s.saved(charging, text('Again.'));
    const third = await s.commit.handle({
      actor: author,
      changeSetId: s.mine.id,
    });
    // Catching up dropped the working copy the second commit consumed.
    expect(third).toMatchObject({
      parent: second,
      written: [charging],
      unchanged: [],
    });
    expect(await s.copies.find(s.mine.id, safety)).toBeUndefined();
    expect(s.commits.records.map((r) => r.commit)).toEqual([
      landed,
      second,
      third.commit,
    ]);
  });

  it('leaves a working copy saved after a failed recording that differs from what landed', async () => {
    const s = setUp({ modules: [text('A.')] });
    s.lock(charging);
    await s.saved(charging, text('Landed.'));
    s.audit.failing = true;
    await expect(
      s.commit.handle({ actor: author, changeSetId: s.mine.id }),
    ).rejects.toThrow();
    const landed = s.head();
    s.audit.failing = false;
    await s.saved(charging, text('Typed on.'));
    expect(await s.reconcile.handle()).toMatchObject({ dropped: 0 });
    const kept = await s.copies.find(s.mine.id, charging);
    expect(kept).toMatchObject({
      content: text('Typed on.'),
      // Moved on to what landed, one version further: not stale for good.
      baseCommit: landed,
      version: 3,
    });
    const next = await s.commit.handle({
      actor: author,
      changeSetId: s.mine.id,
    });
    expect(next).toMatchObject({ parent: landed, written: [charging] });
    expect(next.commit).toBeDefined();
  });

  it('moves a working copy saved after a failed recording on when the next commit catches up', async () => {
    const s = setUp({ modules: [text('A.')] });
    s.lock(charging);
    await s.saved(charging, text('Landed.'));
    s.audit.failing = true;
    await expect(
      s.commit.handle({ actor: author, changeSetId: s.mine.id }),
    ).rejects.toThrow();
    const landed = s.head();
    s.audit.failing = false;
    await s.saved(charging, text('Typed on.'));
    const next = await s.commit.handle({
      actor: author,
      changeSetId: s.mine.id,
    });
    expect(next).toMatchObject({ parent: landed, written: [charging] });
    expect(s.commits.records.map((r) => r.commit)).toEqual([
      landed,
      next.commit,
    ]);
  });

  it('moves on a working copy whose base is older than the parent of a recovered commit', async () => {
    const s = setUp({ modules: [text('A.'), text('S.', 'safety')] });
    s.lock(charging);
    s.lock(safety);
    // Saved on the change set's base, then another subject is committed.
    await s.saved(charging, text('Landed.'));
    await s.saved(safety, text('S2.', 'safety'));
    await s.commit.handle({
      actor: author,
      changeSetId: s.mine.id,
      subjects: [safety],
    });
    expect((await s.copies.find(s.mine.id, charging))?.baseCommit).toBe(
      s.mine.baseCommit,
    );
    s.audit.failing = true;
    await expect(
      s.commit.handle({ actor: author, changeSetId: s.mine.id }),
    ).rejects.toThrow();
    const landed = s.head();
    s.audit.failing = false;
    await s.saved(charging, text('Typed on.'));
    const next = await s.commit.handle({
      actor: author,
      changeSetId: s.mine.id,
    });
    expect(next).toMatchObject({ parent: landed, written: [charging] });
  });

  it('refuses a subject named twice, or both committed and deleted', async () => {
    const s = setUp({ modules: [text('A.')] });
    await expect(
      s.commit.handle({
        actor: author,
        changeSetId: s.mine.id,
        subjects: [charging, { ...charging }],
      }),
    ).rejects.toMatchObject({ code: 'duplicate-subject' });
    await expect(
      s.commit.handle({
        actor: author,
        changeSetId: s.mine.id,
        subjects: [charging],
        deletes: [charging],
      }),
    ).rejects.toThrow(UnprocessableError);
  });

  it('a save stores the head as its base when the file is unchanged since the base named', async () => {
    const s = setUp({ modules: [text('A.'), text('S.', 'safety')] });
    s.lock(charging);
    s.lock(safety);
    const base = s.head();
    await s.saved(safety, text('S2.', 'safety'));
    await s.commit.handle({ actor: author, changeSetId: s.mine.id });
    const saved = await s.save.handle({
      actor: author,
      changeSetId: s.mine.id,
      subject: charging,
      content: text('B.'),
      version: 0,
      baseCommit: base,
    });
    expect(saved.baseCommit).toBe(s.head());
    // A commit that does not exist is stale, like one the actor may not open.
    await expect(
      s.save.handle({
        actor: author,
        changeSetId: s.mine.id,
        subject: charging,
        content: text('C.'),
        version: 1,
        baseCommit: 'f'.repeat(40),
      }),
    ).rejects.toThrow(ConflictError);
  });
});

describe('translation records at a save point (#51)', () => {
  const german: LockSubject = {
    type: 'module',
    lang: 'de',
    moduleId: 'charging',
  };
  const record = (hash: string): TranslationRecord => ({
    schemaVersion: 1,
    sourceCommit: 'a'.repeat(40),
    blocks: { p: hash },
  });
  const deutsch = (t: string): Module => module('charging', 'de', t);

  it('writes a record beside its module, in the module’s commit, with more of the write in its transaction', async () => {
    const s = setUp({ modules: [text('A.'), deutsch('Alt.')] });
    s.lock(german);
    await s.saved(german, deutsch('Neu.'));
    const after = vi.fn(async () => undefined);
    const outcome = await s.commit.handle({
      actor: author,
      changeSetId: s.mine.id,
      subjects: [german],
      translationRecords: [{ subject: german, record: record('1'.repeat(64)) }],
      after,
    });
    expect(outcome.written).toEqual([german]);
    expect(
      s.branches.commits.get(s.head())?.changes.map((c) => c.path),
    ).toEqual([
      'modules/de/charging.adoc',
      'modules/de/charging.translation.yaml',
    ]);
    expect(await s.file('modules/de/charging.translation.yaml')).toBe(
      printTranslationRecord(record('1'.repeat(64))),
    );
    expect(after).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ commit: s.head() }),
    );
  });

  it('writes a record alone under the module’s lock, and makes no commit for the same record', async () => {
    const s = setUp({
      modules: [text('A.'), deutsch('Alt.')],
      translationRecords: { 'de/charging': record('2'.repeat(64)) },
    });
    const head = s.head();
    // Not locked by the change set: refused.
    await expect(
      s.commit.handle({
        actor: author,
        changeSetId: s.mine.id,
        subjects: [],
        translationRecords: [
          { subject: german, record: record('3'.repeat(64)) },
        ],
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(s.head()).toBe(head);
    s.lock(german);
    const same = await s.commit.handle({
      actor: author,
      changeSetId: s.mine.id,
      subjects: [],
      translationRecords: [{ subject: german, record: record('2'.repeat(64)) }],
    });
    expect(same.commit).toBeUndefined();
    expect(s.head()).toBe(head);
    const changed = await s.commit.handle({
      actor: author,
      changeSetId: s.mine.id,
      subjects: [],
      translationRecords: [{ subject: german, record: record('3'.repeat(64)) }],
    });
    expect(changed.commit).toBe(s.head());
    expect(
      s.branches.commits.get(s.head())?.changes.map((c) => c.path),
    ).toEqual(['modules/de/charging.translation.yaml']);
  });

  it('refuses a record of a module whose working copy stays out of the commit, or that is deleted', async () => {
    const s = setUp({ modules: [text('A.'), deutsch('Alt.')] });
    s.lock(german);
    await s.saved(german, deutsch('Neu.'));
    await expect(
      s.commit.handle({
        actor: author,
        changeSetId: s.mine.id,
        subjects: [],
        translationRecords: [
          { subject: german, record: record('4'.repeat(64)) },
        ],
      }),
    ).rejects.toMatchObject({ code: 'uncommitted-working-copies' });
    s.copies.copies.clear();
    await expect(
      s.commit.handle({
        actor: author,
        changeSetId: s.mine.id,
        subjects: [],
        deletes: [german],
        translationRecords: [
          { subject: german, record: record('4'.repeat(64)) },
        ],
      }),
    ).rejects.toMatchObject({ code: 'duplicate-subject' });
  });

  it('deletes a module’s record with the module, so a module created again there has none (#287)', async () => {
    const s = setUp({
      modules: [text('A.'), deutsch('Alt.'), module('old', 'de', 'Weg.')],
      translationRecords: { 'de/charging': record('6'.repeat(64)) },
    });
    const old: LockSubject = { type: 'module', lang: 'de', moduleId: 'old' };
    s.lock(german);
    s.lock(old);
    const outcome = await s.commit.handle({
      actor: author,
      changeSetId: s.mine.id,
      deletes: [german, old],
    });
    expect(outcome.deleted).toEqual([german, old]);
    expect(
      s.branches.commits.get(s.head())?.changes.map((c) => c.path),
    ).toEqual([
      'modules/de/charging.adoc',
      'modules/de/charging.translation.yaml',
      'modules/de/old.adoc',
    ]);
    expect(await s.file('modules/de/charging.adoc')).toBeUndefined();
    expect(
      await s.file('modules/de/charging.translation.yaml'),
    ).toBeUndefined();

    // Translated again: the new file comes without the old record.
    await s.saved(german, deutsch('Neu.'));
    await s.commit.handle({ actor: author, changeSetId: s.mine.id });
    expect(
      s.branches.commits.get(s.head())?.changes.map((c) => c.path),
    ).toEqual(['modules/de/charging.adoc']);
    expect(
      await s.file('modules/de/charging.translation.yaml'),
    ).toBeUndefined();
  });

  it('counts a deleted module’s record toward the files one commit changes (#287)', async () => {
    const ids = Array.from({ length: MAX_COMMIT_CHANGES }, (_, i) => `m${i}`);
    const s = setUp({
      modules: ids.map((id) => module(id, 'de', 'Weg.')),
      translationRecords: { 'de/m0': record('7'.repeat(64)) },
    });
    const deletes: LockSubject[] = ids.map((moduleId) => ({
      type: 'module',
      lang: 'de',
      moduleId,
    }));
    for (const subject of deletes) s.lock(subject);
    const head = s.head();
    await expect(
      s.commit.handle({ actor: author, changeSetId: s.mine.id, deletes }),
    ).rejects.toMatchObject({ code: 'too-many-changes' });
    expect(s.head()).toBe(head);
  });

  it('checks the module’s scope for its record', async () => {
    const s = setUp({ modules: [text('A.'), deutsch('Alt.')] });
    s.lock(german);
    await expect(
      s.commit.handle({
        actor: editor({ languages: ['en'] }),
        changeSetId: s.mine.id,
        subjects: [],
        translationRecords: [
          { subject: german, record: record('5'.repeat(64)) },
        ],
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('recovery trusts commit intents only (#154)', () => {
  /** A crash between Git and the database: the commit lands, unrecorded. */
  async function crashed(s: ReturnType<typeof setUp>) {
    s.audit.failing = true;
    await expect(
      s.commit.handle({ actor: author, changeSetId: s.mine.id }),
    ).rejects.toThrow('the database is down');
    s.audit.failing = false;
    return s.head();
  }

  it('records a crashed commit exactly once, from its intent, and consumes the intent', async () => {
    const s = setUp({ modules: [text('A.')] });
    s.lock(charging);
    await s.saved(charging, text('Landed.'));
    const landed = await crashed(s);
    expect(s.intents.intents).toEqual([
      expect.objectContaining({
        parent: s.mine.baseCommit,
        tree: s.branches.commits.get(landed)?.tree,
        written: [charging],
        consumes: [
          { subject: charging, version: 1, createdAt: expect.any(Date) },
        ],
      }),
    ]);
    const first = await s.reconcile.handle();
    expect(first).toMatchObject({ recovered: [landed], unrecorded: [] });
    expect(s.intents.intents).toEqual([]);
    expect(await s.reconcile.handle()).toMatchObject({ recovered: [] });
    expect(s.commits.records.map((r) => r.commit)).toEqual([landed]);
    expect(
      s.audit.events.filter((e) => e.action === 'change-set.commit'),
    ).toHaveLength(1);
  });

  it('never records a pushed commit with copied trailers and the author’s Git identity', async () => {
    const s = setUp({ modules: [text('A.')] });
    const forged = s.branches.push(s.mine.branch, {
      changes: [
        {
          path: 'modules/en/charging.adoc',
          content: printModule(text('Forged.')),
        },
      ],
      message: 'Looks like a save point',
      author: s.mine.author,
      changeSetId: s.mine.id,
    });
    const report = await s.reconcile.handle();
    expect(report).toMatchObject({
      recovered: [],
      unrecorded: [s.mine.branch],
    });
    expect(s.commits.records).toEqual([]);
    expect(s.audit.events).toEqual([]);
    expect(s.head()).toBe(forged);
  });

  it('never records a pushed commit while an intent is pending, unless it is that intent’s parent and tree', async () => {
    const s = setUp({ modules: [text('A.')] });
    s.lock(charging);
    await s.saved(charging, text('Mine.'));
    // The Git write fails in a way that may have landed: the intent stays.
    s.branches.beforeCommit = () => {
      throw new Error('git died');
    };
    await expect(
      s.commit.handle({ actor: author, changeSetId: s.mine.id }),
    ).rejects.toThrow('git died');
    s.branches.beforeCommit = undefined;
    expect(s.intents.intents).toHaveLength(1);
    // Same parent, other content: another tree. A merge with the intent's
    // very changes: two parents.
    s.branches.push(s.mine.branch, {
      changes: [
        {
          path: 'modules/en/charging.adoc',
          content: printModule(text('Forged.')),
        },
      ],
      message: 'x',
      author: s.mine.author,
      changeSetId: s.mine.id,
    });
    expect(await s.reconcile.handle()).toMatchObject({
      recovered: [],
      unrecorded: [s.mine.branch],
    });
    const t = setUp({ modules: [text('A.')] });
    t.lock(charging);
    await t.saved(charging, text('Mine.'));
    let changes: readonly BranchChange[] = [];
    const prepare = t.branches.prepare.bind(t.branches);
    t.branches.prepare = async (name, request) => {
      changes = request.changes;
      return prepare(name, request);
    };
    t.branches.beforeCommit = () => {
      throw new Error('git died');
    };
    await expect(
      t.commit.handle({ actor: author, changeSetId: t.mine.id }),
    ).rejects.toThrow();
    t.branches.beforeCommit = undefined;
    const merge = t.branches.push(t.mine.branch, {
      changes,
      message: 'Merge',
      author: t.mine.author,
      changeSetId: t.mine.id,
      mergeOf: 'e'.repeat(40),
    });
    expect(t.branches.commits.get(merge)?.tree).toBe(
      t.intents.intents[0]?.tree,
    );
    expect(await t.reconcile.handle()).toMatchObject({
      recovered: [],
      unrecorded: [t.mine.branch],
    });
    expect(t.commits.records).toEqual([]);
  });

  it('records a save point made on top of a pushed commit, and only that one', async () => {
    const s = setUp({ modules: [text('A.')] });
    s.lock(charging);
    const pushed = s.branches.push(s.mine.branch, {
      changes: [
        {
          path: 'modules/en/other.adoc',
          content: printModule(text('Other.', 'other')),
        },
      ],
      message: 'Pushed',
      author: s.mine.author,
      changeSetId: s.mine.id,
    });
    await s.saved(charging, text('On top.'));
    const landed = await crashed(s);
    expect(s.branches.commits.get(landed)?.parent).toBe(pushed);
    expect(await s.reconcile.handle()).toMatchObject({
      recovered: [landed],
      unrecorded: [s.mine.branch],
    });
    expect(s.commits.records.map((r) => r.commit)).toEqual([landed]);
  });

  it('expires an intent whose commit never landed', async () => {
    const s = setUp({ modules: [text('A.')] });
    s.lock(charging);
    await s.saved(charging, text('Mine.'));
    s.branches.beforeCommit = () => {
      throw new Error('git died');
    };
    await expect(
      s.commit.handle({ actor: author, changeSetId: s.mine.id }),
    ).rejects.toThrow('git died');
    s.branches.beforeCommit = undefined;
    expect(await s.reconcile.handle()).toMatchObject({ expired: 0 });
    expect(s.intents.intents).toHaveLength(1);
    s.intents.age(INTENT_TTL_MS + 1);
    expect(await s.reconcile.handle()).toMatchObject({
      expired: 1,
      recovered: [],
    });
    expect(s.intents.intents).toEqual([]);
    // The working copy is still there, and commits as usual.
    expect(
      await s.commit.handle({ actor: author, changeSetId: s.mine.id }),
    ).toMatchObject({ written: [charging] });
  });

  it('leaves no intent behind after a commit or a moved branch', async () => {
    const s = setUp({ modules: [text('A.')] });
    s.lock(charging);
    await s.saved(charging, text('B.'));
    await s.commit.handle({ actor: author, changeSetId: s.mine.id });
    expect(s.intents.intents).toEqual([]);
    await s.saved(charging, text('C.'));
    s.branches.beforeCommit = (name) =>
      s.branches.heads.set(name, 'e'.repeat(40));
    await expect(
      s.commit.handle({ actor: author, changeSetId: s.mine.id }),
    ).rejects.toMatchObject({ code: 'branch-moved' });
    expect(s.intents.intents).toEqual([]);
  });
});

describe('preflight outside the transaction (#155)', () => {
  it('holds no transaction while it validates, prints and builds the tree; the row only for the write', async () => {
    const s = setUp({
      modules: Array.from({ length: 50 }, (_, i) => text('A.', `m${i}`)),
    });
    const subjects = Array.from({ length: 50 }, (_, i): LockSubject => ({
      type: 'module',
      lang: 'en',
      moduleId: `m${i}`,
    }));
    for (const subject of subjects) {
      s.lock(subject);
      await s.saved(
        subject,
        text('Changed.', (subject as { moduleId: string }).moduleId),
      );
    }
    const seen: string[] = [];
    const prepare = s.branches.prepare.bind(s.branches);
    s.branches.prepare = async (name, request) => {
      seen.push(`prepare:${s.unit.active}`);
      return prepare(name, request);
    };
    s.branches.beforeCommit = () => seen.push(`commit:${s.unit.active}`);
    const lock = s.changeSets.lock.bind(s.changeSets);
    s.changeSets.lock = async (tx, id) => {
      seen.push(`row:${s.unit.active}`);
      return lock(tx, id);
    };
    const runs = s.unit.runs.length;
    const outcome = await s.commit.handle({
      actor: author,
      changeSetId: s.mine.id,
    });
    expect(outcome.written).toHaveLength(50);
    // The tree is built with no transaction open; the row is locked once,
    // in the transaction that makes the Git commit.
    expect(seen).toEqual(['prepare:0', 'row:1', 'commit:1']);
    // Read, intent, write: all bounded.
    expect(s.unit.runs.slice(runs)).toEqual([
      { bounded: true },
      { bounded: true },
      { bounded: true },
    ]);
  });

  it('tries again when a working copy moved after the preflight, then answers 409', async () => {
    const s = setUp({ modules: [text('A.')] });
    s.lock(charging);
    await s.saved(charging, text('B.'));
    let saves = 1;
    const prepare = s.branches.prepare.bind(s.branches);
    s.branches.prepare = async (name, request) => {
      const tree = await prepare(name, request);
      if (saves-- > 0) await s.saved(charging, text('Typed on.'));
      return tree;
    };
    const once = await s.commit.handle({
      actor: author,
      changeSetId: s.mine.id,
    });
    expect(await s.file('modules/en/charging.adoc')).toContain('Typed on.');
    expect(once.written).toEqual([charging]);
    expect(s.intents.intents).toEqual([]);

    await s.saved(charging, text('C.'));
    s.branches.prepare = async (name, request) => {
      const tree = await prepare(name, request);
      await s.saved(charging, text(`D${Math.random()}.`));
      return tree;
    };
    await expect(
      s.commit.handle({ actor: author, changeSetId: s.mine.id }),
    ).rejects.toMatchObject({
      code: 'working-copy-changed',
      meta: { subjects: [charging] },
    });
    expect(s.intents.intents).toEqual([]);
    expect(s.commits.records).toHaveLength(1);
  });

  it('checks the state and the locks again under the row lock', async () => {
    const s = setUp({ modules: [text('A.')] });
    s.lock(charging);
    await s.saved(charging, text('B.'));
    const prepare = s.branches.prepare.bind(s.branches);
    s.branches.prepare = async (name, request) => {
      const tree = await prepare(name, request);
      s.locks.locks.length = 0;
      return tree;
    };
    await expect(
      s.commit.handle({ actor: author, changeSetId: s.mine.id }),
    ).rejects.toMatchObject({ code: 'lock-required' });
    expect(s.head()).toBe(s.mine.baseCommit);
    expect(s.intents.intents).toEqual([]);
  });
});

describe('a working copy discarded and saved again is another copy (review round 1)', () => {
  const discard = (s: ReturnType<typeof setUp>, subject: LockSubject) =>
    s.unit.run((tx) => s.copies.remove(tx, s.mine.id, subject));

  it('is never dropped by a commit prepared from the copy before it', async () => {
    const s = setUp({ modules: [text('A.')] });
    s.lock(charging);
    await s.saved(charging, text('Old.'));
    let once = true;
    const prepare = s.branches.prepare.bind(s.branches);
    s.branches.prepare = async (name, request) => {
      const tree = await prepare(name, request);
      if (once) {
        once = false;
        // Back at version 1, with other content.
        await discard(s, charging);
        expect((await s.saved(charging, text('New.'))).version).toBe(1);
      }
      return tree;
    };
    await s.commit.handle({ actor: author, changeSetId: s.mine.id });
    // Tried again from the preflight: what is committed is the new copy.
    expect(await s.file('modules/en/charging.adoc')).toContain('New.');
    expect(await s.file('modules/en/charging.adoc')).not.toContain('Old.');
  });

  it('is never dropped by recovery of a commit made from the copy before it', async () => {
    const s = setUp({ modules: [text('A.')] });
    s.lock(charging);
    await s.saved(charging, text('Landed.'));
    s.audit.failing = true;
    await expect(
      s.commit.handle({ actor: author, changeSetId: s.mine.id }),
    ).rejects.toThrow();
    s.audit.failing = false;
    const landed = s.head();
    await discard(s, charging);
    expect((await s.saved(charging, text('Retyped.'))).version).toBe(1);
    expect(await s.reconcile.handle()).toMatchObject({ recovered: [landed] });
    expect(await s.copies.find(s.mine.id, charging)).toMatchObject({
      content: text('Retyped.'),
    });
  });

  it('drops an unchanged copy only while the branch is still where it was checked', async () => {
    const s = setUp({ modules: [text('A.')] });
    s.lock(charging);
    await s.saved(charging, text('A.'));
    const read = s.repository.branches.get(s.mine.branch) as FakeSnapshot;
    const prepareSpy = vi.fn();
    s.branches.prepare = prepareSpy;
    // Between the preflight's read and the write: a push changes the file.
    const sizesOf = s.copies.sizesOf.bind(s.copies);
    let calls = 0;
    s.copies.sizesOf = async (tx, id) => {
      if (++calls === 2) {
        s.branches.push(s.mine.branch, {
          changes: [
            {
              path: 'modules/en/charging.adoc',
              content: printModule(text('Pushed.')),
            },
          ],
          message: 'Pushed',
          author: s.mine.author,
          changeSetId: s.mine.id,
        });
      }
      return sizesOf(tx, id);
    };
    await expect(
      s.commit.handle({ actor: author, changeSetId: s.mine.id }),
    ).rejects.toMatchObject({ code: 'stale-working-copy' });
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(read.commit).toBe(s.mine.baseCommit);
    expect(await s.copies.find(s.mine.id, charging)).toMatchObject({
      content: text('A.'),
    });
  });

  it('records a save point under a pushed commit, and still reports the push', async () => {
    const s = setUp({ modules: [text('A.')] });
    s.lock(charging);
    await s.saved(charging, text('Landed.'));
    s.audit.failing = true;
    await expect(
      s.commit.handle({ actor: author, changeSetId: s.mine.id }),
    ).rejects.toThrow();
    s.audit.failing = false;
    const landed = s.head();
    s.branches.push(s.mine.branch, {
      changes: [
        {
          path: 'modules/en/other.adoc',
          content: printModule(text('Other.', 'other')),
        },
      ],
      message: 'Pushed on top',
      author: s.mine.author,
      changeSetId: s.mine.id,
    });
    expect(await s.reconcile.handle()).toMatchObject({
      recovered: [landed],
      unrecorded: [s.mine.branch],
    });
    expect(s.commits.records.map((r) => r.commit)).toEqual([landed]);
  });

  it('expires an intent even when its branch can no longer be read', async () => {
    const s = setUp({ modules: [text('A.')] });
    s.lock(charging);
    await s.saved(charging, text('Mine.'));
    s.branches.beforeCommit = () => {
      throw new Error('git died');
    };
    await expect(
      s.commit.handle({ actor: author, changeSetId: s.mine.id }),
    ).rejects.toThrow('git died');
    s.branches.beforeCommit = undefined;
    s.repository.branches.delete(s.mine.branch);
    s.intents.age(INTENT_TTL_MS + 1);
    const report = await s.reconcile.handle();
    expect(report.expired).toBe(1);
    // The branch is unreadable but still listed: a failure, reported.
    expect(report.failed).toHaveLength(1);
    expect(s.intents.intents).toEqual([]);
  });

  it('expires an intent whose branch is gone, without reporting a failure or asking the database again (#317)', async () => {
    const s = setUp({ modules: [text('A.')] });
    s.lock(charging);
    await s.saved(charging, text('Mine.'));
    s.branches.beforeCommit = () => {
      throw new Error('git died');
    };
    await expect(
      s.commit.handle({ actor: author, changeSetId: s.mine.id }),
    ).rejects.toThrow('git died');
    s.branches.beforeCommit = undefined;
    s.repository.branches.delete(s.mine.branch);
    s.branches.heads.delete(s.mine.branch);
    s.intents.age(INTENT_TTL_MS + 1);
    const asked = vi.spyOn(
      ChangeSetAuthoredBranches.prototype,
      'visibleChangeSet',
    );
    const report = await s.reconcile.handle();
    expect(report).toMatchObject({ expired: 1, failed: [] });
    expect(s.intents.intents).toEqual([]);
    // Under the change set's row lock: no second query.
    expect(asked).not.toHaveBeenCalled();
    asked.mockRestore();
  });
});

describe('the configuration and terms at a save point (#253)', () => {
  /** The change set's author, also holding `admin.roles`: may change the configuration. */
  const admin: Actor = {
    ...actorWith([...EDITING, 'admin.roles']),
    id: author.id,
  };
  const config: LockSubject = { type: 'config' };
  const charger: LockSubject = { type: 'term', termId: 'charger' };
  const withModel = (
    values: { id: string; label: string; archived?: boolean }[],
  ): ProjectConfig => ({
    ...fakeConfig,
    variantAttributes: [{ id: 'model', label: 'Model', kind: 'enum', values }],
  });
  const large = (): Module => ({
    ...module('charging'),
    blocks: [
      {
        type: 'variant',
        id: 'big',
        when: { op: 'in', attr: 'model', values: ['large'] },
        blocks: [
          {
            type: 'paragraph',
            id: 'p',
            content: [{ type: 'text', text: 'Big.' }],
          },
        ],
      },
    ],
  });
  const saveAs = (
    s: ReturnType<typeof setUp>,
    subject: LockSubject,
    content: WorkingCopyContent,
    version = 0,
  ) =>
    s.save.handle({
      actor: admin,
      changeSetId: s.mine.id,
      subject,
      content,
      version,
    });

  it('commits the configuration printed canonically, audited as config.write', async () => {
    const s = setUp({ modules: [large()] });
    s.lock(config);
    await saveAs(
      s,
      config,
      withModel([
        { id: 'small', label: 'Compact' },
        { id: 'large', label: 'Large' },
      ]),
    );
    const outcome = await s.commit.handle({
      actor: admin,
      changeSetId: s.mine.id,
    });
    expect(outcome).toMatchObject({
      written: [config],
      message: 'Update config openfolia.yaml',
    });
    const written = (await s.file('openfolia.yaml')) ?? '';
    expect(written).toContain('label: Compact');
    expect(printConfig(parseConfig(written))).toBe(written);
    expect(actions(s.audit.events)).toEqual([
      'change-set.commit',
      'config.write',
    ]);
    expect(s.audit.events[1]).toMatchObject({
      subject: { type: 'config', id: 'ccms.yaml' },
    });
  });

  it('refuses a configuration that would make content invalid, unless the same commit fixes the content', async () => {
    const s = setUp({ modules: [large()] });
    s.lock(config);
    s.lock(charging);
    const removed = withModel([{ id: 'small', label: 'Small' }]);
    // The working copy is refused already, with the usage.
    const early = await saveAs(s, config, removed).catch((e: unknown) => e);
    expect(early).toBeInstanceOf(UnprocessableProblems);
    expect(early).toMatchObject({
      code: 'config-in-use',
      problems: [
        {
          pointer: '/module/en/charging/blocks/big',
          meta: {
            subject: charging,
            issue: 'unknown-variant-value',
            at: 'big',
          },
        },
      ],
    });
    // Archived, the value stays valid.
    await saveAs(
      s,
      config,
      withModel([
        { id: 'small', label: 'Small' },
        { id: 'large', label: 'Large', archived: true },
      ]),
    );
    // Stored as removed after all (as if the content had not used it when
    // saved): the save point checks again, and accepts it once the same
    // commit removes the module that uses it.
    s.copies.copies.set(`${s.mine.id}:config/ccms.yaml`, {
      changeSetId: s.mine.id,
      subject: config,
      content: removed,
      baseCommit: s.head(),
      version: 1,
      updatedBy: { kind: 'user', id: author.id },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const refused = await s.commit
      .handle({ actor: admin, changeSetId: s.mine.id })
      .catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: 'config-in-use' });
    const fixed = await s.commit.handle({
      actor: admin,
      changeSetId: s.mine.id,
      deletes: [charging],
    });
    expect(fixed).toMatchObject({ written: [config], deleted: [charging] });
  });

  it('never deletes the configuration', async () => {
    const s = setUp();
    s.lock(config);
    const refused = await s.commit
      .handle({ actor: admin, changeSetId: s.mine.id, deletes: [config] })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(UnprocessableError);
    expect(refused).toMatchObject({ code: 'not-deletable' });
  });

  it('checks the configuration’s scope again at commit time', async () => {
    const s = setUp();
    s.lock(config);
    await saveAs(
      s,
      config,
      withModel([
        { id: 'small', label: 'S' },
        { id: 'large', label: 'L' },
      ]),
    );
    const refused = await s.commit
      .handle({ actor: author, changeSetId: s.mine.id })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ForbiddenError);
  });

  it('commits a term, checked against the configuration', async () => {
    const s = setUp();
    s.lock(charger);
    const term = (languages: Record<string, { preferred: string }>) => ({
      schemaVersion: 1 as const,
      id: 'charger',
      status: 'proposed' as const,
      languages: Object.fromEntries(
        Object.entries(languages).map(([l, v]) => [
          l,
          { ...v, allowed: [], forbidden: [] },
        ]),
      ),
    });
    const draft = await saveAs(
      s,
      charger,
      term({ fr: { preferred: 'chargeur' } }),
    );
    expect(draft.issues.map((i) => i.code)).toEqual(['unknown-language']);
    const invalid = await s.commit
      .handle({ actor: author, changeSetId: s.mine.id })
      .catch((e: unknown) => e);
    expect(invalid).toMatchObject({ code: 'invalid-working-copy' });
    await saveAs(s, charger, term({ de: { preferred: 'Ladegerät' } }), 1);
    const outcome = await s.commit.handle({
      actor: author,
      changeSetId: s.mine.id,
    });
    expect(outcome).toMatchObject({ written: [charger] });
    expect(await s.file('terms/charger.yaml')).toBe(
      'schemaVersion: 1\nstatus: proposed\nlanguages:\n  de:\n    preferred: Ladegerät\n',
    );
    expect(actions(s.audit.events)).toEqual([
      'change-set.commit',
      'term.write',
    ]);
  });

  it('refuses to delete a term modules still link (#245), naming only the links the actor may read', async () => {
    const linking = (id: string, lang = 'en'): Module => {
      const m = module(id, lang, 'x');
      return {
        ...m,
        blocks: [
          {
            type: 'paragraph',
            id: 'p',
            content: [
              {
                type: 'text',
                text: 'charger',
                marks: [{ type: 'term', termId: 'charger' }],
              },
            ],
          },
        ],
      };
    };
    const s = setUp({
      modules: [linking('charging'), linking('secret', 'de')],
      terms: {
        charger:
          'schemaVersion: 1\nstatus: approved\nlanguages:\n  en:\n    preferred: charger\n',
      },
    });
    // Edits terms in English, reads no German module.
    const scoped = editor({ languages: ['en'] });
    s.lock(charger);
    s.lock(charging);
    const refusal = (actor: Actor, deletes: LockSubject[]) =>
      s.commit
        .handle({ actor, changeSetId: s.mine.id, deletes })
        .catch((e: unknown) => e);
    const told = await refusal(scoped, [charger]);
    expect(told).toBeInstanceOf(UnprocessableProblems);
    expect(told).toMatchObject({
      code: 'term-in-use',
      problems: [
        {
          pointer: '/module/en/charging/blocks/p',
          meta: { subject: charging, at: 'p', term: 'charger' },
        },
        { meta: { terms: ['charger'] } },
      ],
    });
    // Neither the hidden module's ID nor its block reaches the scoped author.
    expect(JSON.stringify(told)).not.toContain('secret');
    // Deleting the visible module in the same commit leaves the hidden link.
    const still = (await refusal(scoped, [charger, charging])) as
      UnprocessableProblems | undefined;
    expect(still?.problems).toEqual([
      expect.objectContaining({ meta: { terms: ['charger'] } }),
    ]);
    // One who reads both is told both places.
    const all = (await refusal(author, [charger])) as UnprocessableProblems;
    expect(all.problems.map((p) => p.pointer)).toEqual([
      '/module/de/secret/blocks/p',
      '/module/en/charging/blocks/p',
    ]);
    expect(s.branches.commits.size).toBe(0);
  });

  describe('a page design in use (#554)', () => {
    const DESIGN = [
      'schemaVersion: 1',
      'name: Classic',
      'preset: classic',
      'colours:',
      '  primary: "#333333"',
      '  accent: "#555555"',
      '  text: "#111111"',
      '',
    ].join('\n');
    const classic: LockSubject = { type: 'design', designId: 'classic' };
    const internal: ProjectConfig = {
      ...fakeConfig,
      audiences: [
        { id: 'public', label: 'Public' },
        { id: 'internal', label: 'Internal' },
      ],
    };
    const defaulting = (design: string): ProjectConfig => ({
      ...internal,
      pdf: { ...internal.pdf, design },
    });
    /** Saves and commits `content` as the subject's next version. */
    const committed = async (
      s: ReturnType<typeof setUp>,
      subject: LockSubject,
      content: WorkingCopyContent,
    ) => {
      await s.saved(subject, content);
      await s.commit.handle({
        actor: author,
        changeSetId: s.mine.id,
        subjects: [subject],
      });
    };
    const named = (id: string, audience?: string): Manifest => ({
      ...manifest(id, ['charging']),
      design: 'classic',
      ...(audience !== undefined && { audience }),
    });
    /** Edits everything, and reads drafts only up to the public audience. */
    const publicReader: Actor = {
      kind: 'user',
      id: author.id,
      roles: [
        {
          id: 'edit',
          name: 'Edit',
          permissions: ['content.edit', 'content.read'],
          scope: {},
        },
        {
          id: 'read',
          name: 'Read',
          permissions: ['content.read.draft'],
          scope: { maxAudience: 'public' },
        },
      ],
    };

    it('refuses to delete a design a manual or the configuration names, with 409 and where it is used', async () => {
      const s = setUp({
        config: defaulting('classic'),
        manifests: [named('operating', 'public'), named('service', 'internal')],
        pageDesigns: { classic: DESIGN },
      });
      s.lock(classic);
      const refusal = (actor: Actor) =>
        s.commit
          .handle({ actor, changeSetId: s.mine.id, deletes: [classic] })
          .catch((e: unknown) => e);
      const all = await refusal(author);
      expect(all).toBeInstanceOf(ConflictError);
      expect(all).toMatchObject({
        code: 'design-in-use',
        meta: {
          designs: ['classic'],
          usedIn: [
            { in: 'config' },
            { in: 'manual', manual: 'operating' },
            { in: 'manual', manual: 'service' },
          ],
        },
      });
      // A manual the actor may not read is a use without its ID.
      const scoped = await refusal(publicReader);
      expect(scoped).toMatchObject({
        code: 'design-in-use',
        meta: {
          usedIn: [
            { in: 'config' },
            { in: 'manual', manual: 'operating' },
            { in: 'manual' },
          ],
        },
      });
      expect(JSON.stringify(scoped)).not.toContain('service');
      expect(s.branches.commits.size).toBe(0);
    });

    it('deletes it once the same commit stops naming it', async () => {
      const s = setUp({
        config: defaulting('classic'),
        manifests: [named('operating')],
        pageDesigns: { classic: DESIGN, other: DESIGN },
      });
      s.lock(classic);
      s.lock({ type: 'config' });
      s.lock(operating);
      await saveAs(s, { type: 'config' }, defaulting('other'));
      await s.saved(operating, manifest('operating', ['charging']));
      await expect(
        s.commit.handle({
          actor: admin,
          changeSetId: s.mine.id,
          deletes: [classic],
        }),
      ).resolves.toMatchObject({ deleted: [classic] });
      expect(await s.file('design/classic.yaml')).toBeUndefined();
    });

    it('refuses to take out a design the change set added while a manual names it', async () => {
      const s = setUp({ manifests: [manifest('operating', ['charging'])] });
      s.lock(classic);
      s.lock(operating);
      await committed(s, classic, parsePageDesign(DESIGN, { id: 'classic' }));
      await committed(s, operating, {
        ...manifest('operating', ['charging']),
        design: 'classic',
      });
      await expect(
        s.revert.handle({
          actor: author,
          changeSetId: s.mine.id,
          subjects: [classic],
        }),
      ).rejects.toMatchObject({
        code: 'design-in-use',
        meta: { usedIn: [{ in: 'manual', manual: 'operating' }] },
      });
      // Both together: nothing names it any more.
      await expect(
        s.revert.handle({
          actor: author,
          changeSetId: s.mine.id,
          subjects: [classic, operating],
        }),
      ).resolves.toMatchObject({ deleted: [classic] });
    });
  });

  it('deletes a term once the same commit removes its last link', async () => {
    const linked = {
      ...text('x'),
      blocks: [
        {
          type: 'paragraph' as const,
          id: 'p',
          content: [
            {
              type: 'text' as const,
              text: 'charger',
              marks: [{ type: 'term' as const, termId: 'charger' }],
            },
          ],
        },
      ],
    };
    const s = setUp({
      modules: [linked],
      terms: {
        charger:
          'schemaVersion: 1\nstatus: approved\nlanguages:\n  en:\n    preferred: charger\n',
      },
    });
    s.lock(charger);
    s.lock(charging);
    await s.saved(charging, text('Plain.'));
    const outcome = await s.commit.handle({
      actor: author,
      changeSetId: s.mine.id,
      deletes: [charger],
    });
    expect(outcome).toMatchObject({ written: [charging], deleted: [charger] });
    expect(await s.file('terms/charger.yaml')).toBeUndefined();
  });
});

describe('RevertChangesAction', () => {
  /** Saves and commits `content` as the subject's next version. */
  const committed = async (
    s: ReturnType<typeof setUp>,
    subject: LockSubject,
    content: WorkingCopyContent,
  ) => {
    await s.saved(subject, content);
    await s.commit.handle({
      actor: author,
      changeSetId: s.mine.id,
      subjects: [subject],
    });
  };

  it('refuses to put back a configuration that what stays would no longer fit (#253)', async () => {
    const admin: Actor = {
      ...actorWith([...EDITING, 'admin.roles']),
      id: author.id,
    };
    const s = setUp({ modules: [text('A.')] });
    const configSubject: LockSubject = { type: 'config' };
    s.lock(configSubject);
    s.lock(charging);
    const added: ProjectConfig = {
      ...fakeConfig,
      variantAttributes: fakeConfig.variantAttributes.map((a) =>
        a.kind === 'enum'
          ? { ...a, values: [...a.values, { id: 'huge', label: 'Huge' }] }
          : a,
      ),
    };
    const usingHuge: Module = {
      ...text('A.'),
      blocks: [
        {
          type: 'variant',
          id: 'huge',
          when: { op: 'in', attr: 'model', values: ['huge'] },
          blocks: text('Huge.').blocks,
        },
      ],
    };
    for (const [subject, content] of [
      [configSubject, added],
      [charging, usingHuge],
    ] as const) {
      await s.save.handle({
        actor: admin,
        changeSetId: s.mine.id,
        subject,
        content,
        version: 0,
      });
    }
    await s.commit.handle({ actor: admin, changeSetId: s.mine.id });

    await expect(
      s.revert.handle({
        actor: admin,
        changeSetId: s.mine.id,
        subjects: [configSubject],
      }),
    ).rejects.toMatchObject({
      code: 'config-in-use',
      problems: [{ pointer: '/module/en/charging/blocks/huge' }],
    });
    const both = await s.revert.handle({
      actor: admin,
      changeSetId: s.mine.id,
      subjects: [configSubject, charging],
    });
    expect(both.restored).toEqual([configSubject, charging]);
  });

  it('refuses to put back a file the configuration the change set keeps no longer fits (#253)', async () => {
    const admin: Actor = {
      ...actorWith([...EDITING, 'admin.roles']),
      id: author.id,
    };
    const usingLarge: Module = {
      ...text('A.'),
      blocks: [
        {
          type: 'variant',
          id: 'big',
          when: { op: 'in', attr: 'model', values: ['large'] },
          blocks: text('Big.').blocks,
        },
      ],
    };
    const s = setUp({ modules: [usingLarge] });
    const configSubject: LockSubject = { type: 'config' };
    s.lock(configSubject);
    s.lock(charging);
    const save = (subject: LockSubject, content: WorkingCopyContent) =>
      s.save.handle({
        actor: admin,
        changeSetId: s.mine.id,
        subject,
        content,
        version: 0,
      });
    // First charging stops using `large`, then the configuration drops it.
    await save(charging, text('A.'));
    await s.commit.handle({ actor: admin, changeSetId: s.mine.id });
    await save(configSubject, {
      ...fakeConfig,
      variantAttributes: [
        {
          id: 'model',
          label: 'Model',
          kind: 'enum',
          values: [{ id: 'small', label: 'Small' }],
        },
      ],
    });
    await s.commit.handle({ actor: admin, changeSetId: s.mine.id });

    await expect(
      s.revert.handle({
        actor: admin,
        changeSetId: s.mine.id,
        subjects: [charging],
      }),
    ).rejects.toMatchObject({
      code: 'config-in-use',
      problems: [{ pointer: '/module/en/charging/blocks/big' }],
    });
  });

  it('refuses to take out a term the change set added while modules link it (#245)', async () => {
    const cable: LockSubject = { type: 'term', termId: 'cable' };
    const s = setUp({ modules: [text('A.')] });
    s.lock(cable);
    s.lock(charging);
    await committed(s, cable, {
      schemaVersion: 1,
      id: 'cable',
      status: 'proposed',
      languages: { en: { preferred: 'cable', allowed: [], forbidden: [] } },
    });
    await committed(s, charging, {
      ...text('A.'),
      blocks: [
        {
          type: 'paragraph',
          id: 'p',
          content: [
            {
              type: 'text',
              text: 'cable',
              marks: [{ type: 'term', termId: 'cable' }],
            },
          ],
        },
      ],
    });
    await expect(
      s.revert.handle({
        actor: author,
        changeSetId: s.mine.id,
        subjects: [cable],
      }),
    ).rejects.toMatchObject({
      code: 'term-in-use',
      problems: [{ pointer: '/module/en/charging/blocks/p' }],
    });
    // Both together: nothing links it any more.
    await expect(
      s.revert.handle({
        actor: author,
        changeSetId: s.mine.id,
        subjects: [cable, charging],
      }),
    ).resolves.toMatchObject({ deleted: [cable], restored: [charging] });
  });

  it('takes one of two changed modules out: its file back as at the base, its lock released', async () => {
    const s = setUp({ modules: [text('A.'), text('S.', 'safety')] });
    const before = await s.file('modules/en/charging.adoc');
    s.lock(charging);
    s.lock(safety);
    await committed(s, charging, text('A2.'));
    await committed(s, safety, text('S2.', 'safety'));
    const parent = s.head();
    s.audit.events.length = 0;

    const outcome = await s.revert.handle({
      actor: author,
      changeSetId: s.mine.id,
      subjects: [charging],
    });

    expect(outcome).toEqual({
      changeSetId: s.mine.id,
      branch: s.mine.branch,
      commit: s.head(),
      head: s.head(),
      restored: [charging],
      deleted: [],
      discarded: [],
    });
    expect(s.branches.commits.get(s.head())).toMatchObject({
      parent,
      message: 'Take module en/charging out of the change set',
      changes: [{ path: 'modules/en/charging.adoc', content: before }],
    });
    expect(await s.file('modules/en/charging.adoc')).toBe(before);
    expect(await s.file('modules/en/safety.adoc')).toBe(
      printModule(text('S2.', 'safety')),
    );
    expect(s.locks.locks.map((l) => l.subject)).toEqual([safety]);
    expect(actions(s.audit.events)).toEqual([
      'change-set.commit',
      'module.write',
      'lock.release',
      'change-set.revert',
    ]);
    expect(s.audit.events[2]).toMatchObject({
      subject: { type: 'module', id: 'en/charging' },
      data: { changeSetId: s.mine.id, reason: 'change-set.revert' },
    });
    expect(s.audit.events[3]).toMatchObject({
      subject: { type: 'change-set', id: s.mine.id },
      data: {
        commit: s.head(),
        subjects: ['module/en/charging'],
        restored: 1,
        deleted: 0,
      },
    });
    expect(s.commits.records.map((r) => r.commit)).toContain(s.head());
    expect(s.intents.intents).toEqual([]);
  });

  it('deletes a module the change set created, and drops its newer working copy', async () => {
    const s = setUp({ modules: [text('A.')] });
    const fresh: LockSubject = {
      type: 'module',
      lang: 'en',
      moduleId: 'fresh',
    };
    s.lock(fresh);
    await committed(s, fresh, text('New.', 'fresh'));
    await s.saved(fresh, text('Newer.', 'fresh'));

    const outcome = await s.revert.handle({
      actor: author,
      changeSetId: s.mine.id,
      subjects: [fresh],
    });

    expect(outcome).toMatchObject({
      restored: [],
      deleted: [fresh],
      discarded: [fresh],
    });
    expect(await s.file('modules/en/fresh.adoc')).toBeUndefined();
    expect(await s.copies.find(s.mine.id, fresh)).toBeUndefined();
    expect(s.locks.locks).toEqual([]);
    expect(s.audit.events.at(-1)).toMatchObject({
      action: 'change-set.revert',
      data: { deleted: 1, workingCopies: 1 },
    });
  });

  it('puts a module’s translation record back with it, or alone when only the record changed (#287)', async () => {
    const german: LockSubject = {
      type: 'module',
      lang: 'de',
      moduleId: 'charging',
    };
    const record = (hash: string): TranslationRecord => ({
      schemaVersion: 1,
      sourceCommit: 'a'.repeat(40),
      blocks: { p: hash },
    });
    const s = setUp({
      modules: [text('A.'), module('charging', 'de', 'Alt.')],
      translationRecords: { 'de/charging': record('8'.repeat(64)) },
    });
    const kept = printTranslationRecord(record('8'.repeat(64)));
    s.lock(german);
    await s.commit.handle({
      actor: author,
      changeSetId: s.mine.id,
      deletes: [german],
    });
    expect(
      await s.file('modules/de/charging.translation.yaml'),
    ).toBeUndefined();
    const back = await s.revert.handle({
      actor: author,
      changeSetId: s.mine.id,
      subjects: [german],
    });
    expect(back).toMatchObject({ restored: [german], deleted: [] });
    expect(await s.file('modules/de/charging.adoc')).toContain('Alt.');
    expect(await s.file('modules/de/charging.translation.yaml')).toBe(kept);

    // Only the record written (marked current): taking it out puts it back.
    s.lock(german);
    await s.commit.handle({
      actor: author,
      changeSetId: s.mine.id,
      subjects: [],
      translationRecords: [{ subject: german, record: record('9'.repeat(64)) }],
    });
    const head = s.head();
    const again = await s.revert.handle({
      actor: author,
      changeSetId: s.mine.id,
      subjects: [german],
    });
    expect(again).toMatchObject({ restored: [german], deleted: [] });
    expect(s.head()).not.toBe(head);
    expect(
      s.branches.commits.get(s.head())?.changes.map((c) => c.path),
    ).toEqual(['modules/de/charging.translation.yaml']);
    expect(await s.file('modules/de/charging.translation.yaml')).toBe(kept);
  });

  it('drops a working copy alone without a commit when nothing was committed', async () => {
    const s = setUp({ modules: [text('A.')] });
    s.lock(charging);
    await s.saved(charging, text('Typed.'));
    const head = s.head();

    const outcome = await s.revert.handle({
      actor: author,
      changeSetId: s.mine.id,
      subjects: [charging],
    });

    expect(outcome).toEqual({
      changeSetId: s.mine.id,
      branch: s.mine.branch,
      head,
      restored: [],
      deleted: [],
      discarded: [charging],
    });
    expect(s.branches.commits.size).toBe(0);
    expect(await s.copies.find(s.mine.id, charging)).toBeUndefined();
    expect(s.locks.locks).toEqual([]);
    expect(actions(s.audit.events)).toEqual([
      'lock.release',
      'change-set.revert',
    ]);
    expect(s.audit.events[1]).toMatchObject({ data: { commit: null } });
  });

  it('puts back a manual the change set deleted', async () => {
    const s = setUp({ manifests: [manifest('operating', ['charging'])] });
    const before = await s.file('manuals/operating.yaml');
    s.lock(operating);
    await s.commit.handle({
      actor: author,
      changeSetId: s.mine.id,
      deletes: [operating],
      subjects: [],
    });
    expect(await s.file('manuals/operating.yaml')).toBeUndefined();

    const outcome = await s.revert.handle({
      actor: author,
      changeSetId: s.mine.id,
      subjects: [operating],
    });
    expect(outcome).toMatchObject({ restored: [operating], deleted: [] });
    expect(await s.file('manuals/operating.yaml')).toBe(before);
  });

  it('refuses a subject it does not change, one without the lock, and a change set no draft', async () => {
    const s = setUp({ modules: [text('A.'), text('S.', 'safety')] });
    s.lock(charging);
    s.lock(safety);
    await committed(s, charging, text('A2.'));
    await expect(
      s.revert.handle({
        actor: author,
        changeSetId: s.mine.id,
        subjects: [charging, safety],
      }),
    ).rejects.toMatchObject({
      code: 'not-changed',
      meta: { subject: safety },
    });
    s.locks.locks.length = 0;
    await expect(
      s.revert.handle({
        actor: author,
        changeSetId: s.mine.id,
        subjects: [charging],
      }),
    ).rejects.toMatchObject({
      code: 'lock-required',
      meta: { subject: charging },
    });
    s.lock(charging);
    s.changeSets.changeSets[0] = {
      ...(s.changeSets.changeSets[0] as ChangeSet),
      state: 'in-review',
    };
    await expect(
      s.revert.handle({
        actor: author,
        changeSetId: s.mine.id,
        subjects: [charging],
      }),
    ).rejects.toMatchObject({
      code: 'invalid-state',
      meta: { state: 'in-review' },
    });
    await expect(
      s.revert.handle({
        actor: author,
        changeSetId: s.mine.id,
        subjects: [charging, { ...charging, lang: 'EN' }],
      }),
    ).rejects.toMatchObject({ code: 'duplicate-subject' });
    await expect(
      s.revert.handle({ actor: author, changeSetId: s.mine.id, subjects: [] }),
    ).rejects.toMatchObject({ code: 'nothing-to-revert' });
  });

  it('puts back a module a scoped author deleted, checked at the base alone', async () => {
    const internal = text('Secret.', 'secret');
    const s = setUp({
      modules: [
        text('A.'),
        { ...internal, meta: { ...internal.meta, audience: 'internal' } },
      ],
    });
    const scoped = editor({ maxAudience: 'public' });
    const before = await s.file('modules/en/charging.adoc');
    s.lock(charging);
    await s.commit.handle({
      actor: scoped,
      changeSetId: s.mine.id,
      deletes: [charging],
    });
    expect(await s.file('modules/en/charging.adoc')).toBeUndefined();

    const outcome = await s.revert.handle({
      actor: scoped,
      changeSetId: s.mine.id,
      subjects: [charging],
    });

    expect(outcome).toMatchObject({ restored: [charging], deleted: [] });
    expect(await s.file('modules/en/charging.adoc')).toBe(before);
    // One deleted by someone who saw it is still out of reach at the base.
    const secret: LockSubject = {
      type: 'module',
      lang: 'en',
      moduleId: 'secret',
    };
    s.lock(secret);
    await s.commit.handle({
      actor: author,
      changeSetId: s.mine.id,
      deletes: [secret],
    });
    await expect(
      s.revert.handle({
        actor: scoped,
        changeSetId: s.mine.id,
        subjects: [secret],
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('is the author’s alone, and checks scope with the actor’s current roles', async () => {
    const s = setUp({ modules: [text('A.')] });
    s.lock(charging);
    await committed(s, charging, text('A2.'));
    const head = s.head();
    await expect(
      s.revert.handle({
        actor: editor({}, 'sample-other'),
        changeSetId: s.mine.id,
        subjects: [charging],
      }),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      s.revert.handle({
        actor: { ...actorWith(['content.edit', 'content.read']), id: 'x' },
        changeSetId: s.mine.id,
        subjects: [charging],
      }),
    ).rejects.toThrow(NotFoundError);
    const narrowed = { ...author, roles: editor({ languages: ['de'] }).roles };
    await expect(
      s.revert.handle({
        actor: narrowed,
        changeSetId: s.mine.id,
        subjects: [charging],
      }),
    ).rejects.toThrow(ForbiddenError);
    expect(s.head()).toBe(head);
    expect(s.locks.locks).toHaveLength(1);
  });

  it('tries a moved branch once more, then answers 409', async () => {
    const s = setUp({ modules: [text('A.')] });
    s.lock(charging);
    await committed(s, charging, text('A2.'));
    let moves = 2;
    const commit = s.branches.commit.bind(s.branches);
    s.branches.commit = async (branch, made) => {
      if (moves-- > 0) return { moved: 'f'.repeat(40) };
      return commit(branch, made);
    };
    await expect(
      s.revert.handle({
        actor: author,
        changeSetId: s.mine.id,
        subjects: [charging],
      }),
    ).rejects.toMatchObject({ code: 'branch-moved' });
    expect(s.locks.locks).toHaveLength(1);
    expect(s.intents.intents).toEqual([]);
  });
});

describe('marking a translation current while a save point lands (#957)', () => {
  /** The change set's author, managing translations and the configuration. */
  const manager: Actor = {
    ...actorWith([...EDITING, 'translation.manage', 'admin.roles']),
    id: author.id,
  };
  const ASSET = 'sha256:' + 'a'.repeat(64);
  const english = text('A.');
  const deutsch = module('charging', 'de', 'A auf Deutsch.');
  const para = (id: string, t: string) => ({
    type: 'paragraph' as const,
    id,
    content: [{ type: 'text' as const, text: t }],
  });
  const labelled = ProjectConfig.parse({
    ...fakeConfig,
    moduleTypes: [{ id: 'concept', label: { en: 'Concept', de: 'Konzept' } }],
  });
  const covered: Manifest = {
    ...manifest('user-manual', ['charging']),
    coverImage: {
      default: { asset: ASSET, alt: { en: 'The vehicle', de: 'Das Fahrzeug' } },
      variants: [],
    },
  } as Manifest;
  const house = printPageDesign(
    PageDesign.parse({
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
    }),
  );

  /** The author's other save point of `subject`, with `content`. */
  const savePoint =
    (subject: LockSubject, content: WorkingCopyContent) =>
    async (s: ReturnType<typeof setUp>) => {
      await s.save.handle({
        actor: manager,
        changeSetId: s.mine.id,
        subject,
        content,
        version: 0,
      });
      await s.commit.handle({
        actor: manager,
        changeSetId: s.mine.id,
        subjects: [subject],
      });
    };

  /**
   * Marks `which` current through the real save and save point, with the author's other save
   * point (`landed`) committed between the head read and the working-copy check: when the lock
   * is taken, which comes between the two.
   */
  async function markWithSavePointBetween(
    which:
      | { moduleId: string }
      | { manualId: string }
      | { designId: string }
      | { config: true },
    subject: LockSubject,
    landed: (s: ReturnType<typeof setUp>) => Promise<void>,
  ) {
    const s = setUp({
      config: labelled,
      modules: [english, deutsch],
      manifests: [covered],
      pageDesigns: { house },
    });
    s.lock(subject);
    const mark = new MarkTranslationCurrentAction(
      { handle: async () => s.mine } as never,
      new OpenSnapshotAction(
        s.repository,
        new ChangeSetAuthoredBranches(s.changeSets),
      ),
      { handle: () => landed(s) } as never,
      s.commit,
      s.save,
      s.copies,
      s.audit,
      { handle: async () => undefined } as never,
    );
    const outcome = await mark
      .handle({ actor: manager, changeSetId: s.mine.id, lang: 'de', ...which })
      .catch((e: unknown) => e);
    return { s, outcome };
  }

  it('refuses a manual changed since its head was read, keeping the save point', async () => {
    const manual: LockSubject = { type: 'manual', manualId: 'user-manual' };
    const { s, outcome } = await markWithSavePointBetween(
      { manualId: 'user-manual' },
      manual,
      savePoint(manual, { ...covered, title: 'Changed meanwhile' }),
    );
    expect(outcome).toMatchObject({ code: 'stale-working-copy' });
    expect(
      parseManifest((await s.file('manuals/user-manual.yaml')) as string, {
        id: 'user-manual',
      }).title,
    ).toBe('Changed meanwhile');
    expect(s.copies.copies.size).toBe(0);
  });

  it('refuses a page design changed since its head was read, keeping the save point', async () => {
    const design: LockSubject = { type: 'design', designId: 'house' };
    const { s, outcome } = await markWithSavePointBetween(
      { designId: 'house' },
      design,
      savePoint(design, {
        ...parsePageDesign(house, { id: 'house' }),
        name: 'Changed meanwhile',
      }),
    );
    expect(outcome).toMatchObject({ code: 'stale-working-copy' });
    expect(
      parsePageDesign((await s.file('design/house.yaml')) as string, {
        id: 'house',
      }).name,
    ).toBe('Changed meanwhile');
    expect(s.copies.copies.size).toBe(0);
  });

  it('refuses the configuration changed since its head was read, keeping the save point', async () => {
    const config: LockSubject = { type: 'config' };
    const { s, outcome } = await markWithSavePointBetween(
      { config: true },
      config,
      savePoint(config, {
        ...labelled,
        audiences: [{ id: 'public', label: 'Changed meanwhile' }],
      }),
    );
    expect(outcome).toMatchObject({ code: 'stale-working-copy' });
    expect(
      parseConfig((await s.file('openfolia.yaml')) as string).audiences,
    ).toEqual([{ id: 'public', label: 'Changed meanwhile' }]);
    expect(s.copies.copies.size).toBe(0);
  });

  it('refuses a module whose translation record changed since its head was read, keeping that record', async () => {
    const german: LockSubject = {
      type: 'module',
      lang: 'de',
      moduleId: 'charging',
    };
    const meanwhile: TranslationRecord = {
      schemaVersion: 1,
      sourceCommit: 'a'.repeat(40),
      blocks: { p: '1'.repeat(64), q: '2'.repeat(64) },
    };
    const { s, outcome } = await markWithSavePointBetween(
      { moduleId: 'charging' },
      german,
      async (s) => {
        await s.commit.handle({
          actor: manager,
          changeSetId: s.mine.id,
          subjects: [],
          translationRecords: [{ subject: german, record: meanwhile }],
        });
      },
    );
    expect(outcome).toMatchObject({ code: 'stale-working-copy' });
    expect(await s.file('modules/de/charging.translation.yaml')).toBe(
      printTranslationRecord(meanwhile),
    );
  });
});
