import { ChangeSetAuthors } from '../change-set-authors.js';
import { FakeCarryForwards } from '../../../../tests/fakes/fake-carry-forwards.js';
import { printModule } from '@openfolia/content-model';
import { actorWith } from '../../../../tests/fakes/actors.js';
import { FakeApprovalStore } from '../../../../tests/fakes/fake-approval-store.js';
import { FakeAssetUploads } from '../../../../tests/fakes/fake-asset-uploads.js';
import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import { FakeChangeSetBranches } from '../../../../tests/fakes/fake-change-set-branches.js';
import { FakeChangeSetCommits } from '../../../../tests/fakes/fake-change-set-commits.js';
import { FakeChangeSetEvents } from '../../../../tests/fakes/fake-change-set-events.js';
import { FakeChangeSetStore } from '../../../../tests/fakes/fake-change-set-store.js';
import { FakeCommitIntents } from '../../../../tests/fakes/fake-commit-intents.js';
import {
  FakeSnapshot,
  fakeCommitId,
  module,
} from '../../../../tests/fakes/fake-content.js';
import { FakeLockStore } from '../../../../tests/fakes/fake-lock-store.js';
import { FakeChangeSetSupersessions } from '../../../../tests/fakes/fake-supersessions.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import { FakeWorkingCopyStore } from '../../../../tests/fakes/fake-working-copy-store.js';
import type { Actor, Scope } from '../../../access/core/actor.js';
import { ReadableAssets } from '../../../assets/core/readable-assets.js';
import { ForbiddenError, NotFoundError } from '../../../base/core/errors.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import {
  ContentRepository,
  type ContentSnapshot,
} from '../../../content/core/content.repository.js';
import { ReadableRefs } from '../../../content/core/readable-refs.js';
import { CarryChange } from '../carry-change.js';
import { LockHolding } from '../lock-holding.js';
import { ChangeSetAuthoredBranches } from '../change-set-authored-branches.js';
import { ChangeSetBehind } from '../change-set-behind.js';
import {
  type ChangeSet,
  changeSetBranch,
  newChangeSetId,
} from '../change-set.js';
import { CommitRecorder } from '../commit-recorder.js';
import { DeprecationEvents } from '../deprecation-events.js';
import { type LockSubject, newLockId } from '../lock.js';
import { Workflow } from '../workflow.js';
import { AcquireLockAction } from './acquire-lock.action.js';
import type { CommitWorkingCopiesAction } from './commit-working-copies.action.js';
import { RebaseChangeSetAction } from './rebase-change-set.action.js';

const editor = (scope: Scope = {}, id = 'sample-author'): Actor => ({
  ...actorWith(['content.read', 'content.read.draft', 'content.edit'], scope),
  id,
});
const author = editor();
const charging: LockSubject = {
  type: 'module',
  lang: 'en',
  moduleId: 'charging',
};
const safety: LockSubject = { type: 'module', lang: 'en', moduleId: 'safety' };
const text = (id: string, words: string) =>
  printModule(module(id, 'en', words));

/** Branches resolve to the snapshot of the commit the fake branches name. */
class Repository extends ContentRepository {
  readonly commits = new Map<string, ContentSnapshot>();
  constructor(
    private readonly branches: FakeChangeSetBranches,
    public main: ContentSnapshot,
  ) {
    super();
  }

  async at(ref: string): Promise<ContentSnapshot | undefined> {
    if (ref === 'main') return this.main;
    const head = this.branches.heads.get(ref) ?? ref;
    return head === this.main.commit
      ? this.main
      : (this.commits.get(head) ?? this.main);
  }

  async refs() {
    return {
      branches: [
        { name: 'main', commit: this.main.commit },
        ...[...this.branches.heads]
          .filter(([name]) => name !== 'main')
          .map(([name, commit]) => ({ name, commit })),
      ],
      tags: [],
    };
  }
}

/**
 * A draft on `main` that changed `charging` (and, with `alsoSafety`,
 * `safety`) and holds their locks, then `main` rewritten (a new root, its
 * history without the change set's base commit), changing whatever
 * `onMain` says; with `rewritten: false`, `main` only moved on.
 */
