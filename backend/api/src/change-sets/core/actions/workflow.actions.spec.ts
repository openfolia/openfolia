import { ChangeSetAuthors } from '../change-set-authors.js';
import { FakeCarryForwards } from '../../../../tests/fakes/fake-carry-forwards.js';
import { FakeRefreshConflicts } from '../../../../tests/fakes/fake-refresh-conflicts.js';
import { FakeChangeSetSupersessions } from '../../../../tests/fakes/fake-supersessions.js';
import {
  type Module,
  printConfig,
  printModule,
  ProjectConfig,
} from '@openfolia/content-model';
import { actorWith } from '../../../../tests/fakes/actors.js';
import { FakeApprovalStore } from '../../../../tests/fakes/fake-approval-store.js';
import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import { FakeCommitIntents } from '../../../../tests/fakes/fake-commit-intents.js';
import {
  FakeChangeSetBranches,
  fakeTree,
} from '../../../../tests/fakes/fake-change-set-branches.js';
import { FakeChangeSetCommits } from '../../../../tests/fakes/fake-change-set-commits.js';
import { FakeChangeSetEvents } from '../../../../tests/fakes/fake-change-set-events.js';
import { FakeChangeSetStore } from '../../../../tests/fakes/fake-change-set-store.js';
import {
  config as baseConfig,
  type FakeContent,
  FakeSnapshot,
  module,
} from '../../../../tests/fakes/fake-content.js';
import { FakeLockStore } from '../../../../tests/fakes/fake-lock-store.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import { FakeUserDirectory } from '../../../../tests/fakes/fake-user-directory.js';
import { FakeWorkingCopyStore } from '../../../../tests/fakes/fake-working-copy-store.js';
import type { Actor, Scope } from '../../../access/core/actor.js';
import type { Permission } from '../../../access/core/permissions.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../../base/core/errors.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import { FakeSelfApprovalRule } from '../../../../tests/fakes/fake-installation-settings-store.js';
import {
  ContentRepository,
  type ContentSnapshot,
} from '../../../content/core/content.repository.js';
import {
  type ChangeSet,
  type ChangeSetState,
  changeSetBranch,
  newChangeSetId,
} from '../change-set.js';
import { ApprovalStanding } from '../approval-standing.js';
import { ChangeSetAuthoredBranches } from '../change-set-authored-branches.js';
import { CommitRecorder } from '../commit-recorder.js';
import { newLockId } from '../lock.js';
import { DeprecationEvents } from '../deprecation-events.js';
import { NO_OWN_SIGN_OFF, NOT_YOUR_OWN, Workflow } from '../workflow.js';
import { AbandonChangeSetAction } from './abandon-change-set.action.js';
import { ApproveChangeSetAction } from './approve-change-set.action.js';
import { GetChangeSetAction } from './get-change-set.action.js';
import { GetChangeSetReviewAction } from './get-change-set-review.action.js';
import { MergeChangeSetAction } from './merge-change-set.action.js';
import {
  MAX_MERGE_PAGES_PER_RUN,
  MERGES_PAGE_SIZE,
  ReconcileChangeSetMergesAction,
} from './reconcile-change-set-merges.action.js';
import { ReturnChangeSetAction } from './return-change-set.action.js';
import { SignOffChangeSetAction } from './sign-off-change-set.action.js';
import { SubmitChangeSetAction } from './submit-change-set.action.js';

const READS: Permission[] = ['content.read', 'content.read.draft'];
const user = (
  id: string,
  permissions: Permission[],
  scope: Scope = {},
): Actor => ({
  ...actorWith([...READS, ...permissions], scope),
  id,
});
const author = user('sample-author', ['content.edit']);
const otherEditor = user('other-editor', ['content.edit']);
const narrowEditor = user('narrow-editor', ['content.edit'], {
  moduleTypes: ['concept'],
});
const reviewer = user('sample-reviewer', ['content.review']);
const narrowReviewer = user('narrow-reviewer', ['content.review'], {
  languages: ['de'],
});
const approver = user('sample-approver', ['content.approve'], {
  moduleTypes: ['safety'],
});
const publisher = user('sample-publisher', ['release.publish']);
const narrowPublisher = user('narrow-publisher', ['release.publish'], {
  moduleTypes: ['concept'],
});
/** An author reviewing and publishing: still never their own. */
const selfReviewer = user('sample-author', [
  'content.edit',
  'content.review',
  'content.approve',
  'release.publish',
]);
/** Holds the permissions but not `content.read.draft`: others' change sets are not there. */
const blind: Actor = {
  ...actorWith([
    'content.read',
    'content.edit',
    'content.review',
    'content.approve',
    'release.publish',
  ]),
  id: 'blind',
};

/** The users of the directory approvals are checked against. */
const EVERYONE = [
  author,
  otherEditor,
  narrowEditor,
  reviewer,
  narrowReviewer,
  approver,
  publisher,
  narrowPublisher,
  blind,
];

const config = ProjectConfig.parse({
  ...baseConfig,
  moduleTypes: [
    { id: 'concept', label: 'Concept' },
    { id: 'safety', label: 'Safety', restricted: true },
  ],
});

const safetyModule = (text = 'Mind the edge.'): Module => {
  const m = module('safety-note', 'en', text);
  return { ...m, meta: { ...m.meta, type: 'safety' } };
};

class FakeRepository extends ContentRepository {
  readonly byRef = new Map<string, ContentSnapshot>();
  main!: ContentSnapshot;
  async at(ref: string) {
    return ref === 'main' ? this.main : this.byRef.get(ref);
  }
  async refs() {
    return { branches: [{ name: 'main', commit: this.main.commit }], tags: [] };
  }
}

/**
 * A change set started from `main`, with one commit on its branch
 * changing `charging` (and `safety-note` with `safety: true`).
 */
