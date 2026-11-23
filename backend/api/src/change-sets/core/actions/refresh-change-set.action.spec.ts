import {
  parseManifest,
  parseModule,
  printModule,
  type Module,
} from '@openfolia/content-model';
import { actorWith } from '../../../../tests/fakes/actors.js';
import { FakeAssetUploads } from '../../../../tests/fakes/fake-asset-uploads.js';
import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import { FakeChangeSetBranches } from '../../../../tests/fakes/fake-change-set-branches.js';
import { FakeChangeSetCommits } from '../../../../tests/fakes/fake-change-set-commits.js';
import { FakeChangeSetStore } from '../../../../tests/fakes/fake-change-set-store.js';
import { FakeCommitIntents } from '../../../../tests/fakes/fake-commit-intents.js';
import {
  type FakeContent,
  FakeSnapshot,
  module,
} from '../../../../tests/fakes/fake-content.js';
import { FakeLockStore } from '../../../../tests/fakes/fake-lock-store.js';
import { FakeRefreshConflicts } from '../../../../tests/fakes/fake-refresh-conflicts.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import { FakeWorkingCopyStore } from '../../../../tests/fakes/fake-working-copy-store.js';
import type { Actor } from '../../../access/core/actor.js';
import { ReadableAssets } from '../../../assets/core/readable-assets.js';
import type { CheckedAuditEvent } from '../../../audit/core/audit-log.js';
import {
  ConflictError,
  ForbiddenError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import type { Transaction } from '../../../base/core/unit-of-work.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import {
  ContentRepository,
  type ContentSnapshot,
} from '../../../content/core/content.repository.js';
import { ReadableRefs } from '../../../content/core/readable-refs.js';
import { ChangeSetAuthoredBranches } from '../change-set-authored-branches.js';
import { ChangeSetBehind } from '../change-set-behind.js';
import {
  type ChangeSet,
  changeSetBranch,
  newChangeSetId,
} from '../change-set.js';
import { CommitRecorder } from '../commit-recorder.js';
import type { BranchChange } from '../commit.js';
import { type LockSubject, newLockId } from '../lock.js';
import { CommitWorkingCopiesAction } from './commit-working-copies.action.js';
import { DiscardWorkingCopyAction } from './discard-working-copy.action.js';
import { RefreshChangeSetAction } from './refresh-change-set.action.js';
import { SaveWorkingCopyAction } from './save-working-copy.action.js';

const author: Actor = {
  ...actorWith(['content.read', 'content.read.draft', 'content.edit']),
  id: 'sample-author',
};
const someoneElse: Actor = { ...author, id: 'sample-editor' };
const charging: LockSubject = {
  type: 'module',
  lang: 'en',
  moduleId: 'charging',
};
const safety: LockSubject = { type: 'module', lang: 'en', moduleId: 'safety' };
const CHARGING = 'modules/en/charging.adoc';
const SAFETY = 'modules/en/safety.adoc';
const text = (id: string, words: string) =>
  printModule(module(id, 'en', words));

/** Snapshots by branch and by commit; commits the fake branches make become readable. */
class Repository extends ContentRepository {
  readonly heads = new Map<string, ContentSnapshot>();
  readonly commits = new Map<string, ContentSnapshot>();

  async at(ref: string): Promise<ContentSnapshot | undefined> {
    return this.heads.get(ref) ?? this.commits.get(ref);
  }

  async refs() {
    return {
      branches: [...this.heads].map(([name, s]) => ({
        name,
        commit: s.commit,
      })),
      tags: [],
    };
  }
}

/** An audit log that fails while `failing` is set, as a database outage would. */
class FailingAuditLog extends FakeAuditLog {
  failing = false;
  protected override append(tx: Transaction, event: CheckedAuditEvent) {
    if (this.failing) return Promise.reject(new Error('the database is down'));
    return super.append(tx, event);
  }
}