function setUp(
  options: {
    onMain?: Record<string, string>;
    alsoSafety?: boolean;
    rewritten?: boolean;
    state?: ChangeSet['state'];
  } = {},
) {
  const branches = new FakeChangeSetBranches();
  const base = new FakeSnapshot({
    modules: [module('charging', 'en', 'Old.'), module('safety', 'en', 'Old.')],
  });
  branches.heads.set('main', base.commit);
  const now = new Date();
  const sourceId = newChangeSetId();
  const sourceBranch = changeSetBranch(sourceId);
  branches.heads.set(sourceBranch, base.commit);
  const head = branches.push(sourceBranch, {
    changes: [
      { path: 'modules/en/charging.adoc', content: text('charging', 'Fixed.') },
      ...(options.alsoSafety
        ? [
            {
              path: 'modules/en/safety.adoc',
              content: text('safety', 'Fixed.'),
            },
          ]
        : []),
    ],
    message: 'Fix',
    author: { kind: 'user', id: author.id },
    changeSetId: sourceId,
  });
  // Rewritten: a root the fake did not make, so the base commit is not in
  // its history.
  if (options.rewritten ?? true) branches.heads.set('main', fakeCommitId());
  let mainHead = branches.heads.get('main') as string;
  if (options.onMain) {
    mainHead = branches.push('main', {
      changes: Object.entries(options.onMain).map(([path, content]) => ({
        path,
        content,
      })),
      message: 'Main moved on',
      author: { kind: 'user', id: 'someone' },
      changeSetId: newChangeSetId(),
    });
  } else if (options.rewritten === false) {
    mainHead = branches.push('main', {
      changes: [{ path: 'modules/en/other.adoc', content: 'x' }],
      message: 'Main moved on',
      author: { kind: 'user', id: 'someone' },
      changeSetId: newChangeSetId(),
    });
  }
  const main = new FakeSnapshot(
    {
      modules: [
        module('charging', 'en', 'Old.'),
        module('safety', 'en', 'Old.'),
      ],
    },
    mainHead,
  );
  const repository = new Repository(branches, main);
  repository.commits.set(base.commit, base);
  repository.commits.set(
    head,
    new FakeSnapshot(
      {
        modules: [
          module('charging', 'en', 'Fixed.'),
          module('safety', 'en', options.alsoSafety ? 'Fixed.' : 'Old.'),
        ],
      },
      head,
    ),
  );
  const source: ChangeSet = {
    id: sourceId,
    title: 'Charging wording',
    description: 'Clearer charging steps.',
    author: { kind: 'user', id: author.id },
    baseRef: 'main',
    baseCommit: base.commit,
    baseReleased: true,
    branch: sourceBranch,
    state: options.state ?? 'draft',
    ...(options.state === 'in-review' && { reviewHead: head }),
    createdAt: now,
    updatedAt: now,
  };
  const store = new FakeChangeSetStore([source]);
  const supersessions = new FakeChangeSetSupersessions(store);
  const locks = new FakeLockStore();
  for (const subject of options.alsoSafety ? [charging, safety] : [charging]) {
    locks.locks.push({
      id: newLockId(),
      subject,
      changeSetId: sourceId,
      holder: { kind: 'user', id: author.id },
      since: now,
    });
  }
  const copies = new FakeWorkingCopyStore();
  const audit = new FakeAuditLog();
  const events = new FakeChangeSetEvents();
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
  const workflow = new Workflow(
    store,
    new FakeApprovalStore(),
    events,
    audit,
    branches,
    open,
    locks,
    copies,
    new DeprecationEvents(repository),
    new ChangeSetAuthors(
      branches,
      store,
      new FakeCarryForwards(store),
      supersessions,
    ),
  );
  // Committing working copies is its own action, tested on its own: here
  // only that it is asked, and for whom.
  const committed: { actor: Actor; changeSetId: string }[] = [];
  const commitWorkingCopies = {
    handle: async (input: { actor: Actor; changeSetId: string }) => {
      committed.push(input);
      copies.copies.clear();
      return {};
    },
  } as unknown as CommitWorkingCopiesAction;
  const refs = new ReadableRefs(repository);
  const action = new RebaseChangeSetAction(
    store,
    supersessions,
    refs,
    branches,
    workflow,
    new CarryChange(
      branches,
      new AcquireLockAction(
        store,
        locks,
        open,
        audit,
        unit,
        new LockHolding(store, copies, branches),
      ),
      open,
      new ReadableAssets(new FakeAssetUploads()),
      store,
      locks,
      copies,
      recorder,
      intents,
      unit,
    ),
    commitWorkingCopies,
    locks,
    copies,
    audit,
    events,
    unit,
  );
  const saveCopy = (subject: LockSubject) =>
    unit.run((tx) =>
      copies.save(
        tx,
        {
          changeSetId: sourceId,
          subject,
          content: module('charging', 'en', 'Typed.'),
          baseCommit: head,
          updatedBy: { kind: 'user', id: author.id },
        },
        0,
      ),
    );
  return {
    source,
    head,
    main,
    branches,
    store,
    supersessions,
    locks,
    audit,
    events,
    unit,
    committed,
    saveCopy,
    behind: new ChangeSetBehind(branches, refs),
    rebase: (actor: Actor = author, id = sourceId) =>
      action.handle({ actor, id }),
  };
}