function setUp(
  options: {
    safety?: boolean;
    state?: ChangeSetState;
    /** The change also deprecates `charging` (#266). */
    deprecate?: boolean;
    /** The branch it is based on (a maintenance line, #60); `main` by default. */
    baseRef?: string;
    /** The change also writes the configuration under its earlier name, `ccms.yaml` (#372). */
    legacyConfig?: boolean;
    /**
     * The base has the configuration under its earlier name alone, and the change writes
     * `openfolia.yaml` (#372).
     */
    legacyBase?: boolean;
  } = {},
) {
  const changed = module('charging', 'en', 'Changed.');
  const charging: Module = options.deprecate
    ? {
        ...changed,
        meta: {
          ...changed.meta,
          deprecated: { reason: 'Superseded.', replacedBy: 'safety-note' },
        },
      }
    : changed;
  const content: FakeContent = {
    config,
    modules: [module('charging'), safetyModule()],
    ...(options.legacyBase && { legacyConfigFile: true }),
  };
  const repository = new FakeRepository();
  const main = new FakeSnapshot(content);
  repository.main = main;
  repository.byRef.set(main.commit, main);
  const branches = new FakeChangeSetBranches();
  branches.heads.set('main', main.commit);
  if (options.baseRef) branches.heads.set(options.baseRef, main.commit);
  const id = newChangeSetId();
  const branch = changeSetBranch(id);
  branches.heads.set(branch, main.commit);
  branches.onCommit = (commit, made) => {
    const after = new FakeSnapshot(
      {
        ...content,
        legacyConfigFile: false,
        modules: [
          charging,
          options.safety ? safetyModule('Changed.') : safetyModule(),
        ],
      },
      commit,
    );
    repository.byRef.set(commit, after);
    if (made.branch === branch) repository.byRef.set(branch, after);
  };
  const changes = [
    {
      path: 'modules/en/charging.adoc',
      content: printModule(charging),
    },
    ...(options.legacyConfig
      ? [{ path: 'ccms.yaml', content: printConfig(config) }]
      : []),
    ...(options.legacyBase
      ? [{ path: 'openfolia.yaml', content: printConfig(config) }]
      : []),
    ...(options.safety
      ? [
          {
            path: 'modules/en/safety-note.adoc',
            content: printModule(safetyModule('Changed.')),
          },
        ]
      : []),
  ];
  const now = new Date();
  const mine: ChangeSet = {
    id,
    title: 'Clearer charging',
    description: null,
    author: { kind: 'user', id: author.id },
    baseRef: options.baseRef ?? 'main',
    baseCommit: main.commit,
    baseReleased: true,
    branch,
    state: 'draft',
    createdAt: now,
    updatedAt: now,
  };
  const store = new FakeChangeSetStore([mine]);
  const approvals = new FakeApprovalStore();
  const events = new FakeChangeSetEvents();
  const audit = new FakeAuditLog();
  const locks = new FakeLockStore();
  const copies = new FakeWorkingCopyStore();
  const unit = new FakeUnitOfWork();
  // Which change set carries or moved which (#597): links a test makes itself.
  const carries = new FakeCarryForwards(store);
  const supersessions = new FakeChangeSetSupersessions(store);
  const open = new OpenSnapshotAction(
    repository,
    new ChangeSetAuthoredBranches(store),
  );
  const workflow = new Workflow(
    store,
    approvals,
    events,
    audit,
    branches,
    open,
    locks,
    copies,
    new DeprecationEvents(repository),
    new ChangeSetAuthors(branches, store, carries, supersessions),
  );
  const recorder = new CommitRecorder(
    new FakeChangeSetCommits(),
    branches,
    audit,
    copies,
    new FakeCommitIntents(),
  );
  // Approvals hold while their approver, looked up again, still holds
  // what they gave.
  const users = new FakeUserDirectory(EVERYONE);
  const standing = new ApprovalStanding(users);
  // Four eyes unless a test changes it (#588).
  const selfApproval = new FakeSelfApprovalRule();
  const actions = {
    submit: new SubmitChangeSetAction(
      workflow,
      store,
      copies,
      recorder,
      unit,
      open,
      branches,
      new FakeRefreshConflicts(),
    ),
    return: new ReturnChangeSetAction(workflow, unit),
    approve: new ApproveChangeSetAction(
      workflow,
      store,
      approvals,
      standing,
      selfApproval,
      unit,
    ),
    'sign-off': new SignOffChangeSetAction(
      workflow,
      store,
      approvals,
      standing,
      selfApproval,
      unit,
    ),
    merge: new MergeChangeSetAction(
      workflow,
      approvals,
      standing,
      branches,
      unit,
    ),
  };
  const review = new GetChangeSetReviewAction(
    new GetChangeSetAction(store),
    workflow,
    approvals,
    standing,
    selfApproval,
    unit,
  );
  const abandon = new AbandonChangeSetAction(
    store,
    locks,
    copies,
    audit,
    events,
    unit,
    workflow,
  );
  const reconcile = new ReconcileChangeSetMergesAction(
    store,
    branches,
    workflow,
    unit,
  );
  /**
   * Commits the change on the change set's branch, as a save point would: by its author unless
   * `by` says who, naming the writers of what it carries (`carried`, #597) when given.
   */
  const commitChange = async (
    options: {
      by?: ChangeSet['author'];
      carried?: readonly ChangeSet['author'][];
    } = {},
  ) => {
    const parent = branches.heads.get(branch) as string;
    const { tree } = await branches.prepare(branch, { parent, changes });
    const made = await branches.commit(branch, {
      parent,
      tree,
      message: 'Edit',
      author: options.by ?? mine.author,
      changeSetId: id,
      ...(options.carried && { carried: options.carried }),
    });
    if (!('commit' in made)) throw new Error('not committed');
    return made.commit;
  };
  locks.locks.push({
    id: newLockId(),
    subject: { type: 'module', lang: 'en', moduleId: 'charging' },
    changeSetId: id,
    holder: mine.author,
    since: now,
  });
  const current = () => store.changeSets.find((c) => c.id === id) as ChangeSet;
  /** Restricts concepts on main, in a commit made after the change set started. */
  function restrictLater(): void {
    const later = new FakeSnapshot({
      ...content,
      config: ProjectConfig.parse({
        ...config,
        moduleTypes: [
          { id: 'concept', label: 'Concept', restricted: true },
          { id: 'safety', label: 'Safety', restricted: true },
        ],
      }),
    });
    branches.commits.set(later.commit, {
      branch: 'main',
      parent: main.commit,
      changes: [],
      tree: fakeTree(main.commit, []),
      message: 'Restrict concepts',
      author,
      changeSetId: '',
    });
    branches.heads.set('main', later.commit);
    repository.main = later;
    repository.byRef.set(later.commit, later);
  }

  return {
    id,
    branch,
    branches,
    store,
    approvals,
    events,
    audit,
    locks,
    actions,
    reconcile,
    abandon,
    review,
    commitChange,
    current,
    restrictLater,
    repository,
    workflow,
    content,
    users,
    unit,
    selfApproval,
    carries,
    supersessions,
  };
}

type Setup = ReturnType<typeof setUp>;

/** Brings a fresh change set to `state` through the workflow. */
async function bring(t: Setup, state: ChangeSetState, safety = false) {
  await t.commitChange();
  if (state === 'draft') return;
  await t.actions.submit.handle({ actor: author, id: t.id });
  if (state === 'in-review') return;
  await t.actions.approve.handle({ actor: reviewer, id: t.id });
  if (safety) await t.actions['sign-off'].handle({ actor: approver, id: t.id });
  if (state === 'approved') return;
  await t.actions.merge.handle({ actor: publisher, id: t.id });
}