/** The content after `changes`, as Git would make the files (modules only). */
function applied(
  content: FakeContent,
  changes: readonly BranchChange[],
): FakeContent {
  let modules = [...(content.modules ?? [])];
  let manifests = [...(content.manifests ?? [])];
  for (const change of changes) {
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
  return { ...content, modules, manifests };
}

/**
 * A draft change set on `main` with the modules `charging` and `safety`;
 * `onBranch` and `onMain` are the commits made on each since it started.
 */
function setUp(
  options: {
    onBranch?: Record<string, string>;
    onMain?: Record<string, string>;
  } = {},
) {
  const id = newChangeSetId();
  const now = new Date();
  const repository = new Repository();
  const start = new FakeSnapshot({
    modules: [module('charging', 'en', 'Old.'), module('safety', 'en', 'Old.')],
  });
  repository.commits.set(start.commit, start);
  repository.heads.set('main', start);
  const changeSet: ChangeSet = {
    id,
    title: 'Charging',
    description: null,
    author: { kind: 'user', id: author.id },
    baseRef: 'main',
    baseCommit: start.commit,
    baseReleased: true,
    branch: changeSetBranch(id),
    state: 'draft',
    createdAt: now,
    updatedAt: now,
  };
  repository.heads.set(changeSet.branch, start);
  const branches = new FakeChangeSetBranches();
  branches.heads.set('main', start.commit);
  branches.heads.set(changeSet.branch, start.commit);
  branches.onCommit = (commit, made) => {
    const before = repository.heads.get(made.branch) as FakeSnapshot;
    const after = new FakeSnapshot(
      applied(before.content, made.changes),
      commit,
    );
    repository.heads.set(made.branch, after);
    repository.commits.set(commit, after);
  };
  const push = (branch: string, files: Record<string, string>) =>
    branches.push(branch, {
      changes: Object.entries(files).map(([path, content]) => ({
        path,
        content,
      })),
      message: 'Edit',
      author: { kind: 'user', id: 'someone' },
      changeSetId: id,
    });
  if (options.onBranch) push(changeSet.branch, options.onBranch);
  if (options.onMain) push('main', options.onMain);
  // A fast-forward moves the branch to a commit the fake made on `main`.
  const follow = () => {
    const head = branches.heads.get(changeSet.branch) as string;
    const known = repository.commits.get(head);
    if (known) repository.heads.set(changeSet.branch, known);
  };

  const store = new FakeChangeSetStore([changeSet]);
  const locks = new FakeLockStore();
  const copies = new FakeWorkingCopyStore();
  const reported = new FakeRefreshConflicts();
  const audit = new FailingAuditLog();
  const unit = new FakeUnitOfWork();
  const commits = new FakeChangeSetCommits();
  const intents = new FakeCommitIntents();
  const open = new OpenSnapshotAction(
    repository,
    new ChangeSetAuthoredBranches(store),
  );
  const recorder = new CommitRecorder(
    commits,
    branches,
    audit,
    copies,
    intents,
  );
  const assets = new FakeAssetUploads();
  const readable = new ReadableAssets(assets);
  const save = new SaveWorkingCopyAction(
    store,
    locks,
    copies,
    open,
    branches,
    unit,
    assets,
    readable,
    reported,
  );
  const commit = new CommitWorkingCopiesAction(
    store,
    locks,
    copies,
    branches,
    recorder,
    intents,
    open,
    unit,
    readable,
  );
  const discard = new DiscardWorkingCopyAction(store, copies, unit, reported);
  const refs = new ReadableRefs(repository);
  const action = new RefreshChangeSetAction(
    store,
    branches,
    refs,
    copies,
    locks,
    commits,
    recorder,
    audit,
    open,
    commit,
    unit,
    reported,
  );
  const lock = (subject: LockSubject) =>
    locks.locks.push({
      id: newLockId(),
      subject,
      changeSetId: id,
      holder: { kind: 'user', id: author.id },
      since: now,
    });
  const head = () => branches.heads.get(changeSet.branch) as string;
  const file = async (path: string) => {
    const bytes = await (
      repository.heads.get(changeSet.branch) as FakeSnapshot
    ).file(path);
    return bytes && new TextDecoder().decode(bytes);
  };
  return {
    id,
    changeSet,
    repository,
    branches,
    store,
    copies,
    reported,
    audit,
    commits,
    lock,
    head,
    file,
    follow,
    push,
    behind: new ChangeSetBehind(branches, refs),
    mainHead: () => branches.heads.get('main') as string,
    refreshes: () =>
      audit.events.filter((e) => e.action === 'change-set.refresh'),
    saved: async (subject: LockSubject, content: Module) => {
      const version = (await copies.find(id, subject))?.version ?? 0;
      return save.handle({
        actor: author,
        changeSetId: id,
        subject,
        content,
        version,
      });
    },
    discarded: (subject: LockSubject) =>
      discard.handle({ actor: author, changeSetId: id, subject }),
    refresh: (
      more: {
        keep?: LockSubject[];
        keepMine?: LockSubject[];
        comment?: string;
        actor?: Actor;
      } = {},
    ) => action.handle({ actor: more.actor ?? author, id, ...more }),
  };
}

const conflictOf = (error: unknown) => {
  expect(error).toBeInstanceOf(ConflictError);
  return error as ConflictError;
};

describe('RefreshChangeSetAction', () => {
  it('merges what main gained into the branch, moves its base on and audits it', async () => {
    const t = setUp({
      onBranch: { [CHARGING]: text('charging', 'Mine.') },
      onMain: { [SAFETY]: text('safety', 'Theirs.') },
    });
    const before = t.head();
    expect(await t.behind.of(author, t.changeSet)).toEqual({
      base: 'current',
      behind: 1,
    });
    const outcome = await t.refresh({ comment: 'Catch up.' });
    expect(outcome).toMatchObject({ updated: true, fastForward: false });
    expect(outcome.head).toBe(t.head());
    expect(outcome.changeSet.baseCommit).toBe(t.mainHead());
    expect(t.branches.commits.get(t.head())).toMatchObject({
      parent: before,
      mergeOf: t.mainHead(),
      author: { kind: 'user', id: author.id },
    });
    expect(await t.file(SAFETY)).toBe(text('safety', 'Theirs.'));
    expect(await t.file(CHARGING)).toBe(text('charging', 'Mine.'));
    // Only its own change is counted from the new base.
    expect(
      (await t.branches.changedPaths(t.mainHead(), t.head())).map(
        (c) => c.path,
      ),
    ).toEqual([CHARGING]);
    // The merge commit is recorded, so recovery's walk stops there.
    expect(t.commits.records).toEqual([
      expect.objectContaining({
        commit: t.head(),
        parent: before,
        written: [safety],
        deleted: [],
      }),
    ]);
    expect(t.refreshes()).toEqual([
      expect.objectContaining({
        actor: { kind: 'user', id: author.id },
        subject: { type: 'change-set', id: t.id },
        comment: 'Catch up.',
        data: expect.objectContaining({
          baseRef: 'main',
          from: t.changeSet.baseCommit,
          to: t.mainHead(),
          parent: before,
          commit: t.head(),
          fastForward: false,
          written: 1,
          kept: [],
        }),
      }),
    ]);
    expect(await t.behind.of(author, outcome.changeSet)).toEqual({
      base: 'current',
      behind: 0,
    });
  });

  it('fast-forwards a branch without commits of its own, recording no commit', async () => {
    const t = setUp({ onMain: { [SAFETY]: text('safety', 'Theirs.') } });
    const outcome = await t.refresh();
    expect(outcome).toMatchObject({ updated: true, fastForward: true });
    expect(t.head()).toBe(t.mainHead());
    expect(outcome.changeSet.baseCommit).toBe(t.mainHead());
    expect(t.commits.records).toEqual([]);
    expect(t.refreshes()).toHaveLength(1);
  });

  it('writes nothing when the branch is up to date', async () => {
    const t = setUp({ onBranch: { [CHARGING]: text('charging', 'Mine.') } });
    const before = t.head();
    const outcome = await t.refresh();
    expect(outcome).toMatchObject({ updated: false, head: before });
    expect(outcome.changeSet.baseCommit).toBe(t.changeSet.baseCommit);
    expect(t.refreshes()).toEqual([]);
  });

  it('answers conflicts per path, with their subjects, and writes nothing', async () => {
    const t = setUp({
      onBranch: { [CHARGING]: text('charging', 'Mine.') },
      onMain: { [CHARGING]: text('charging', 'Theirs.') },
    });
    const before = t.head();
    const error = conflictOf(await t.refresh().catch((e: unknown) => e));
    expect(error.code).toBe('refresh-conflict');
    expect(error.meta).toEqual({
      conflicts: [{ path: CHARGING, subject: charging, kinds: ['contents'] }],
      total: 1,
    });
    expect(t.head()).toBe(before);
    expect((await t.store.find(t.id))?.baseCommit).toBe(t.changeSet.baseCommit);
    expect(t.refreshes()).toEqual([]);
    expect(t.commits.records).toEqual([]);
  });

  it('keeps a file resolved in a working copy: committed first, then kept', async () => {
    const t = setUp({
      onBranch: { [CHARGING]: text('charging', 'Mine.') },
      onMain: { [CHARGING]: text('charging', 'Theirs.') },
    });
    t.lock(charging);
    expect(conflictOf(await t.refresh().catch((e: unknown) => e)).code).toBe(
      'refresh-conflict',
    );
    await t.saved(charging, module('charging', 'en', 'Mine and theirs.'));
    const outcome = await t.refresh({ keep: [charging] });
    expect(outcome.updated).toBe(true);
    expect(outcome.savePoint).toBeDefined();
    expect(await t.file(CHARGING)).toBe(text('charging', 'Mine and theirs.'));
    expect(t.branches.commits.get(t.head())).toMatchObject({
      parent: outcome.savePoint,
      mergeOf: t.mainHead(),
    });
    expect(await t.copies.find(t.id, charging)).toBeUndefined();
    expect(t.refreshes()[0]?.data).toMatchObject({
      kept: ['module/en/charging'],
      resolvedByEditing: ['module/en/charging'],
      keptByChoice: [],
      savePoint: outcome.savePoint,
    });
    // Updated: what was reported is cleared.
    expect(t.reported.reports.get(t.id)).toBeUndefined();
  });

  it('keeps a committed file only while the change set holds its lock', async () => {
    const t = setUp({
      onBranch: { [CHARGING]: text('charging', 'Mine.') },
      onMain: { [CHARGING]: text('charging', 'Theirs.') },
    });
    const before = t.head();
    const error = conflictOf(
      await t.refresh({ keepMine: [charging] }).catch((e: unknown) => e),
    );
    expect(error.code).toBe('lock-required');
    expect(t.head()).toBe(before);
    t.lock(charging);
    const outcome = await t.refresh({ keepMine: [charging] });
    expect(outcome.savePoint).toBeUndefined();
    expect(await t.file(CHARGING)).toBe(text('charging', 'Mine.'));
  });

  it('reports a working copy of a file main changed, and moves the others on', async () => {
    const t = setUp({
      onBranch: { [CHARGING]: text('charging', 'Mine.') },
      onMain: { [SAFETY]: text('safety', 'Theirs.') },
    });
    t.lock(charging);
    t.lock(safety);
    await t.saved(safety, module('safety', 'en', 'Unsaved.'));
    const error = conflictOf(await t.refresh().catch((e: unknown) => e));
    expect(error.code).toBe('refresh-conflict');
    expect(error.meta).toMatchObject({
      conflicts: [{ path: SAFETY, subject: safety, kinds: ['working-copy'] }],
    });
    await t.saved(charging, module('charging', 'en', 'Typing.'));
    // Saved before the report: not resolved by it.
    expect(
      conflictOf(await t.refresh({ keep: [safety] }).catch((e: unknown) => e))
        .code,
    ).toBe('refresh-unresolved');
    await t.saved(safety, module('safety', 'en', 'Unsaved, with theirs.'));
    // Keeping it commits it first; the merge then takes main's change in
    // on top (no conflict: the fake merges whole files).
    const kept = await t.refresh({ keep: [safety] });
    expect(kept.savePoint).toBeDefined();
    const copy = await t.copies.find(t.id, charging);
    expect(copy).toMatchObject({ baseCommit: t.head(), version: 2 });
  });

  it('is its author’s, on a draft only', async () => {
    const t = setUp({ onMain: { [SAFETY]: text('safety', 'Theirs.') } });
    await expect(t.refresh({ actor: someoneElse })).rejects.toThrow(
      ForbiddenError,
    );
    t.store.changeSets[0] = { ...t.changeSet, state: 'in-review' };
    const error = conflictOf(await t.refresh().catch((e: unknown) => e));
    expect(error.code).toBe('invalid-state');
  });

  it('refuses a subject named twice in keep, or in keep and keepMine', async () => {
    const t = setUp();
    await expect(t.refresh({ keep: [charging, charging] })).rejects.toThrow(
      UnprocessableError,
    );
    await expect(
      t.refresh({ keep: [charging], keepMine: [charging] }),
    ).rejects.toThrow(UnprocessableError);
  });

  describe('keeping only what was resolved (#437)', () => {
    const conflicting = () => {
      const t = setUp({
        onBranch: {
          [CHARGING]: text('charging', 'Mine.'),
          [SAFETY]: text('safety', 'Mine.'),
        },
        onMain: {
          [CHARGING]: text('charging', 'Theirs.'),
          [SAFETY]: text('safety', 'Theirs.'),
        },
      });
      t.lock(charging);
      t.lock(safety);
      return t;
    };

    it('refuses to keep a file not saved since the conflict was reported', async () => {
      const t = conflicting();
      const before = t.head();
      const reported = conflictOf(await t.refresh().catch((e: unknown) => e));
      expect(reported.code).toBe('refresh-conflict');
      expect(
        (await t.reported.of(undefined as never, t.id)).map((r) => r.subject),
      ).toEqual([charging, safety]);
      await t.saved(charging, module('charging', 'en', 'Mine and theirs.'));
      // `safety` was never opened: "Update again" keeping both is refused.
      const error = conflictOf(
        await t.refresh({ keep: [charging, safety] }).catch((e: unknown) => e),
      );
      expect(error.code).toBe('refresh-unresolved');
      expect(error.meta).toEqual({
        unresolved: [{ path: SAFETY, subject: safety }],
        total: 1,
      });
      // Nothing written: no save point, no merge.
      expect(t.head()).toBe(before);
      expect(await t.copies.find(t.id, charging)).toBeDefined();
      expect(t.refreshes()).toEqual([]);
    });

    it('takes a discarded save for no resolution', async () => {
      const t = conflicting();
      await t.refresh().catch(() => undefined);
      await t.saved(charging, module('charging', 'en', 'Mine and theirs.'));
      // The resolution is thrown away: the branch's file is the old one again.
      await t.discarded(charging);
      const before = t.head();
      const error = conflictOf(
        await t
          .refresh({ keep: [charging], keepMine: [safety] })
          .catch((e: unknown) => e),
      );
      expect(error.code).toBe('refresh-unresolved');
      expect(error.meta).toMatchObject({ unresolved: [{ subject: charging }] });
      expect(t.head()).toBe(before);
      await t.saved(charging, module('charging', 'en', 'Again, resolved.'));
      expect(
        (await t.refresh({ keep: [charging], keepMine: [safety] })).updated,
      ).toBe(true);
    });

    it('refuses a kept file no update reported, and reports it so a save counts', async () => {
      const t = conflicting();
      // Saved, but before any report.
      await t.saved(charging, module('charging', 'en', 'Mine and theirs.'));
      await t.saved(safety, module('safety', 'en', 'Mine and theirs.'));
      const error = conflictOf(
        await t.refresh({ keep: [charging, safety] }).catch((e: unknown) => e),
      );
      expect(error.code).toBe('refresh-unresolved');
      expect(error.meta).toMatchObject({ total: 2 });
      expect(await t.reported.of(undefined as never, t.id)).toEqual([
        expect.objectContaining({ subject: charging, base: t.mainHead() }),
        expect.objectContaining({ subject: safety, base: t.mainHead() }),
      ]);
      await t.saved(charging, module('charging', 'en', 'Resolved.'));
      await t.saved(safety, module('safety', 'en', 'Resolved.'));
      const outcome = await t.refresh({ keep: [charging, safety] });
      expect(outcome.updated).toBe(true);
    });

    it('keeps a file saved since, and one kept by choice, auditing each', async () => {
      const t = conflicting();
      await t.refresh().catch(() => undefined);
      await t.saved(charging, module('charging', 'en', 'Mine and theirs.'));
      const outcome = await t.refresh({
        keep: [charging],
        keepMine: [safety],
      });
      expect(outcome.updated).toBe(true);
      expect(await t.file(CHARGING)).toBe(text('charging', 'Mine and theirs.'));
      // Kept as it was, without a save: main's change to it is dropped.
      expect(await t.file(SAFETY)).toBe(text('safety', 'Mine.'));
      expect(t.refreshes()[0]?.data).toMatchObject({
        kept: ['module/en/charging', 'module/en/safety'],
        resolvedByEditing: ['module/en/charging'],
        keptByChoice: ['module/en/safety'],
      });
    });

    it('commits files saved since as a save point, then keeps them', async () => {
      const t = conflicting();
      await t.refresh().catch(() => undefined);
      await t.saved(charging, module('charging', 'en', 'Mine and theirs.'));
      await t.saved(safety, module('safety', 'en', 'Mine and theirs.'));
      // A save point commits both; the report keeps its save.
      const outcome = await t.refresh({ keep: [charging, safety] });
      expect(outcome.savePoint).toBeDefined();
      expect(t.refreshes()[0]?.data).toMatchObject({
        resolvedByEditing: ['module/en/charging', 'module/en/safety'],
      });
    });

    it('asks again for a file main changed again since it was saved', async () => {
      const t = conflicting();
      await t.refresh().catch(() => undefined);
      const first = t.mainHead();
      await t.saved(charging, module('charging', 'en', 'Mine and theirs.'));
      await t.saved(safety, module('safety', 'en', 'Mine and theirs.'));
      // Main changes `charging` once more; `safety` stays as reported.
      t.push('main', { [CHARGING]: text('charging', 'Theirs, again.') });
      const error = conflictOf(
        await t.refresh({ keep: [charging, safety] }).catch((e: unknown) => e),
      );
      expect(error.code).toBe('refresh-unresolved');
      expect(error.meta).toMatchObject({
        unresolved: [{ subject: charging }],
      });
      const reports = await t.reported.of(undefined as never, t.id);
      expect(reports).toEqual([
        expect.objectContaining({ subject: charging, base: t.mainHead() }),
        expect.objectContaining({ subject: safety, base: first }),
      ]);
      expect(reports[0]?.savedAt).toBeUndefined();
      expect(reports[1]?.savedAt).toBeDefined();
      await t.saved(charging, module('charging', 'en', 'All three.'));
      expect((await t.refresh({ keep: [charging, safety] })).updated).toBe(
        true,
      );
    });

    it('does not ask about a kept file whose keeping changes nothing', async () => {
      // `safety` is named but conflicts nowhere: nothing of main's is dropped.
      const t = setUp({
        onBranch: { [CHARGING]: text('charging', 'Mine.') },
        onMain: { [CHARGING]: text('charging', 'Theirs.') },
      });
      t.lock(charging);
      const outcome = await t.refresh({ keep: [safety], keepMine: [charging] });
      expect(outcome.updated).toBe(true);
      expect(t.refreshes()[0]?.data).toMatchObject({
        resolvedByEditing: [],
        keptByChoice: ['module/en/charging'],
      });
    });
  });

  it('answers base-missing when the base branch is gone', async () => {
    const t = setUp();
    t.repository.heads.delete('main');
    const error = conflictOf(await t.refresh().catch((e: unknown) => e));
    expect(error.code).toBe('base-missing');
  });

  it('plans again when the branch moves meanwhile', async () => {
    const t = setUp({
      onBranch: { [CHARGING]: text('charging', 'Mine.') },
      onMain: { [SAFETY]: text('safety', 'Theirs.') },
    });
    let once = true;
    t.branches.beforeRefresh = (name) => {
      if (!once) return;
      once = false;
      t.push(name, { 'modules/en/other.adoc': text('other', 'Pushed.') });
    };
    const outcome = await t.refresh();
    expect(outcome.updated).toBe(true);
    expect(await t.file(SAFETY)).toBe(text('safety', 'Theirs.'));
  });

  it('records an update whose recording failed once it is tried again', async () => {
    const t = setUp({
      onBranch: { [CHARGING]: text('charging', 'Mine.') },
      onMain: { [SAFETY]: text('safety', 'Theirs.') },
    });
    t.audit.failing = true;
    await expect(t.refresh()).rejects.toThrow('the database is down');
    // Git landed; the database did not.
    expect(t.branches.commits.get(t.head())?.mergeOf).toBe(t.mainHead());
    expect((await t.store.find(t.id))?.baseCommit).toBe(t.changeSet.baseCommit);
    t.audit.failing = false;
    t.follow();
    const outcome = await t.refresh();
    expect(outcome.updated).toBe(false);
    expect(outcome.changeSet.baseCommit).toBe(t.mainHead());
    expect(t.refreshes()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ recovered: true, to: t.mainHead() }),
      }),
    ]);
  });
});