describe('RebaseChangeSetAction', () => {
  it('says the base was rewritten, with no count, where it was', async () => {
    const t = setUp();
    expect(await t.behind.of(author, t.source)).toEqual({
      base: 'rewritten',
      behind: null,
    });
    const moved = setUp({ rewritten: false });
    expect(await moved.behind.of(author, moved.source)).toEqual({
      base: 'current',
      behind: 1,
    });
  });

  it('moves the change set’s own changes onto the rewritten main as a new draft, and supersedes it', async () => {
    const t = setUp();
    const outcome = await t.rebase();
    expect(outcome.changeSet).toMatchObject({
      title: 'Charging wording',
      description: 'Clearer charging steps.',
      author: { kind: 'user', id: author.id },
      baseRef: 'main',
      baseCommit: t.main.commit,
      state: 'draft',
    });
    expect(outcome.changeSet.id).not.toBe(t.source.id);
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.applied).toEqual([charging]);
    // Exactly the old one's own change, on the new main.
    expect(t.branches.commits.get(outcome.commit as string)).toMatchObject({
      branch: outcome.changeSet.branch,
      parent: t.main.commit,
      changes: [
        {
          path: 'modules/en/charging.adoc',
          content: text('charging', 'Fixed.'),
        },
      ],
    });
    expect(outcome.source.state).toBe('abandoned');
    expect(t.supersessions.links).toEqual([
      { changeSetId: outcome.changeSet.id, supersededId: t.source.id },
    ]);
    expect(await t.supersessions.linksOf(t.source.id)).toEqual({
      supersededBy: outcome.changeSet.id,
    });
    // Its lock went over to the new change set.
    expect(t.locks.locks.map((l) => [l.subject, l.changeSetId])).toEqual([
      [charging, outcome.changeSet.id],
    ]);
    expect(t.audit.events.map((e) => e.action)).toEqual([
      'change-set.create',
      'lock.release',
      'lock.acquire',
      'change-set.commit',
      'module.write',
      'change-set.abandon',
      'change-set.rebase',
    ]);
    const [created, released] = t.audit.events;
    expect(created?.data).toMatchObject({ supersedes: t.source.id });
    expect(released).toMatchObject({
      data: { changeSetId: t.source.id, reason: 'change-set.rebase' },
    });
    expect(
      t.audit.events.find((e) => e.action === 'change-set.abandon'),
    ).toMatchObject({
      subject: { type: 'change-set', id: t.source.id },
      data: {
        from: 'draft',
        to: 'abandoned',
        supersededBy: outcome.changeSet.id,
      },
    });
    expect(t.audit.events.at(-1)).toMatchObject({
      subject: { type: 'change-set', id: t.source.id },
      data: {
        changeSetId: outcome.changeSet.id,
        onto: t.main.commit,
        commit: outcome.commit,
        applied: 1,
        conflicts: 0,
      },
    });
    expect(t.events.events).toContainEqual(
      expect.objectContaining({
        topic: 'change-set.abandon',
        key: t.source.id,
      }),
    );
  });

  it('lists a module the new main changed too with the blocks it changed, applying the rest', async () => {
    const t = setUp({
      alsoSafety: true,
      onMain: { 'modules/en/charging.adoc': text('charging', 'Reworded.') },
    });
    const outcome = await t.rebase();
    expect(outcome.conflicts).toEqual([
      {
        path: 'modules/en/charging.adoc',
        subject: charging,
        kinds: ['contents'],
        blockIds: ['p'],
      },
    ]);
    expect(outcome.applied).toEqual([safety]);
    // Both locked for the new change set, for its author to fix in the editor.
    expect(
      t.locks.locks.every((l) => l.changeSetId === outcome.changeSet.id),
    ).toBe(true);
    expect(t.locks.locks.map((l) => l.subject)).toEqual([safety, charging]);
    expect(outcome.source.state).toBe('abandoned');
  });

  it('moves one in review too: approvals do not carry over', async () => {
    const t = setUp({ state: 'in-review' });
    const outcome = await t.rebase();
    expect(outcome.changeSet.state).toBe('draft');
    expect(outcome.changeSet.reviewHead).toBeUndefined();
    expect(outcome.source.state).toBe('abandoned');
  });

  it('commits a draft’s working copies first; refuses one in review while it has some', async () => {
    const review = setUp({ state: 'in-review' });
    await review.saveCopy(charging);
    await expect(review.rebase()).rejects.toMatchObject({
      code: 'uncommitted-working-copies',
      meta: { subjects: [charging] },
    });
    expect(review.store.changeSets).toHaveLength(1);

    const t = setUp();
    await t.saveCopy(charging);
    await t.rebase();
    expect(t.committed).toEqual([{ actor: author, changeSetId: t.source.id }]);
  });

  it('is 409 for a base not rewritten, a closed change set, and one superseded already', async () => {
    const current = setUp({ rewritten: false });
    await expect(current.rebase()).rejects.toMatchObject({
      code: 'base-not-rewritten',
    });
    expect(current.store.changeSets).toHaveLength(1);

    const closed = setUp({ state: 'abandoned' });
    await expect(closed.rebase()).rejects.toMatchObject({
      code: 'invalid-state',
      meta: { state: 'abandoned' },
    });

    const twice = setUp();
    const first = await twice.rebase();
    // Closed now: refused, naming where its changes are (another tab, a retry that went through).
    await expect(twice.rebase()).rejects.toMatchObject({
      code: 'already-superseded',
      meta: { changeSetId: first.changeSet.id },
    });
    // Open again, superseded by another's draft: refused, naming it.
    twice.store.changeSets[0] = { ...twice.source, state: 'draft' };
    const index = twice.store.changeSets.findIndex(
      (c) => c.id === first.changeSet.id,
    );
    twice.store.changeSets[index] = {
      ...first.changeSet,
      author: { kind: 'user', id: 'someone-else' },
    };
    await expect(twice.rebase()).rejects.toMatchObject({
      code: 'already-superseded',
      meta: { changeSetId: first.changeSet.id },
    });
  });

  it('goes on with its own draft when a request was cut off before the save point', async () => {
    const t = setUp();
    // What the first request left: the new draft, linked, nothing on it.
    const id = newChangeSetId();
    const draft: ChangeSet = {
      ...t.source,
      id,
      branch: changeSetBranch(id),
      baseCommit: t.main.commit,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    t.branches.heads.set(draft.branch, t.main.commit);
    t.store.changeSets.push(draft);
    await t.unit.run((tx) =>
      t.supersessions.record(tx, {
        changeSetId: id,
        supersededId: t.source.id,
      }),
    );
    const outcome = await t.rebase();
    expect(outcome.changeSet.id).toBe(id);
    expect(outcome.applied).toEqual([charging]);
    expect(t.store.changeSets).toHaveLength(2);
    expect(outcome.source.state).toBe('abandoned');

    // Cut off after the commit landed: only the old one is closed.
    const landed = setUp();
    const next = newChangeSetId();
    const moved: ChangeSet = {
      ...landed.source,
      id: next,
      branch: changeSetBranch(next),
      baseCommit: landed.main.commit,
    };
    landed.branches.heads.set(moved.branch, fakeCommitId());
    landed.store.changeSets.push(moved);
    await landed.unit.run((tx) =>
      landed.supersessions.record(tx, {
        changeSetId: next,
        supersededId: landed.source.id,
      }),
    );
    const finished = await landed.rebase();
    expect(finished.changeSet.id).toBe(next);
    expect(finished.source.state).toBe('abandoned');
    expect(landed.audit.events.at(-1)?.action).toBe('change-set.rebase');
  });

  it('is its author’s only; another’s is 404 without drafts, and nothing is touched', async () => {
    const t = setUp();
    // An editor over all of it does not close someone else’s change set either.
    await expect(t.rebase(editor({}, 'other-editor'))).rejects.toThrow(
      ForbiddenError,
    );
    const noDrafts: Actor = {
      ...actorWith(['content.read', 'content.edit']),
      id: 'other',
    };
    await expect(t.rebase(noDrafts)).rejects.toThrow(NotFoundError);
    await expect(t.rebase(actorWith(['content.read']))).rejects.toThrow(
      ForbiddenError,
    );
    expect(t.store.changeSets).toHaveLength(1);
    expect(t.source.state).toBe('draft');
    const outcome = await t.rebase();
    expect(outcome.changeSet.author).toEqual({
      kind: 'user',
      id: 'sample-author',
    });
    expect(outcome.applied).toEqual([charging]);
  });
});