describe('the change set workflow, transition by transition', () => {
  type Name = keyof Setup['actions'];
  const cases: {
    name: Name;
    from: ChangeSetState;
    actor: Actor;
    to?: ChangeSetState;
    error?: [new (...args: never[]) => Error, string?];
    safety?: boolean;
  }[] = [
    // submit
    { name: 'submit', from: 'draft', actor: author, to: 'in-review' },
    { name: 'submit', from: 'draft', actor: otherEditor, to: 'in-review' },
    { name: 'submit', from: 'draft', actor: narrowEditor, to: 'in-review' },
    {
      name: 'submit',
      from: 'draft',
      actor: narrowEditor,
      safety: true,
      error: [ForbiddenError],
    },
    { name: 'submit', from: 'draft', actor: blind, error: [NotFoundError] },
    {
      name: 'submit',
      from: 'in-review',
      actor: author,
      error: [ConflictError, 'invalid-state'],
    },
    {
      name: 'submit',
      from: 'merged',
      actor: author,
      error: [ConflictError, 'invalid-state'],
    },
    // return
    { name: 'return', from: 'in-review', actor: reviewer, to: 'draft' },
    { name: 'return', from: 'approved', actor: reviewer, to: 'draft' },
    {
      name: 'return',
      from: 'in-review',
      actor: selfReviewer,
      error: [ForbiddenError],
    },
    {
      name: 'return',
      from: 'in-review',
      actor: narrowReviewer,
      error: [ForbiddenError],
    },
    {
      name: 'return',
      from: 'draft',
      actor: reviewer,
      error: [ConflictError, 'invalid-state'],
    },
    {
      name: 'return',
      from: 'merged',
      actor: reviewer,
      error: [ConflictError, 'invalid-state'],
    },
    { name: 'return', from: 'in-review', actor: blind, error: [NotFoundError] },
    // approve
    { name: 'approve', from: 'in-review', actor: reviewer, to: 'approved' },
    {
      name: 'approve',
      from: 'in-review',
      actor: reviewer,
      safety: true,
      to: 'in-review',
    },
    {
      name: 'approve',
      from: 'in-review',
      actor: selfReviewer,
      error: [ForbiddenError],
    },
    {
      name: 'approve',
      from: 'in-review',
      actor: narrowReviewer,
      error: [ForbiddenError],
    },
    {
      name: 'approve',
      from: 'draft',
      actor: reviewer,
      error: [ConflictError, 'invalid-state'],
    },
    {
      name: 'approve',
      from: 'approved',
      actor: reviewer,
      error: [ConflictError, 'invalid-state'],
    },
    {
      name: 'approve',
      from: 'in-review',
      actor: blind,
      error: [NotFoundError],
    },
    // sign-off
    {
      name: 'sign-off',
      from: 'in-review',
      actor: approver,
      safety: true,
      to: 'in-review',
    },
    {
      name: 'sign-off',
      from: 'in-review',
      actor: approver,
      error: [ConflictError, 'no-sign-off-needed'],
    },
    {
      name: 'sign-off',
      from: 'in-review',
      actor: selfReviewer,
      safety: true,
      error: [ForbiddenError],
    },
    {
      name: 'sign-off',
      from: 'in-review',
      actor: user('concept-approver', ['content.approve'], {
        moduleTypes: ['concept'],
      }),
      safety: true,
      error: [ForbiddenError],
    },
    // merge
    { name: 'merge', from: 'approved', actor: publisher, to: 'merged' },
    { name: 'merge', from: 'approved', actor: selfReviewer, to: 'merged' },
    {
      name: 'merge',
      from: 'approved',
      actor: narrowPublisher,
      safety: true,
      error: [ForbiddenError],
    },
    {
      name: 'merge',
      from: 'in-review',
      actor: publisher,
      error: [ConflictError, 'invalid-state'],
    },
    {
      name: 'merge',
      from: 'merged',
      actor: publisher,
      error: [ConflictError, 'invalid-state'],
    },
    { name: 'merge', from: 'approved', actor: blind, error: [NotFoundError] },
  ];

  it.each(cases)(
    '$name from $from by $actor.id (safety: $safety) → $to $error',
    async ({ name, from, actor, to, error, safety }) => {
      const t = setUp({ safety: safety ?? false });
      await bring(t, from, safety);
      const events = t.audit.events.length;
      const run = t.actions[name].handle({
        actor,
        id: t.id,
        comment: 'Checked.',
      });
      if (error) {
        const [kind, code] = error;
        const thrown = await run.then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(thrown).toBeInstanceOf(kind);
        if (code) expect((thrown as ConflictError).code).toBe(code);
        expect(t.current().state).toBe(from);
        expect(t.audit.events).toHaveLength(events);
        return;
      }
      await run;
      expect(t.current().state).toBe(to);
      const event = t.audit.events.find(
        (e, i) => i >= events && e.action === `change-set.${name}`,
      );
      expect(event).toMatchObject({
        actor: { kind: actor.kind, id: actor.id },
        subject: { type: 'change-set', id: t.id },
        comment: 'Checked.',
        data: { from, to },
      });
      expect(t.events.events.at(-1)?.topic).toBe(`change-set.${name}`);
    },
  );
});

describe('submit', () => {
  it('records the head as the review head and keeps the locks', async () => {
    const t = setUp();
    const head = await t.commitChange();
    const submitted = await t.actions.submit.handle({
      actor: author,
      id: t.id,
    });
    expect(submitted).toMatchObject({ state: 'in-review', reviewHead: head });
    expect(t.locks.locks).toHaveLength(1);
  });

  it('refuses a change set that changes nothing', async () => {
    const t = setUp();
    await expect(
      t.actions.submit.handle({ actor: author, id: t.id }),
    ).rejects.toMatchObject({ code: 'no-changes' });
  });
});

describe('approve and sign-off', () => {
  it('needs both the review and the sign-off of a restricted type, in any order', async () => {
    const t = setUp({ safety: true });
    await bring(t, 'in-review');
    const signed = await t.actions['sign-off'].handle({
      actor: approver,
      id: t.id,
    });
    expect(signed).toMatchObject({
      required: ['review', 'sign-off/safety'],
      granted: ['sign-off/safety'],
      pending: ['review'],
    });
    expect(signed.changeSet.state).toBe('in-review');
    const reviewed = await t.actions.approve.handle({
      actor: reviewer,
      id: t.id,
    });
    expect(reviewed.pending).toEqual([]);
    expect(reviewed.changeSet.state).toBe('approved');
  });

  it('needs the sign-off of a type restricted on the base since it started', async () => {
    const t = setUp();
    await bring(t, 'in-review');
    t.restrictLater();
    const reviewed = await t.actions.approve.handle({
      actor: reviewer,
      id: t.id,
    });
    expect(reviewed.pending).toEqual(['sign-off/concept']);
  });

  it('does not count an approval whose approver lost the role since', async () => {
    const t = setUp({ safety: true });
    await t.commitChange();
    await t.actions.submit.handle({ actor: author, id: t.id });
    await t.actions.approve.handle({ actor: reviewer, id: t.id });
    t.users.put({ ...reviewer, roles: [] });
    const signed = await t.actions['sign-off'].handle({
      actor: approver,
      id: t.id,
    });
    expect(signed.changeSet.state).toBe('in-review');
    expect(signed.pending).toEqual(['review']);
    expect(signed.lapsed).toMatchObject([
      { requirement: 'review', approver: { id: reviewer.id } },
    ]);
    // Another reviewer's approval completes it.
    const second = user('second-reviewer', ['content.review']);
    t.users.put(second);
    const approved = await t.actions.approve.handle({
      actor: second,
      id: t.id,
    });
    expect(approved.changeSet.state).toBe('approved');
    expect(approved.pending).toEqual([]);
  });

  it('lets the same reviewer give the review and a sign-off (L5: no separation)', async () => {
    const t = setUp({ safety: true });
    const both = user('both-hats', ['content.review', 'content.approve']);
    t.users.put(both);
    await t.commitChange();
    await t.actions.submit.handle({ actor: author, id: t.id });
    await t.actions.approve.handle({ actor: both, id: t.id });
    const signed = await t.actions['sign-off'].handle({
      actor: both,
      id: t.id,
    });
    expect(signed.changeSet.state).toBe('approved');
  });

  it('refuses approving twice', async () => {
    const t = setUp({ safety: true });
    await bring(t, 'in-review');
    await t.actions.approve.handle({ actor: reviewer, id: t.id });
    await expect(
      t.actions.approve.handle({ actor: reviewer, id: t.id }),
    ).rejects.toMatchObject({ code: 'already-approved' });
  });

  it('returns a change set whose branch moved since it was submitted to draft', async () => {
    const t = setUp();
    await bring(t, 'in-review');
    const submitted = t.current().reviewHead;
    // Pushed to outside the API.
    const moved = await t.commitChange();
    await expect(
      t.actions.approve.handle({ actor: reviewer, id: t.id }),
    ).rejects.toMatchObject({
      code: 'head-moved',
      meta: { reviewHead: submitted, head: moved },
    });
    expect(t.current().state).toBe('draft');
    expect(t.current().reviewHead).toBeUndefined();
    expect(t.audit.events.at(-1)).toMatchObject({
      action: 'change-set.return',
      data: { reason: 'head-moved' },
    });
  });
});

