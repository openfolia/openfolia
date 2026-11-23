import { ChangeSetAuthors } from '../change-set-authors.js';
import { FakeChangeSetSupersessions } from '../../../../tests/fakes/fake-supersessions.js';
import { printModule } from '@openfolia/content-model';
import { actorWith } from '../../../../tests/fakes/actors.js';
import { FakeApprovalStore } from '../../../../tests/fakes/fake-approval-store.js';
import { FakeAssetUploads } from '../../../../tests/fakes/fake-asset-uploads.js';
import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import { FakeCarryForwards } from '../../../../tests/fakes/fake-carry-forwards.js';
import { FakeChangeSetBranches } from '../../../../tests/fakes/fake-change-set-branches.js';
import { FakeChangeSetCommits } from '../../../../tests/fakes/fake-change-set-commits.js';
import { FakeChangeSetEvents } from '../../../../tests/fakes/fake-change-set-events.js';
import { FakeChangeSetStore } from '../../../../tests/fakes/fake-change-set-store.js';
import { FakeCommitIntents } from '../../../../tests/fakes/fake-commit-intents.js';
import { FakeSnapshot, module } from '../../../../tests/fakes/fake-content.js';
import { FakeLockStore } from '../../../../tests/fakes/fake-lock-store.js';
import { FakeMaintenanceLineStore } from '../../../../tests/fakes/fake-maintenance-lines.js';
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
import type { MaintenanceLine } from '../../../releases/core/maintenance-line.js';
import { CarryChange } from '../carry-change.js';
import { ChangeSetAuthoredBranches } from '../change-set-authored-branches.js';
import {
  type ChangeSet,
  changeSetBranch,
  newChangeSetId,
} from '../change-set.js';
import { CommitRecorder } from '../commit-recorder.js';
import { type LockSubject, newLockId } from '../lock.js';
import { DeprecationEvents } from '../deprecation-events.js';
import { Workflow } from '../workflow.js';
import { LockHolding } from '../lock-holding.js';
import { AcquireLockAction } from './acquire-lock.action.js';
import { CarryForwardChangeSetAction } from './carry-forward-change-set.action.js';

const LINE_BRANCH = 'maintenance/tuggers/2.1';
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
 * A change set merged into a maintenance line, having changed `charging`
 * (and, with `alsoSafety`, `safety`), and `main` moved on, changing
 * whatever `onMain` says.
 */