describe('self-approval (#588)', () => {
  /** A change set of `selfReviewer`'s in review, under `rule`. */
  async function own(
    rule: 'never' | 'review' | 'review-and-sign-off',
    safety = false,
  ) {
    const t = setUp({ safety });
    t.users.put(selfReviewer);
    t.selfApproval.rule = rule;
    await t.commitChange();
    await t.actions.submit.handle({ actor: selfReviewer, id: t.id });
    return t;
  }

  it('refuses the author with never, as four eyes always did', async () => {
    const t = await own('never', true);
    await expect(
      t.actions.approve.handle({ actor: selfReviewer, id: t.id }),
    ).rejects.toThrow(new ForbiddenError(NOT_YOUR_OWN));
    await expect(
      t.actions['sign-off'].handle({ actor: selfReviewer, id: t.id }),
    ).rejects.toThrow(new ForbiddenError(NOT_YOUR_OWN));
    expect(t.approvals.approvals).toEqual([]);
  });

  it('with review, lets the author approve their own change set, recorded and audited as self', async () => {
    const t = await own('review');
    const outcome = await t.actions.approve.handle({
      actor: selfReviewer,
      id: t.id,
    });
    expect(outcome.changeSet.state).toBe('approved');
    expect(outcome.selfApproval).toBe('review');
    expect(outcome.approvals).toMatchObject([
      { requirement: 'review', approver: { id: selfReviewer.id }, self: true },
    ]);
    expect(t.approvals.approvals).toMatchObject([{ self: true }]);
    const event = t.audit.events.find((e) => e.action === 'change-set.approve');
    expect(event?.data).toMatchObject({ self: true, to: 'approved' });
    expect(t.events.events.at(-1)?.payload).toMatchObject({ self: true });
  });

  it('with review, keeps a restricted type in review until someone else signs off, and refuses the author’s sign-off', async () => {
    const t = await own('review', true);
    const reviewed = await t.actions.approve.handle({
      actor: selfReviewer,
      id: t.id,
    });
    expect(reviewed.changeSet.state).toBe('in-review');
    expect(reviewed.pending).toEqual(['sign-off/safety']);
    await expect(
      t.actions['sign-off'].handle({ actor: selfReviewer, id: t.id }),
    ).rejects.toThrow(new ForbiddenError(NO_OWN_SIGN_OFF));
    const signed = await t.actions['sign-off'].handle({
      actor: approver,
      id: t.id,
    });
    expect(signed.changeSet.state).toBe('approved');
    expect(signed.approvals).toMatchObject([{ self: true }, { self: false }]);
  });

  it('with review-and-sign-off, lets an author with the scopes approve alone', async () => {
    const t = await own('review-and-sign-off', true);
    await t.actions.approve.handle({ actor: selfReviewer, id: t.id });
    const signed = await t.actions['sign-off'].handle({
      actor: selfReviewer,
      id: t.id,
    });
    expect(signed.changeSet.state).toBe('approved');
    expect(signed.approvals.every((a) => a.self)).toBe(true);
    const event = t.audit.events.find(
      (e) => e.action === 'change-set.sign-off',
    );
    expect(event?.data).toMatchObject({ self: true });
    const outcome = await t.actions.merge.handle({
      actor: publisher,
      id: t.id,
    });
    expect(outcome.changeSet.state).toBe('merged');
  });

  it('still needs the author’s scope: the setting lifts only the author check', async () => {
    const t = await own('review-and-sign-off', true);
    const narrow = user(selfReviewer.id, ['content.edit', 'content.review']);
    await expect(
      t.actions['sign-off'].handle({ actor: narrow, id: t.id }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const outside = user(selfReviewer.id, ['content.edit', 'content.review'], {
      languages: ['de'],
    });
    await expect(
      t.actions.approve.handle({ actor: outside, id: t.id }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('never lets the author return their own change set', async () => {
    const t = await own('review-and-sign-off');
    await expect(
      t.actions.return.handle({
        actor: selfReviewer,
        id: t.id,
        comment: 'Mine.',
      }),
    ).rejects.toThrow(new ForbiddenError(NOT_YOUR_OWN));
  });

  it('keeps a self-approval when the rule goes back to never, and merges it', async () => {
    const t = await own('review');
    await t.actions.approve.handle({ actor: selfReviewer, id: t.id });
    t.selfApproval.rule = 'never';
    const status = await t.review.handle({ actor: reviewer, id: t.id });
    expect(status.selfApproval).toBe('never');
    expect(status.pending).toEqual([]);
    expect(status.approvals).toMatchObject([{ self: true }]);
    const merged = await t.actions.merge.handle({
      actor: publisher,
      id: t.id,
    });
    expect(merged.changeSet.state).toBe('merged');
  });

  it('lets a self-approval lapse like any other when its author loses the role (#180)', async () => {
    const t = await own('review');
    await t.actions.approve.handle({ actor: selfReviewer, id: t.id });
    t.users.put(author);
    await expect(
      t.actions.merge.handle({ actor: publisher, id: t.id }),
    ).rejects.toMatchObject({ code: 'approval-lapsed' });
  });

  it('records no self flag for another reviewer’s approval', async () => {
    const t = await own('review-and-sign-off');
    const outcome = await t.actions.approve.handle({
      actor: reviewer,
      id: t.id,
    });
    expect(outcome.approvals).toMatchObject([{ self: false }]);
    const event = t.audit.events.find((e) => e.action === 'change-set.approve');
    expect(event?.data).not.toHaveProperty('self');
  });
});

describe('everyone who wrote it counts as its author (#597)', () => {
  const asAuthor = (a: Actor) => ({ kind: 'user' as const, id: a.id });

  /**
   * A change set of `author`'s in review whose one commit carries what `reviewer` wrote (a
   * carried-forward or moved change set), under `rule`.
   */
  async function carried(
    rule: 'never' | 'review' | 'review-and-sign-off',
    commit: Parameters<Setup['commitChange']>[0] = {
      carried: [asAuthor(reviewer)],
    },
  ) {
    const t = setUp();
    t.selfApproval.rule = rule;
    await t.commitChange(commit);
    await t.actions.submit.handle({ actor: author, id: t.id });
    return t;
  }

  it('refuses the writer of a carried commit under never: they neither approve nor return it', async () => {
    const t = await carried('never');
    await expect(
      t.actions.approve.handle({ actor: reviewer, id: t.id }),
    ).rejects.toThrow(new ForbiddenError(NOT_YOUR_OWN));
    await expect(
      t.actions.return.handle({ actor: reviewer, id: t.id, comment: 'Mine.' }),
    ).rejects.toThrow(new ForbiddenError(NOT_YOUR_OWN));
    expect(t.approvals.approvals).toEqual([]);
    // Someone who wrote none of it still reviews it.
    const other = user('other-reviewer', ['content.review']);
    t.users.put(other);
    const outcome = await t.actions.approve.handle({ actor: other, id: t.id });
    expect(outcome.approvals).toMatchObject([{ self: false }]);
  });

  it('refuses the writer of a carried commit a sign-off under never', async () => {
    const t = setUp({ safety: true });
    await t.commitChange({ carried: [asAuthor(approver)] });
    await t.actions.submit.handle({ actor: author, id: t.id });
    await expect(
      t.actions['sign-off'].handle({ actor: approver, id: t.id }),
    ).rejects.toThrow(new ForbiddenError(NOT_YOUR_OWN));
  });

  it('records the carried writer’s approval as self when the rule lets an author approve', async () => {
    const t = await carried('review');
    const outcome = await t.actions.approve.handle({
      actor: reviewer,
      id: t.id,
    });
    expect(outcome.changeSet.state).toBe('approved');
    expect(outcome.approvals).toMatchObject([
      { approver: { id: reviewer.id }, self: true },
    ]);
    const event = t.audit.events.find((e) => e.action === 'change-set.approve');
    expect(event?.data).toMatchObject({ self: true });
  });

  it('counts the actor of a commit the API made, not only the recorded author', async () => {
    const t = await carried('never', { by: asAuthor(reviewer) });
    await expect(
      t.actions.approve.handle({ actor: reviewer, id: t.id }),
    ).rejects.toThrow(new ForbiddenError(NOT_YOUR_OWN));
  });

  it('does not count a commit pushed from outside the API, whatever it claims', async () => {
    const t = setUp();
    await t.commitChange();
    t.branches.push(t.branch, {
      changes: [{ path: 'modules/en/other.adoc', content: '= Other\n' }],
      message: 'Pushed',
      author: asAuthor(reviewer),
      changeSetId: t.id,
    });
    await t.actions.submit.handle({ actor: author, id: t.id });
    const outcome = await t.actions.approve.handle({
      actor: reviewer,
      id: t.id,
    });
    expect(outcome.approvals).toMatchObject([{ self: false }]);
  });

  /** A merged change set of `reviewer`'s that the change set under test carries forward or moved. */
  function sourceBy(t: Setup, writer: Actor): ChangeSet {
    const now = new Date();
    const id = newChangeSetId();
    const source: ChangeSet = {
      id,
      title: 'The fix',
      description: null,
      author: asAuthor(writer),
      baseRef: 'maintenance/line',
      baseCommit: t.current().baseCommit,
      baseReleased: true,
      branch: changeSetBranch(id),
      state: 'merged',
      reviewHead: t.current().baseCommit,
      createdAt: now,
      updatedAt: now,
    };
    t.store.changeSets.push(source);
    return source;
  }

  it('counts the author of the change set it carries forward, even with no commit naming them', async () => {
    // Nothing applied: the carrier typed the fix again by hand, in commits of their own.
    const t = await carried('never', {});
    const source = sourceBy(t, reviewer);
    t.carries.links.push({ changeSetId: t.id, sourceId: source.id });
    await expect(
      t.actions.approve.handle({ actor: reviewer, id: t.id }),
    ).rejects.toThrow(new ForbiddenError(NOT_YOUR_OWN));
  });

  it('counts the authors of the change set it was moved from, through every link', async () => {
    const t = await carried('review', {});
    // Moved from a change set that carried forward the reviewer's fix.
    const moved = sourceBy(t, author);
    const fix = sourceBy(t, reviewer);
    t.supersessions.links.push({ changeSetId: t.id, supersededId: moved.id });
    t.carries.links.push({ changeSetId: moved.id, sourceId: fix.id });
    const outcome = await t.actions.approve.handle({
      actor: reviewer,
      id: t.id,
    });
    expect(outcome.approvals).toMatchObject([{ self: true }]);
  });

  it('tells nobody who may not see it that its authors could not be read: 404, as for any other (#597)', async () => {
    const t = await carried('never');
    let reads = 0;
    t.branches.writers = async () => {
      reads++;
      throw new ConflictError('too-many-commits', 'Too long.', { max: 1 });
    };
    for (const name of ['approve', 'sign-off', 'return'] as const) {
      await expect(
        t.actions[name].handle({ actor: blind, id: t.id, comment: 'Why.' }),
      ).rejects.toBeInstanceOf(NotFoundError);
    }
    // Nothing was read for them.
    expect(reads).toBe(0);
    // One who sees it hears why.
    await expect(
      t.actions.approve.handle({ actor: reviewer, id: t.id }),
    ).rejects.toMatchObject({ code: 'too-many-commits' });
    await expect(
      t.actions.return.handle({ actor: reviewer, id: t.id, comment: 'Why.' }),
    ).rejects.toMatchObject({ code: 'too-many-commits' });
  });

  it('reads no authors for a state the transition does not take: 409 invalid-state as before', async () => {
    const t = setUp();
    await bring(t, 'merged');
    let reads = 0;
    t.branches.writers = async () => {
      reads++;
      throw new ConflictError('too-many-commits', 'Too long.', { max: 1 });
    };
    await expect(
      t.actions.approve.handle({ actor: reviewer, id: t.id }),
    ).rejects.toMatchObject({ code: 'invalid-state' });
    await expect(
      t.actions.return.handle({ actor: reviewer, id: t.id, comment: 'Why.' }),
    ).rejects.toMatchObject({ code: 'invalid-state' });
    expect(reads).toBe(0);
  });

  it('says in the review status whether the reader counts as its author', async () => {
    const t = await carried('never');
    expect((await t.review.handle({ actor: reviewer, id: t.id })).yours).toBe(
      true,
    );
    expect((await t.review.handle({ actor: author, id: t.id })).yours).toBe(
      true,
    );
    expect((await t.review.handle({ actor: approver, id: t.id })).yours).toBe(
      false,
    );
  });
});

describe('review status', () => {
  it('reads what is required and pending without granting anything', async () => {
    const t = setUp({ safety: true });
    await bring(t, 'draft');
    const draft = await t.review.handle({ actor: reviewer, id: t.id });
    expect(draft).toMatchObject({
      required: ['review', 'sign-off/safety'],
      granted: [],
      pending: ['review', 'sign-off/safety'],
      approvals: [],
    });
    await t.actions.submit.handle({ actor: author, id: t.id });
    await t.actions.approve.handle({ actor: reviewer, id: t.id });
    const read = await t.review.handle({ actor: reviewer, id: t.id });
    expect(read.changeSet.state).toBe('in-review');
    expect(read).toMatchObject({
      granted: [],
      pending: ['sign-off/safety'],
      approvals: [
        {
          requirement: 'review',
          approver: { kind: 'user', id: reviewer.id },
          head: t.current().reviewHead,
        },
      ],
    });
    // An approver scoped to the restricted type still hears of the sign-off they may give.
    const scoped = await t.review.handle({ actor: approver, id: t.id });
    expect(scoped.pending).toEqual(['sign-off/safety']);
    // Reading wrote nothing.
    expect(t.audit.events.at(-1)?.action).toBe('change-set.approve');
  });

  it('names no sign-off to a reader whose scope does not cover every change', async () => {
    const t = setUp({ safety: true });
    await bring(t, 'in-review');
    await t.actions.approve.handle({ actor: reviewer, id: t.id });
    const read = await t.review.handle({ actor: narrowReviewer, id: t.id });
    expect(read).toMatchObject({
      required: ['review'],
      pending: [],
      approvals: [{ requirement: 'review' }],
      lapsed: [],
    });
  });

  it('judges the approvals as merge does: one whose approver lost the role is lapsed', async () => {
    const t = setUp({ safety: true });
    await bring(t, 'approved', true);
    t.users.put({ ...reviewer, roles: [] });
    const read = await t.review.handle({ actor: approver, id: t.id });
    expect(read.pending).toEqual(['review']);
    expect(read.lapsed).toMatchObject([
      { requirement: 'review', approver: { kind: 'user', id: reviewer.id } },
    ]);
  });

  it('needs content.read.draft, and finds no change set that is not there', async () => {
    const t = setUp();
    await bring(t, 'in-review');
    await expect(
      t.review.handle({ actor: blind, id: t.id }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      t.review.handle({ actor: reviewer, id: newChangeSetId() }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('return', () => {
  it('removes the approvals, so a resubmitted change set is reviewed again', async () => {
    const t = setUp({ safety: true });
    await bring(t, 'in-review');
    await t.actions.approve.handle({ actor: reviewer, id: t.id });
    await t.actions.return.handle({
      actor: reviewer,
      id: t.id,
      comment: 'Name the tool.',
    });
    expect(t.approvals.approvals).toEqual([]);
    expect(t.audit.events.at(-1)).toMatchObject({
      action: 'change-set.return',
      comment: 'Name the tool.',
      data: { from: 'in-review', to: 'draft', approvals: 1 },
    });
    await t.commitChange();
    await t.actions.submit.handle({ actor: author, id: t.id });
    const again = await t.actions['sign-off'].handle({
      actor: approver,
      id: t.id,
    });
    expect(again.pending).toEqual(['review']);
  });
});

describe('merge', () => {
  it('merges the review head with one Approved-by per approver and releases the locks', async () => {
    const t = setUp({ safety: true });
    await bring(t, 'approved', true);
    const reviewHead = t.current().reviewHead as string;
    const outcome = await t.actions.merge.handle({
      actor: publisher,
      id: t.id,
    });
    expect(outcome.changeSet).toMatchObject({
      state: 'merged',
      mergeCommit: outcome.commit,
    });
    expect(t.branches.heads.get('main')).toBe(outcome.commit);
    const made = t.branches.commits.get(outcome.commit);
    expect(made).toMatchObject({
      mergeOf: reviewHead,
      author: { kind: 'user', id: publisher.id },
      approvedBy: [
        { kind: 'user', id: approver.id },
        { kind: 'user', id: reviewer.id },
      ],
    });
    expect(t.locks.locks).toEqual([]);
    expect(t.audit.events.at(-1)).toMatchObject({
      action: 'lock.release',
      data: { reason: 'change-set.merge' },
    });
    expect(t.events.events.at(-1)).toMatchObject({
      topic: 'change-set.merge',
      key: t.id,
    });
  });

  it('writes one module.deprecated outbox row for what it deprecates (#266)', async () => {
    const t = setUp({ deprecate: true });
    await bring(t, 'approved');
    const outcome = await t.actions.merge.handle({
      actor: publisher,
      id: t.id,
    });
    const deprecations = t.events.events.filter((e) =>
      e.topic.endsWith('.deprecated'),
    );
    expect(deprecations).toEqual([
      {
        topic: 'module.deprecated',
        key: `${t.id}/charging`,
        payload: {
          moduleId: 'charging',
          lang: 'en',
          reason: 'Superseded.',
          replacedBy: 'safety-note',
          changeSetId: t.id,
          commit: outcome.commit,
        },
      },
    ]);
  });

  it('writes no deprecation row for a merge into a maintenance line: only main counts', async () => {
    const t = setUp({ deprecate: true, baseRef: 'maintenance/1.x' });
    await bring(t, 'approved');
    await t.actions.merge.handle({ actor: publisher, id: t.id });
    expect(t.events.events.at(-1)?.topic).toBe('change-set.merge');
    expect(
      t.events.events.filter((e) => e.topic.endsWith('.deprecated')),
    ).toEqual([]);
  });

  it('writes no deprecation row for a change that deprecates nothing', async () => {
    const t = setUp();
    await bring(t, 'approved');
    await t.actions.merge.handle({ actor: publisher, id: t.id });
    expect(
      t.events.events.filter((e) => e.topic.endsWith('.deprecated')),
    ).toEqual([]);
  });

  it('answers a conflict as data and stays approved, nothing written', async () => {
    const t = setUp();
    await bring(t, 'approved');
    // `main` changed the same file meanwhile.
    const main = t.branches.heads.get('main') as string;
    const { tree } = await t.branches.prepare('main', {
      parent: main,
      changes: [{ path: 'modules/en/charging.adoc', content: 'theirs\n' }],
    });
    const theirs = await t.branches.commit('main', {
      parent: main,
      tree,
      message: 'Elsewhere',
      author: { kind: 'user', id: 'someone' },
      changeSetId: t.id,
    });
    if (!('commit' in theirs)) throw new Error('not committed');
    const events = t.audit.events.length;
    await expect(
      t.actions.merge.handle({ actor: publisher, id: t.id }),
    ).rejects.toMatchObject({
      code: 'merge-conflict',
      meta: {
        conflicts: [{ path: 'modules/en/charging.adoc', kinds: ['contents'] }],
        total: 1,
      },
    });
    expect(t.current().state).toBe('approved');
    expect(t.branches.heads.get('main')).toBe(theirs.commit);
    expect(t.audit.events).toHaveLength(events);
    expect(t.locks.locks).toHaveLength(1);
  });

  it('refuses a merge whose change set edits ccms.yaml beside openfolia.yaml, as the edit would be ignored (#372)', async () => {
    const t = setUp({ legacyConfig: true });
    // A change to the configuration, under either name, needs every sign-off.
    await bring(t, 'in-review');
    await t.actions.approve.handle({ actor: reviewer, id: t.id });
    expect(t.current().state).toBe('in-review');
    await t.actions['sign-off'].handle({ actor: approver, id: t.id });
    expect(t.current().state).toBe('approved');
    const main = t.branches.heads.get('main');
    await expect(
      t.actions.merge.handle({ actor: publisher, id: t.id }),
    ).rejects.toMatchObject({
      code: 'merge-conflict',
      meta: {
        conflicts: [{ path: 'ccms.yaml', kinds: ['contents'] }],
        total: 1,
      },
    });
    expect(t.current().state).toBe('approved');
    expect(t.branches.heads.get('main')).toBe(main);
  });

  it('refuses a merge whose openfolia.yaml would replace a ccms.yaml the base changed since (#372)', async () => {
    const t = setUp({ legacyBase: true });
    await bring(t, 'in-review');
    await t.actions.approve.handle({ actor: reviewer, id: t.id });
    await t.actions['sign-off'].handle({ actor: approver, id: t.id });
    expect(t.current().state).toBe('approved');
    const main = t.branches.heads.get('main') as string;
    const narrowed = ProjectConfig.parse({
      ...config,
      languages: { ...config.languages, targets: [] },
    });
    const { tree } = await t.branches.prepare('main', {
      parent: main,
      changes: [{ path: 'ccms.yaml', content: printConfig(narrowed) }],
    });
    const theirs = await t.branches.commit('main', {
      parent: main,
      tree,
      message: 'Fewer languages',
      author: { kind: 'user', id: 'someone' },
      changeSetId: t.id,
    });
    if (!('commit' in theirs)) throw new Error('not committed');
    t.repository.byRef.set(
      theirs.commit,
      new FakeSnapshot(
        { ...t.content, config: narrowed, legacyConfigFile: true },
        theirs.commit,
      ),
    );
    await expect(
      t.actions.merge.handle({ actor: publisher, id: t.id }),
    ).rejects.toMatchObject({
      code: 'merge-conflict',
      meta: { conflicts: [{ path: 'ccms.yaml', kinds: ['contents'] }] },
    });
    expect(t.current().state).toBe('approved');
    expect(t.branches.heads.get('main')).toBe(theirs.commit);
  });

  it('refuses a merge that leaves content invalid under the configuration it keeps (#253)', async () => {
    const t = setUp();
    await bring(t, 'approved');
    const reviewHead = t.current().reviewHead as string;
    // The change set's charging uses `large`; main removed `large` since.
    const usingLarge: Module = {
      ...module('charging', 'en', 'Changed.'),
      blocks: [
        {
          type: 'variant',
          id: 'big',
          when: { op: 'in', attr: 'model', values: ['large'] },
          blocks: module('charging').blocks,
        },
      ],
    };
    t.repository.byRef.set(
      reviewHead,
      new FakeSnapshot(
        { ...t.content, modules: [usingLarge, safetyModule()] },
        reviewHead,
      ),
    );
    const narrowed = ProjectConfig.parse({
      ...config,
      variantAttributes: [
        {
          id: 'model',
          label: 'Model',
          kind: 'enum',
          values: [{ id: 'small', label: 'Small' }],
        },
      ],
    });
    const main = t.branches.heads.get('main') as string;
    const { tree } = await t.branches.prepare('main', {
      parent: main,
      changes: [{ path: 'openfolia.yaml', content: printConfig(narrowed) }],
    });
    const theirs = await t.branches.commit('main', {
      parent: main,
      tree,
      message: 'Retire large',
      author: { kind: 'user', id: 'someone' },
      changeSetId: t.id,
    });
    if (!('commit' in theirs)) throw new Error('not committed');
    t.repository.byRef.set(
      theirs.commit,
      new FakeSnapshot({ ...t.content, config: narrowed }, theirs.commit),
    );

    await expect(
      t.actions.merge.handle({ actor: publisher, id: t.id }),
    ).rejects.toMatchObject({
      code: 'config-in-use',
      problems: [{ pointer: '/module/en/charging/blocks/big' }],
    });
    expect(t.current().state).toBe('approved');
    expect(t.branches.heads.get('main')).toBe(theirs.commit);
  });

  it('refuses a merge whose change set links a term the base deleted since (#245)', async () => {
    const t = setUp();
    await bring(t, 'approved');
    const reviewHead = t.current().reviewHead as string;
    const charger =
      'schemaVersion: 1\nstatus: approved\nlanguages:\n  en:\n    preferred: charger\n';
    // The change set's charging links the term; main deleted it since.
    const linking: Module = {
      ...module('charging', 'en', 'Changed.'),
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
    t.repository.byRef.set(
      reviewHead,
      new FakeSnapshot(
        {
          ...t.content,
          modules: [linking, safetyModule()],
          terms: { charger },
        },
        reviewHead,
      ),
    );
    const main = t.branches.heads.get('main') as string;
    const { tree } = await t.branches.prepare('main', {
      parent: main,
      changes: [{ path: 'terms/charger.yaml', delete: true }],
    });
    const theirs = await t.branches.commit('main', {
      parent: main,
      tree,
      message: 'Delete term charger',
      author: { kind: 'user', id: 'someone' },
      changeSetId: t.id,
    });
    if (!('commit' in theirs)) throw new Error('not committed');
    t.repository.byRef.set(
      theirs.commit,
      new FakeSnapshot(t.content, theirs.commit),
    );

    await expect(
      t.actions.merge.handle({ actor: publisher, id: t.id }),
    ).rejects.toMatchObject({
      code: 'term-in-use',
      problems: [{ pointer: '/module/en/charging/blocks/p' }],
    });
    expect(t.current().state).toBe('approved');
    expect(t.branches.heads.get('main')).toBe(theirs.commit);
    // Nothing to refuse where neither side deleted a term.
    expect(
      await t.workflow.mergeTermUsages(
        publisher,
        t.current(),
        reviewHead,
        main,
      ),
    ).toEqual([]);
  });

  it('finds content the base gained since that the change set’s narrowed configuration no longer fits (#253)', async () => {
    const t = setUp();
    await bring(t, 'approved');
    const reviewHead = t.current().reviewHead as string;
    const narrowed = ProjectConfig.parse({
      ...config,
      variantAttributes: [
        {
          id: 'model',
          label: 'Model',
          kind: 'enum',
          values: [{ id: 'small', label: 'Small' }],
        },
      ],
    });
    // The change set's head (as if it removed `large` too).
    const made = t.branches.commits.get(reviewHead);
    if (!made) throw new Error('no review head');
    t.branches.commits.set(reviewHead, {
      ...made,
      changes: [
        ...made.changes,
        { path: 'openfolia.yaml', content: printConfig(narrowed) },
      ],
    });
    t.repository.byRef.set(
      reviewHead,
      new FakeSnapshot(
        {
          ...t.content,
          config: narrowed,
          modules: [module('charging', 'en', 'Changed.'), safetyModule()],
        },
        reviewHead,
      ),
    );
    // Main gained a module using `large` meanwhile.
    const big: Module = {
      ...module('big'),
      blocks: [
        {
          type: 'variant',
          id: 'big',
          when: { op: 'in', attr: 'model', values: ['large'] },
          blocks: module('big').blocks,
        },
      ],
    };
    const main = t.branches.heads.get('main') as string;
    const { tree } = await t.branches.prepare('main', {
      parent: main,
      changes: [{ path: 'modules/en/big.adoc', content: printModule(big) }],
    });
    const theirs = await t.branches.commit('main', {
      parent: main,
      tree,
      message: 'Big',
      author: { kind: 'user', id: 'someone' },
      changeSetId: t.id,
    });
    if (!('commit' in theirs)) throw new Error('not committed');
    t.repository.byRef.set(
      theirs.commit,
      new FakeSnapshot(
        { ...t.content, modules: [...(t.content.modules ?? []), big] },
        theirs.commit,
      ),
    );

    // (Approving a configuration change takes every sign-off; the check
    // itself is what is shown here.)
    expect(
      await t.workflow.mergeUsages(
        publisher,
        t.current(),
        reviewHead,
        theirs.commit,
      ),
    ).toMatchObject([
      {
        subject: { type: 'module', lang: 'en', moduleId: 'big' },
        issue: { code: 'unknown-variant-value', at: 'big' },
      },
    ]);
  });

  it('tries again on top of a base that moved meanwhile', async () => {
    const t = setUp();
    await bring(t, 'approved');
    let moves = 1;
    // Another commit on main, on top of where it was.
    const main = t.branches.heads.get('main') as string;
    t.repository.byRef.set(
      'f'.repeat(40),
      new FakeSnapshot(t.content, 'f'.repeat(40)),
    );
    t.branches.commits.set('f'.repeat(40), {
      branch: 'main',
      parent: main,
      changes: [],
      tree: fakeTree(main, []),
      message: 'Elsewhere',
      author,
      changeSetId: '',
    });
    t.branches.beforeMerge = () => {
      if (moves-- > 0) t.branches.heads.set('main', 'f'.repeat(40));
    };
    const outcome = await t.actions.merge.handle({
      actor: publisher,
      id: t.id,
    });
    expect(t.branches.commits.get(outcome.commit)?.parent).toBe('f'.repeat(40));
  });

  it('checks a type restricted on the base between two attempts again', async () => {
    const t = setUp();
    await bring(t, 'approved');
    let moves = 1;
    // Pushed to the base outside the API while the first attempt merges.
    t.branches.beforeMerge = () => {
      if (moves-- > 0) t.restrictLater();
    };
    const main = () => t.branches.heads.get('main');
    await expect(
      t.actions.merge.handle({ actor: publisher, id: t.id }),
    ).rejects.toMatchObject({
      code: 'not-approved',
      meta: { pending: ['sign-off/concept'] },
    });
    expect(t.current().state).toBe('approved');
    expect(t.branches.commits.get(main() as string)?.mergeOf).toBeUndefined();
  });

  it('refuses an approval whose approver lost the role since (409 approval-lapsed)', async () => {
    const t = setUp({ safety: true });
    await bring(t, 'approved', true);
    // The reviewer's role is taken away after they approved.
    t.users.put({ ...reviewer, roles: [] });
    const main = t.branches.heads.get('main');
    await expect(
      t.actions.merge.handle({ actor: publisher, id: t.id }),
    ).rejects.toMatchObject({
      code: 'approval-lapsed',
      meta: {
        pending: ['review'],
        lapsed: [
          {
            requirement: 'review',
            approver: { kind: 'user', id: reviewer.id },
          },
        ],
      },
    });
    expect(t.current().state).toBe('approved');
    expect(t.branches.heads.get('main')).toBe(main);
  });

  it('refuses an approval whose approver’s scope no longer covers it, or who is gone', async () => {
    const t = setUp({ safety: true });
    await bring(t, 'approved', true);
    // The approver's scope narrowed to another type: no sign-off of safety.
    t.users.put(
      user(approver.id, ['content.approve'], { moduleTypes: ['concept'] }),
    );
    await expect(
      t.actions.merge.handle({ actor: publisher, id: t.id }),
    ).rejects.toMatchObject({
      code: 'approval-lapsed',
      meta: { pending: ['sign-off/safety'] },
    });
    t.users.put(approver);
    t.users.remove(reviewer.id);
    await expect(
      t.actions.merge.handle({ actor: publisher, id: t.id }),
    ).rejects.toMatchObject({
      code: 'approval-lapsed',
      meta: { pending: ['review'] },
    });
  });

  it('merges when another approval still meets what a lapsed one gave, naming only those that hold', async () => {
    const t = setUp();
    await t.commitChange();
    await t.actions.submit.handle({ actor: author, id: t.id });
    const second = user('second-reviewer', ['content.review']);
    t.users.put(second);
    await t.actions.approve.handle({ actor: reviewer, id: t.id });
    // Approved already; a second reviewer's approval is recorded first.
    await t.unit.run((tx) =>
      t.approvals.add(tx, {
        changeSetId: t.id,
        requirement: 'review',
        approver: { kind: 'user', id: second.id },
        head: t.current().reviewHead as string,
        self: false,
      }),
    );
    t.users.put({ ...reviewer, roles: [] });
    const outcome = await t.actions.merge.handle({
      actor: publisher,
      id: t.id,
    });
    expect(t.branches.commits.get(outcome.commit)?.approvedBy).toEqual([
      { kind: 'user', id: second.id },
    ]);
  });

  it('returns to draft when the branch moved after approval', async () => {
    const t = setUp();
    await bring(t, 'approved');
    const main = t.branches.heads.get('main');
    await t.commitChange();
    await expect(
      t.actions.merge.handle({ actor: publisher, id: t.id }),
    ).rejects.toMatchObject({ code: 'head-moved' });
    expect(t.current().state).toBe('draft');
    expect(t.branches.heads.get('main')).toBe(main);
  });

  /** Merges, then fails recording the merge, as a database outage would. */
  async function landedUnrecorded(t: Setup) {
    await bring(t, 'approved');
    const failing = t.audit as FakeAuditLog & { append: unknown };
    const append = failing.append.bind(t.audit) as (
      ...args: unknown[]
    ) => Promise<void>;
    failing.append = (...args: unknown[]) =>
      (args[1] as { action: string }).action === 'change-set.merge' &&
      failing.append !== append
        ? Promise.reject(new Error('the database is down'))
        : append(...args);
    await expect(
      t.actions.merge.handle({ actor: publisher, id: t.id }),
    ).rejects.toThrow('the database is down');
    failing.append = append;
    expect(t.current().state).toBe('approved');
  }

  it.each(['return', 'abandon'] as const)(
    '%s of a change set whose merge landed unrecorded records the merge instead',
    async (name) => {
      const t = setUp();
      await landedUnrecorded(t);
      const run =
        name === 'return'
          ? t.actions.return.handle({ actor: reviewer, id: t.id })
          : t.abandon.handle({ actor: author, id: t.id });
      await expect(run).rejects.toMatchObject({
        code: 'invalid-state',
        meta: { state: 'merged' },
      });
      expect(t.current()).toMatchObject({
        state: 'merged',
        mergeCommit: t.branches.heads.get('main'),
      });
      expect(
        t.audit.events.find((e) => e.action === 'change-set.merge'),
      ).toMatchObject({ data: { recovered: true } });
    },
  );

  it('refuses merging once a type is restricted on the base after approval', async () => {
    const t = setUp();
    await bring(t, 'approved');
    t.restrictLater();
    await expect(
      t.actions.merge.handle({ actor: publisher, id: t.id }),
    ).rejects.toMatchObject({
      code: 'not-approved',
      meta: { pending: ['sign-off/concept'] },
    });
    expect(t.current().state).toBe('approved');
  });

  it('refuses a base branch that is gone', async () => {
    const t = setUp();
    await bring(t, 'approved');
    t.branches.heads.delete('main');
    await expect(
      t.actions.merge.handle({ actor: publisher, id: t.id }),
    ).rejects.toMatchObject({ code: 'base-missing' });
    expect(t.current().state).toBe('approved');
  });

  it('refuses a base rewound past the change set’s base commit', async () => {
    const t = setUp();
    await bring(t, 'approved');
    // Reset outside the API to before where the change set started.
    t.branches.heads.set('main', 'e'.repeat(40));
    t.repository.byRef.set(
      'e'.repeat(40),
      new FakeSnapshot(t.content, 'e'.repeat(40)),
    );
    await expect(
      t.actions.merge.handle({ actor: publisher, id: t.id }),
    ).rejects.toMatchObject({ code: 'base-rewritten' });
    expect(t.current().state).toBe('approved');
  });

  it('is recorded by the reconciler when the database failed after Git', async () => {
    const t = setUp();
    await bring(t, 'approved');
    // The merge lands, then recording it fails.
    const failing = t.audit as FakeAuditLog & { append: unknown };
    const append = failing.append.bind(t.audit) as (
      ...args: unknown[]
    ) => Promise<void>;
    let fail = true;
    failing.append = (...args: unknown[]) =>
      fail && (args[1] as { action: string }).action === 'change-set.merge'
        ? Promise.reject(new Error('the database is down'))
        : append(...args);
    await expect(
      t.actions.merge.handle({ actor: publisher, id: t.id }),
    ).rejects.toThrow('the database is down');
    fail = false;
    expect(t.current().state).toBe('approved');
    const merged = t.branches.heads.get('main') as string;
    expect(t.branches.commits.get(merged)?.mergeOf).toBe(
      t.current().reviewHead,
    );

    const report = await t.reconcile.handle();
    expect(report.recovered).toEqual([t.id]);
    expect(t.current()).toMatchObject({ state: 'merged', mergeCommit: merged });
    expect(
      t.audit.events.find((e) => e.action === 'change-set.merge'),
    ).toMatchObject({
      actor: { kind: 'service', id: 'service:reconciler' },
      data: {
        recovered: true,
        commit: merged,
        claimedMergedBy: `user/${publisher.id}`,
      },
    });
    expect(t.locks.locks).toEqual([]);
    // Once only.
    expect((await t.reconcile.handle()).recovered).toEqual([]);
  });
});

describe('ReconcileChangeSetMergesAction: its budget', () => {
  /** `count` approved change sets that never merged, oldest first. */
  function approvedMany(t: Setup, count: number): string[] {
    const ids: string[] = [];
    const start = Date.now() - count - 1000;
    for (let i = 0; i < count; i++) {
      const id = newChangeSetId(start + i);
      const at = new Date(start + i);
      t.store.changeSets.push({
        ...t.current(),
        id,
        branch: changeSetBranch(id),
        state: 'approved',
        reviewHead: 'a'.repeat(40),
        createdAt: at,
        updatedAt: at,
      });
      ids.push(id);
    }
    return ids;
  }

  it('stops at its deadline and resumes after the last one it looked at', async () => {
    const t = setUp();
    approvedMany(t, 5);
    let clock = 0;
    const now = () => clock++;
    const first = await t.reconcile.handle({ deadline: 3, now });
    expect(first).toMatchObject({ looked: 3, stopped: true });
    clock = 0;
    const second = await t.reconcile.handle({ deadline: 100, now });
    expect(second).toMatchObject({ looked: 2, stopped: false });
    // At the end: the next run starts at the oldest again.
    clock = 0;
    expect(await t.reconcile.handle({ deadline: 100, now })).toMatchObject({
      looked: 5,
      stopped: false,
    });
  });

  it('reads at most so many pages per run, and records a merge the next run reaches', async () => {
    const t = setUp();
    approvedMany(t, MERGES_PAGE_SIZE * MAX_MERGE_PAGES_PER_RUN);
    // The newest: its merge landed, unrecorded.
    await bring(t, 'approved');
    const main = t.branches.heads.get('main') as string;
    const merged = await t.branches.merge({
      into: 'main',
      expected: main,
      head: t.current().reviewHead as string,
      message: 'Merge',
      actor: { kind: 'user', id: publisher.id },
      changeSetId: t.id,
      approvedBy: [{ kind: 'user', id: reviewer.id }],
    });
    expect(merged.kind).toBe('merged');
    // Keep it the newest of the approved ones.
    const index = t.store.changeSets.findIndex((c) => c.id === t.id);
    const [mine] = t.store.changeSets.splice(index, 1) as [ChangeSet];
    t.store.changeSets.push({ ...mine, createdAt: new Date() });

    const first = await t.reconcile.handle();
    expect(first).toMatchObject({
      looked: MERGES_PAGE_SIZE * MAX_MERGE_PAGES_PER_RUN,
      stopped: true,
      recovered: [],
    });
    const second = await t.reconcile.handle();
    expect(second).toMatchObject({
      looked: 1,
      stopped: false,
      recovered: [t.id],
    });
    expect(t.current().state).toBe('merged');
  });
});