function setUp(
  options: {
    onMain?: Record<string, string>;
    alsoSafety?: boolean;
    /** What the change set makes of `charging`, in place of the fix. */
    chargingAs?: string;
  } = {},
) {
  const branches = new FakeChangeSetBranches();
  const base = new FakeSnapshot({
    modules: [module('charging', 'en', 'Old.'), module('safety', 'en', 'Old.')],
  });
  branches.heads.set('main', base.commit);
  branches.heads.set(LINE_BRANCH, base.commit);
  const now = new Date();
  const sourceId = newChangeSetId();
  const sourceBranch = changeSetBranch(sourceId);
  branches.heads.set(sourceBranch, base.commit);
  const reviewHead = branches.push(sourceBranch, {
    changes: [
      {
        path: 'modules/en/charging.adoc',
        content: options.chargingAs ?? text('charging', 'Fixed.'),
      },
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
  let mainHead = base.commit;
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
    reviewHead,
    new FakeSnapshot(
      {
        modules: [
          {
            ...module('charging', 'en', 'Fixed.'),
            blocks: [
              ...module('charging', 'en', 'Fixed.').blocks,
              {
                type: 'paragraph',
                id: 'added',
                content: [{ type: 'text', text: 'New.' }],
              },
            ],
          },
          module('safety', 'en', options.alsoSafety ? 'Fixed.' : 'Old.'),
        ],
      },
      reviewHead,
    ),
  );
  const source: ChangeSet = {
    id: sourceId,
    title: 'Fix a typo',
    description: null,
    author: { kind: 'user', id: author.id },
    baseRef: LINE_BRANCH,
    baseCommit: base.commit,
    baseReleased: true,
    branch: sourceBranch,
    state: 'merged',
    reviewHead,
    mergeCommit: reviewHead,
    createdAt: now,
    updatedAt: now,
  };
  const line: MaintenanceLine = {
    id: newChangeSetId(),
    product: 'tuggers',
    revision: '2.1',
    baseRelease: newChangeSetId(),
    baseCommit: base.commit,
    branch: LINE_BRANCH,
    createdBy: { kind: 'user', id: 'sample-publisher' },
    createdAt: now,
    closedAt: null,
    closedBy: null,
  };
  const store = new FakeChangeSetStore([source]);
  const lines = new FakeMaintenanceLineStore();
  lines.rows.push(line);
  const carries = new FakeCarryForwards(store);
  const locks = new FakeLockStore();
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
      carries,
      new FakeChangeSetSupersessions(store),
    ),
  );
  const assets = new FakeAssetUploads();
  const carry = new CarryForwardChangeSetAction(
    store,
    lines,
    carries,
    new ReadableRefs(repository),
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
      new ReadableAssets(assets),
      store,
      locks,
      copies,
      recorder,
      intents,
      unit,
    ),
    audit,
    events,
    unit,
  );
  return {
    assets,
    unit,
    source,
    line,
    main,
    branches,
    store,
    lines,
    carries,
    locks,
    audit,
    events,
    commits,
    workflow,
    carry: (actor: Actor = author, id = sourceId) =>
      carry.handle({ actor, id }),
  };
}

describe('CarryForwardChangeSetAction', () => {
  it('applies a clean fix as a new draft on main, its diff the original’s, locked and audited', async () => {
    const t = setUp();
    const outcome = await t.carry();
    expect(outcome.changeSet).toMatchObject({
      title: 'Carry forward: Fix a typo',
      author: { kind: 'user', id: author.id },
      baseRef: 'main',
      baseCommit: t.main.commit,
      state: 'draft',
    });
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.applied).toEqual([charging]);
    const made = t.branches.commits.get(outcome.commit as string);
    expect(made).toMatchObject({
      branch: outcome.changeSet.branch,
      parent: t.main.commit,
      changes: [
        {
          path: 'modules/en/charging.adoc',
          content: text('charging', 'Fixed.'),
        },
      ],
    });
    // The same diff as the original's.
    expect(
      await t.branches.changedPaths(t.main.commit, outcome.commit as string),
    ).toEqual(
      await t.branches.changedPaths(
        t.source.baseCommit,
        t.source.reviewHead as string,
      ),
    );
    expect(t.locks.locks.map((l) => [l.subject, l.changeSetId])).toEqual([
      [charging, outcome.changeSet.id],
    ]);
    expect(t.commits.records).toHaveLength(1);
    expect(t.carries.links).toEqual([
      { changeSetId: outcome.changeSet.id, sourceId: t.source.id },
    ]);
    const actions = t.audit.events.map((e) => e.action);
    expect(actions).toEqual([
      'change-set.create',
      'lock.acquire',
      'change-set.commit',
      'module.write',
      'change-set.carry-forward',
    ]);
    expect(t.audit.events[0]?.data).toMatchObject({
      carriedForwardFrom: t.source.id,
    });
    expect(t.audit.events.at(-1)).toMatchObject({
      subject: { type: 'change-set', id: t.source.id },
      data: {
        changeSetId: outcome.changeSet.id,
        maintenanceLine: t.line.id,
        commit: outcome.commit,
        applied: 1,
        conflicts: 0,
      },
    });
    expect(t.events.events).toEqual([
      expect.objectContaining({
        topic: 'change-set.carry-forward',
        key: outcome.changeSet.id,
        payload: expect.objectContaining({
          sourceId: t.source.id,
          changeSetId: outcome.changeSet.id,
        }),
      }),
    ]);
  });

  it('lists a conflicting module with the blocks it changed, leaves it unchanged and applies the rest', async () => {
    const t = setUp({
      alsoSafety: true,
      onMain: { 'modules/en/charging.adoc': text('charging', 'Reworded.') },
    });
    const outcome = await t.carry();
    expect(outcome.conflicts).toEqual([
      {
        path: 'modules/en/charging.adoc',
        subject: charging,
        kinds: ['contents'],
        blockIds: ['p', 'added'],
      },
    ]);
    expect(outcome.applied).toEqual([safety]);
    expect(
      t.branches.commits
        .get(outcome.commit as string)
        ?.changes.map((c) => c.path),
    ).toEqual(['modules/en/safety.adoc']);
    // Locked too, for its author to fix in the editor.
    expect(t.locks.locks.map((l) => l.subject)).toEqual([safety, charging]);
  });

  it('makes no commit when nothing applies, and lists why', async () => {
    const t = setUp({
      onMain: { 'modules/en/charging.adoc': text('charging', 'Reworded.') },
    });
    const outcome = await t.carry();
    expect(outcome.commit).toBeUndefined();
    expect(outcome.applied).toEqual([]);
    expect(outcome.conflicts).toHaveLength(1);
    expect(t.branches.heads.get(outcome.changeSet.branch)).toBe(t.main.commit);
    expect(t.audit.events.at(-1)?.action).toBe('change-set.carry-forward');
  });

  it('leaves merged content outside the actor’s scope, as forbidden alone, though the lock was granted', async () => {
    // The change set made charging a type its author no longer edits.
    const fixed = module('charging', 'en', 'Fixed.');
    const t = setUp({
      alsoSafety: true,
      chargingAs: printModule({
        ...fixed,
        meta: { ...fixed.meta, type: 'other' },
      }),
    });
    const outcome = await t.carry(editor({ moduleTypes: ['concept'] }));
    expect(outcome.conflicts).toEqual([
      {
        path: 'modules/en/charging.adoc',
        subject: charging,
        kinds: ['forbidden'],
      },
    ]);
    expect(outcome.applied).toEqual([safety]);
    expect(
      t.branches.commits
        .get(outcome.commit as string)
        ?.changes.map((c) => c.path),
    ).toEqual(['modules/en/safety.adoc']);
  });

  it('leaves a module naming a file the actor may not use, as unknown-asset, applying the rest (#335)', async () => {
    const hash = 'e'.repeat(64);
    const fixed = module('charging', 'en', 'Fixed.');
    const withImage = printModule({
      ...fixed,
      blocks: [
        ...fixed.blocks,
        { type: 'image', id: 'i', asset: `sha256:${hash}`, alt: 'x' },
      ],
    });
    // Uploaded into a change set of the original's author only, and used
    // neither on `main` nor at the line's head (here the line moved on
    // without it): another editor carrying it forward may not use it.
    const t = setUp({ alsoSafety: true, chargingAs: withImage });
    await t.unit.run((tx) =>
      t.assets.record(tx, {
        changeSetId: t.source.id,
        sha256: hash,
        size: 1,
        contentType: 'image/png',
        uploadedBy: { kind: 'user', id: author.id },
      }),
    );
    const outcome = await t.carry(editor({}, 'sample-other-editor'));
    expect(outcome.conflicts).toMatchObject([
      {
        path: 'modules/en/charging.adoc',
        subject: charging,
        kinds: ['unknown-asset'],
      },
    ]);
    expect(outcome.applied).toEqual([safety]);

    // Its author uploaded it: carried.
    const again = setUp({ chargingAs: withImage });
    await again.unit.run((tx) =>
      again.assets.record(tx, {
        changeSetId: again.source.id,
        sha256: hash,
        size: 1,
        contentType: 'image/png',
        uploadedBy: { kind: 'user', id: author.id },
      }),
    );
    expect((await again.carry()).applied).toEqual([charging]);
  });

  it('leaves a subject another change set holds, as locked', async () => {
    const t = setUp();
    t.locks.locks.push({
      id: newLockId(),
      subject: charging,
      changeSetId: newChangeSetId(),
      holder: { kind: 'user', id: 'someone' },
      since: new Date(),
    });
    const outcome = await t.carry();
    expect(outcome.conflicts).toEqual([
      expect.objectContaining({
        path: 'modules/en/charging.adoc',
        kinds: ['locked'],
      }),
    ]);
    expect(outcome.commit).toBeUndefined();
  });

  it('is 409 for main holding it already, for a change set not merged or not on a line, and when carried already', async () => {
    const same = setUp({
      onMain: { 'modules/en/charging.adoc': text('charging', 'Fixed.') },
    });
    await expect(same.carry()).rejects.toMatchObject({ code: 'no-changes' });
    expect(same.store.changeSets).toHaveLength(1);

    const draft = setUp();
    draft.store.changeSets[0] = { ...draft.source, state: 'approved' };
    await expect(draft.carry()).rejects.toMatchObject({
      code: 'invalid-state',
      meta: { state: 'approved' },
    });

    const onMain = setUp();
    onMain.store.changeSets[0] = { ...onMain.source, baseRef: 'main' };
    await expect(onMain.carry()).rejects.toMatchObject({
      code: 'not-on-maintenance-line',
    });

    const twice = setUp();
    const first = await twice.carry();
    await expect(twice.carry()).rejects.toMatchObject({
      code: 'already-carried-forward',
      meta: { changeSetId: first.changeSet.id },
    });
    // Once that draft is abandoned, it may be carried again.
    const index = twice.store.changeSets.findIndex(
      (c) => c.id === first.changeSet.id,
    );
    twice.store.changeSets[index] = {
      ...first.changeSet,
      state: 'abandoned',
    };
    // Abandoning released its locks.
    twice.locks.locks.length = 0;
    await expect(twice.carry()).resolves.toMatchObject({
      applied: [charging],
    });
  });

  it('is the author’s, or an editor’s whose scope covers all of it; another’s is 404 without drafts', async () => {
    const t = setUp();
    await expect(
      t.carry(editor({ languages: ['de'] }, 'narrow-editor')),
    ).rejects.toThrow(ForbiddenError);
    const noDrafts: Actor = {
      ...actorWith(['content.read', 'content.edit']),
      id: 'other',
    };
    await expect(t.carry(noDrafts)).rejects.toThrow(NotFoundError);
    await expect(t.carry(actorWith(['content.read']))).rejects.toThrow(
      ForbiddenError,
    );
    expect(t.store.changeSets).toHaveLength(1);
    const outcome = await t.carry(editor({}, 'other-editor'));
    expect(outcome.changeSet.author).toEqual({
      kind: 'user',
      id: 'other-editor',
    });
  });

  it('names who wrote the carried change set in its commit: they stay its authors (#597)', async () => {
    const t = setUp();
    // The fix's own commit was the API's, carrying what someone else wrote before.
    const { pushed: _pushed, ...fix } = t.branches.commits.get(
      t.source.reviewHead as string,
    ) as NonNullable<ReturnType<typeof t.branches.commits.get>>;
    t.branches.commits.set(t.source.reviewHead as string, {
      ...fix,
      carried: [{ kind: 'user', id: 'first-writer' }],
    });
    const outcome = await t.carry(editor({}, 'other-editor'));
    const made = t.branches.commits.get(outcome.commit as string);
    expect(made?.author).toEqual({ kind: 'user', id: 'other-editor' });
    expect(made?.carried).toEqual([
      { kind: 'user', id: author.id },
      { kind: 'user', id: 'first-writer' },
    ]);
    expect(
      await t.workflow.authorsOf(outcome.changeSet, outcome.commit as string),
    ).toEqual([
      { kind: 'user', id: 'other-editor' },
      { kind: 'user', id: author.id },
      { kind: 'user', id: 'first-writer' },
    ]);
  });
});
