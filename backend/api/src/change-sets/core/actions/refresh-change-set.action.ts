import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import {
  ConflictError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import {
  BOUNDED,
  type Transaction,
  UnitOfWork,
} from '../../../base/core/unit-of-work.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import { ReadableRefs } from '../../../content/core/readable-refs.js';
import type { ChangeSet } from '../change-set.js';
import {
  ChangeSetBranches,
  type MergeConflictPath,
} from '../change-set-branches.js';
import { baseRewritten } from '../change-set-behind.js';
import { ChangeSetCommits } from '../change-set-commits.js';
import { ChangeSetStore } from '../change-set-store.js';
import {
  bySubjectKey,
  changedIn,
  subjectOfPath,
  subjectPath,
} from '../commit.js';
import { CommitRecorder } from '../commit-recorder.js';
import type { LockSubject } from '../lock.js';
import { LockStore } from '../lock-store.js';
import { RefreshConflictStore } from '../refresh-conflicts.js';
import {
  checkDraft,
  distinct,
  keyOf,
  refuseBranchRecords,
} from '../save-point.js';
import { checkCommittedScope } from '../subject-scope.js';
import { authorsChangeSet, ownChangeSet } from '../working-copy-rules.js';
import { WorkingCopyStore } from '../working-copy-store.js';
import { CommitWorkingCopiesAction } from './commit-working-copies.action.js';

/** How often an update is tried again when the branch moved meanwhile. */
export const REFRESH_ATTEMPTS = 3;

/** The most subjects one update keeps (`keep`). */
export const MAX_KEEP = 100;

/** The most conflicts one answer lists (`meta.total` counts all). */
export const MAX_REFRESH_CONFLICTS = 100;

/** The 403's detail for anyone but its author. */
export const AUTHOR_UPDATES =
  'Only its author updates a change set from its base.';

/** What only a draft is (the `invalid-state` answer's end). */
const UPDATED = 'is updated from its base';

export interface RefreshChangeSetInput {
  readonly actor: Actor;
  readonly id: string;
  /**
   * Subjects whose file keeps the change set's version where it conflicts
   * with the base: the author resolved them (in the editor, typing the
   * base's change into their own). Each must have been saved since the
   * update reported it (#437). Their working copies are committed first,
   * as a save point.
   */
  readonly keep?: readonly LockSubject[];
  /**
   * Subjects kept as the change set has them by the author's explicit
   * choice ("Keep my version"), saved since or not: the base's change to
   * them is dropped where it conflicts. Otherwise as `keep`; audited apart.
   */
  readonly keepMine?: readonly LockSubject[];
  /** Why, for the audit log. */
  readonly comment?: string;
}

/** A path the update cannot take in by itself. */
export interface RefreshConflict {
  readonly path: string;
  /** The module, manual, configuration or term it is the file of. */
  readonly subject?: LockSubject;
  /**
   * Git's conflict kinds (`contents`, `modify/delete`, …), or
   * `working-copy`: a working copy not yet committed of a file the base
   * changed.
   */
  readonly kinds: readonly string[];
}

/** What an update did. */
export interface RefreshOutcome {
  readonly changeSet: ChangeSet;
  /** Where its branch is now. */
  readonly head: string;
  /** False when its branch held its base's head already (nothing written to Git). */
  readonly updated: boolean;
  /** The branch moved to the base's head (it had no commits of its own). */
  readonly fastForward: boolean;
  /** The save point that committed the kept subjects' working copies first. */
  readonly savePoint?: string;
}

/** What the preflight found: how the update would go. */
type Plan =
  | {
      readonly kind: 'up-to-date';
      readonly base: { commit: string; released: boolean };
      readonly head: string;
    }
  | {
      readonly kind: 'clean';
      readonly base: { commit: string; released: boolean };
      readonly head: string;
      /** The files the update changes on the branch. */
      readonly changed: ReadonlyMap<string, boolean>;
      /** The kept subjects whose file conflicts: resolved to the branch's. */
      readonly kept: readonly LockSubject[];
      /** The kept subjects with a working copy, to commit first. */
      readonly toCommit: readonly LockSubject[];
    };

/** How a kept subject was resolved: saved since the report, or kept by choice. */
type Resolution = 'edited' | 'chosen';

/** The branch moved between the preflight and the write: plan again. */
const MOVED = Symbol('moved');

/**
 * Updates a draft change set from its base branch (#22): merges the base's
 * head into its branch, so it holds what was merged there since it
 * started, and moves its base commit on to that head (what it changes is
 * then counted from there). By its author only (`content.edit`), on a
 * draft (409 `invalid-state`); the base is read as the author may read it
 * (a draft base they may not read is 409 `base-missing`, as a gone one).
 *
 * - **Conflicts** are answered as data and write nothing: 409
 *   `refresh-conflict` with the paths (`meta.conflicts`, at most
 *   `MAX_REFRESH_CONFLICTS`; `meta.total`), each with its subject where it
 *   is one. A working copy not yet committed of a file the base changed
 *   is one too (kind `working-copy`): commit or discard it first, or keep
 *   it.
 * - **Resolving:** the author makes the conflicting files what they should
 *   be in the editor (saving them), then updates again naming them in
 *   `keep`, or names in `keepMine` those to keep as they are. Each
 *   conflict answered is recorded (`RefreshConflictStore`) and a save
 *   marks it saved; a subject in `keep` whose keeping matters (its file
 *   conflicts, or its working copy is in the update's way) is taken only
 *   once saved since its report, against a base whose file is still the
 *   one reported (else it is reported anew): otherwise 409
 *   `refresh-unresolved` with the subjects (`meta.unresolved`), and
 *   nothing is written (#437). Their working copies are committed first, as a save point
 *   (`CommitWorkingCopiesAction`: every check a save point makes), then
 *   the merge keeps the branch's file where it conflicts (a plain file
 *   conflict only: `contents`, `add/add`, `modify/delete`). A kept subject
 *   that conflicts needs the change set's lock on it (409
 *   `lock-required`) and the actor's scope over it as committed (403);
 *   a kept page design or manifest whose translation record differs from
 *   the base's in a language the actor does not manage is 422
 *   `translation-record-protected` (#663): save it with the base's record
 *   first, which anyone may.
 * - **Up to date** (its branch holds the base's head): nothing is written
 *   to Git; a base commit left behind (an update whose recording failed)
 *   is moved on now and audited as recovered.
 *
 * **Order: Git first, then the database**, as save points and merges do.
 * One bounded transaction holds the change set's row and the kept
 * subjects' locks, records any save point left unrecorded below the head
 * (`CommitRecorder.catchUp`), makes the merge in Git (compare-and-swap on
 * the head the preflight read), then records it: the new base commit, an
 * outbox row for the merge commit (so recovery stops there), working
 * copies whose file did not change moved on to the new head (one version
 * further), and one `change-set.refresh` audit event. A branch that moved
 * meanwhile is planned again, up to `REFRESH_ATTEMPTS` (then 409
 * `branch-moved`). If the transaction fails after the merge landed, an
 * update tried again finds the branch up to date and records it.
 */
@Injectable()
export class RefreshChangeSetAction extends ActorAction<
  RefreshChangeSetInput,
  RefreshOutcome
> {
  readonly policy = 'content.edit';

  constructor(
    private readonly changeSets: ChangeSetStore,
    private readonly branches: ChangeSetBranches,
    private readonly refs: ReadableRefs,
    private readonly workingCopies: WorkingCopyStore,
    private readonly locks: LockStore,
    private readonly commits: ChangeSetCommits,
    private readonly recorder: CommitRecorder,
    private readonly auditLog: AuditLog,
    private readonly openSnapshot: OpenSnapshotAction,
    private readonly commitWorkingCopies: CommitWorkingCopiesAction,
    private readonly unit: UnitOfWork,
    private readonly reported: RefreshConflictStore,
  ) {
    super();
  }

  protected async run(input: RefreshChangeSetInput): Promise<RefreshOutcome> {
    const { actor, id, comment } = input;
    const edited = distinct(input.keep ?? [], 'keep');
    const mine = distinct(input.keepMine ?? [], 'keepMine');
    const chosen = new Set(mine.map(keyOf));
    const twice = edited.find((s) => chosen.has(keyOf(s)));
    if (twice) {
      throw new UnprocessableError(
        'duplicate-subject',
        `${keyOf(twice)} is named in both \`keep\` and \`keepMine\`.`,
        { subject: twice },
      );
    }
    const keep = [...edited, ...mine];
    if (keep.length > MAX_KEEP) {
      throw new UnprocessableError(
        'too-many-subjects',
        `One update keeps at most ${MAX_KEEP} subjects.`,
        { max: MAX_KEEP },
      );
    }
    let savePoint: string | undefined;
    // How each kept subject that mattered in the last plan was resolved.
    let resolutions = new Map<string, Resolution>();
    let attempts = 0;
    let saves = 0;
    while (attempts < REFRESH_ATTEMPTS) {
      const changeSet = await authorsChangeSet(
        this.changeSets,
        actor,
        id,
        AUTHOR_UPDATES,
      );
      checkDraft(changeSet, UPDATED);
      const planned = new Map<string, Resolution>();
      const plan = await this.plan(actor, changeSet, keep, chosen, planned);
      if (plan === MOVED) {
        attempts++;
        continue;
      }
      resolutions = planned;
      if (plan.kind === 'clean' && plan.toCommit.length > 0) {
        // Saved again since the last save point: that one counts as a move.
        if (saves++ > 0) attempts++;
        const committed = await this.commitWorkingCopies.handle({
          actor,
          changeSetId: id,
          subjects: plan.toCommit,
          message: `Resolve conflicts with ${changeSet.baseRef}`,
          // Resolving: the base's head's translation records may be taken (#663).
          reportedBases: [plan.base.commit],
        });
        savePoint = committed.commit ?? savePoint;
        continue;
      }
      attempts++;
      const outcome = await this.unit.run(
        (tx) =>
          this.write(
            tx,
            actor,
            id,
            keep,
            plan,
            comment,
            savePoint,
            resolutions,
          ),
        BOUNDED,
      );
      if (outcome !== MOVED) return outcome;
    }
    throw new ConflictError(
      'branch-moved',
      'The change set’s branch kept moving while updating it; try again.',
    );
  }

  /**
   * Everything but the write, holding no row: the base and the branch's
   * head, what the merge would do, the working copies in its way and the
   * scope over what it keeps.
   */
  private async plan(
    actor: Actor,
    changeSet: ChangeSet,
    keep: readonly LockSubject[],
    chosen: ReadonlySet<string>,
    resolutions: Map<string, Resolution>,
  ): Promise<Plan | typeof MOVED> {
    const base = await this.refs.branch(actor, changeSet.baseRef);
    if (!base) {
      throw new ConflictError(
        'base-missing',
        `The change set’s base branch ${changeSet.baseRef} is gone.`,
      );
    }
    const head = await this.branches.head(changeSet.branch);
    if (head === undefined) {
      throw new ConflictError(
        'branch-missing',
        `The change set's branch ${changeSet.branch} is gone.`,
      );
    }
    // What the change set changes is counted from its base commit: a base
    // rewound past it (outside the API) would bring in something else.
    if (await baseRewritten(this.branches, changeSet, base.commit)) {
      throw new ConflictError(
        'base-rewritten',
        'The base branch no longer holds the commit the change set started from.',
        { baseCommit: changeSet.baseCommit },
      );
    }
    const preview = await this.branches.previewRefresh({
      expected: head,
      base: base.commit,
      keep: [],
    });
    if (preview.kind === 'up-to-date') {
      return { kind: 'up-to-date', base, head };
    }
    let kept: LockSubject[] = [];
    let changed = preview.kind === 'clean' ? preview.changed : [];
    if (preview.kind === 'conflicts') {
      const conflicting = new Set(preview.conflicts.map((c) => c.path));
      kept = keep.filter((s) => changedIn(conflicting, s));
      const resolved =
        kept.length === 0
          ? preview
          : await this.branches.previewRefresh({
              expected: head,
              base: base.commit,
              keep: kept.map(subjectPath),
            });
      if (resolved.kind !== 'clean') {
        const left = resolved.kind === 'conflicts' ? resolved.conflicts : [];
        await this.report(changeSet, base.commit, left);
        throw refreshConflict(changeSet, left);
      }
      changed = resolved.changed;
    }
    const sizes = await this.unit.run((tx) =>
      this.workingCopies.sizesOf(tx, changeSet.id),
    );
    const keys = new Set(keep.map(keyOf));
    const paths = new Map(changed.map((c) => [c.path, c.deleted]));
    const unsaved = sizes.filter(
      (s) => !keys.has(keyOf(s.subject)) && changedIn(paths, s.subject),
    );
    if (unsaved.length > 0) {
      const inTheWay = unsaved.map((s) => ({
        path: subjectPath(s.subject),
        kinds: ['working-copy'],
      }));
      await this.report(changeSet, base.commit, inTheWay);
      throw refreshConflict(changeSet, inTheWay);
    }
    // Keeping matters where the file conflicts, or where its working copy
    // (committed first) is in the update's way: the base's change to it
    // could be dropped. Only once resolved (#437).
    const keptKeys = new Set(kept.map(keyOf));
    const copies = new Set(sizes.map((s) => keyOf(s.subject)));
    const matters = keep.filter(
      (s) =>
        keptKeys.has(keyOf(s)) || (copies.has(keyOf(s)) && changedIn(paths, s)),
    );
    const unresolved = await this.resolve(
      changeSet,
      base.commit,
      matters,
      chosen,
      resolutions,
    );
    if (unresolved.length > 0) {
      throw refreshUnresolved(changeSet, unresolved);
    }
    const toCommit = sizes
      .filter((s) => keys.has(keyOf(s.subject)))
      .map((s) => s.subject);
    if (toCommit.length === 0 && kept.length > 0) {
      // Keeping a file is changing it on the branch: the same scope as
      // committing it, against the actor's roles now.
      const snapshot = await this.openSnapshot.handle({
        actor,
        ref: changeSet.branch,
      });
      // The branch moved since: plan again rather than skip the check.
      if (snapshot.commit !== head) return MOVED;
      for (const subject of kept) {
        await checkCommittedScope(actor, snapshot, subject);
      }
    }
    if (toCommit.length === 0) {
      const outcome = await this.checkRecords(
        actor,
        changeSet,
        head,
        base.commit,
        kept,
      );
      if (outcome === MOVED) return MOVED;
    }
    return { kind: 'clean', base, head, changed: paths, kept, toCommit };
  }

  /**
   * 422 `translation-record-protected` when the update would put a page
   * design's or manifest's translation record onto the base's head that
   * the actor may not write there (#663, `refuseBranchRecords`): a file
   * kept whole (`kept`) keeps the branch's record, so it must be the base
   * head's; any other the branch changed since its base commit is merged
   * three-way, so its record must be the base head's or the base commit's
   * (then the base's wins). Unless the actor manages the language. A file
   * the branch deleted takes its record with it. `MOVED` when the branch
   * moved.
   */
  private async checkRecords(
    actor: Actor,
    changeSet: ChangeSet,
    head: string,
    baseHead: string,
    kept: readonly LockSubject[],
  ): Promise<void | typeof MOVED> {
    const onto = async () => {
      const opened = await this.openSnapshot.handle({ actor, ref: baseHead });
      if (opened.commit !== baseHead) {
        throw new Error('A commit opened as another; refusing to check it.');
      }
      return opened;
    };
    const outcome = await refuseBranchRecords(
      this.openSnapshot,
      this.branches,
      actor,
      changeSet,
      head,
      { onto, kept },
    );
    if (outcome === 'moved') return MOVED;
  }

  /** The write step, in one bounded transaction; `MOVED` to plan again. */
  private async write(
    tx: Transaction,
    actor: Actor,
    id: string,
    keep: readonly LockSubject[],
    plan: Plan,
    comment: string | undefined,
    savePoint: string | undefined,
    resolutions: ReadonlyMap<string, Resolution>,
  ): Promise<RefreshOutcome | typeof MOVED> {
    const changeSet = ownChangeSet(
      await this.changeSets.lock(tx, id),
      actor,
      id,
      AUTHOR_UPDATES,
    );
    checkDraft(changeSet, UPDATED);
    if ((await this.branches.head(changeSet.branch)) !== plan.head) {
      return MOVED;
    }
    // A save point that landed unrecorded below the head is recorded
    // first: recovery's walk back stops at the merge commit's record.
    await this.recorder.catchUp(tx, changeSet, plan.head);
    if (plan.kind === 'up-to-date') {
      return this.upToDate(tx, actor, changeSet, plan, comment, savePoint);
    }
    // Saved since the preflight: a copy in the update's way, or one more
    // to commit first.
    const keys = new Set(keep.map(keyOf));
    const sizes = await this.workingCopies.sizesOf(tx, changeSet.id);
    if (
      sizes.some(
        (s) => keys.has(keyOf(s.subject)) || changedIn(plan.changed, s.subject),
      )
    ) {
      return MOVED;
    }
    if (plan.kept.length > 0) {
      const held = (await this.locks.holdAll(tx, plan.kept)).filter(
        (lock) => lock.changeSetId === changeSet.id,
      );
      const holding = new Set(held.map((lock) => keyOf(lock.subject)));
      const missing = plan.kept.find((s) => !holding.has(keyOf(s)));
      if (missing) {
        throw new ConflictError(
          'lock-required',
          `Take the lock on ${keyOf(missing)} for this change set first.`,
          { subject: missing },
        );
      }
    }
    const author = { kind: actor.kind, id: actor.id };
    const result = await this.branches.refresh(changeSet.branch, {
      expected: plan.head,
      base: plan.base.commit,
      keep: plan.kept.map(subjectPath),
      // The title first: a last paragraph git could read as trailers is
      // refused, and this one reads as none.
      message: `Update from ${changeSet.baseRef}\n\nUpdate change set ${changeSet.id} from ${changeSet.baseRef}.`,
      actor: author,
      changeSetId: changeSet.id,
    });
    switch (result.kind) {
      case 'moved':
      case 'up-to-date':
        return MOVED;
      case 'conflicts':
        // The preview was clean: something changed since. Plan again,
        // which reports what conflicts now.
        return MOVED;
    }
    // Updated: no conflict reported before stands.
    await this.reported.clear(tx, changeSet.id);
    const after = await this.changeSets.rebase(tx, changeSet.id, {
      baseCommit: plan.base.commit,
      baseReleased: changeSet.baseReleased && plan.base.released,
    });
    const changed = [...plan.changed];
    const written = subjectsOf(changed.filter(([, d]) => !d).map(([p]) => p));
    const deleted = subjectsOf(changed.filter(([, d]) => d).map(([p]) => p));
    if (!result.fastForward) {
      await this.commits.record(tx, {
        changeSetId: changeSet.id,
        branch: changeSet.branch,
        commit: result.commit,
        parent: plan.head,
        actor: author,
        written,
        deleted,
      });
    }
    const moved = await this.moveWorkingCopies(
      tx,
      changeSet.id,
      result.commit,
      new Map([[plan.head, new Set(plan.changed.keys())]]),
    );
    await this.auditLog.record(tx, actor, {
      action: 'change-set.refresh',
      subject: { type: 'change-set', id: changeSet.id },
      ...(comment !== undefined && { comment }),
      data: {
        baseRef: changeSet.baseRef,
        from: changeSet.baseCommit,
        to: plan.base.commit,
        parent: plan.head,
        commit: result.commit,
        fastForward: result.fastForward,
        written: written.length,
        deleted: deleted.length,
        kept: plan.kept.map(keyOf),
        resolvedByEditing: resolvedAs(resolutions, 'edited'),
        keptByChoice: resolvedAs(resolutions, 'chosen'),
        workingCopiesMoved: moved,
        ...(savePoint !== undefined && { savePoint }),
      },
    });
    return {
      changeSet: after,
      head: result.commit,
      updated: true,
      fastForward: result.fastForward,
      ...(savePoint !== undefined && { savePoint }),
    };
  }

  /**
   * The branch holds the base's head already. When the base commit was
   * left behind (the recording of an update failed after Git, or a merge
   * was pushed from outside), it moves on to that head now, audited as
   * recovered; otherwise nothing changes.
   */
  private async upToDate(
    tx: Transaction,
    actor: Actor,
    changeSet: ChangeSet,
    plan: Extract<Plan, { kind: 'up-to-date' }>,
    comment: string | undefined,
    savePoint: string | undefined,
  ): Promise<RefreshOutcome> {
    const outcome = {
      head: plan.head,
      updated: false,
      fastForward: false,
      ...(savePoint !== undefined && { savePoint }),
    };
    // Up to date: no conflict reported before stands.
    await this.reported.clear(tx, changeSet.id);
    if (changeSet.baseCommit === plan.base.commit) {
      return { changeSet, ...outcome };
    }
    const after = await this.changeSets.rebase(tx, changeSet.id, {
      baseCommit: plan.base.commit,
      baseReleased: changeSet.baseReleased && plan.base.released,
    });
    const moved = await this.moveWorkingCopies(
      tx,
      changeSet.id,
      plan.head,
      new Map(),
    );
    await this.auditLog.record(tx, actor, {
      action: 'change-set.refresh',
      subject: { type: 'change-set', id: changeSet.id },
      ...(comment !== undefined && { comment }),
      data: {
        baseRef: changeSet.baseRef,
        from: changeSet.baseCommit,
        to: plan.base.commit,
        parent: plan.head,
        commit: plan.head,
        recovered: true,
        workingCopiesMoved: moved,
      },
    });
    return { changeSet: after, ...outcome };
  }

  /**
   * Which of `matters` (kept subjects whose keeping drops the base's
   * change where it conflicts) are not resolved: neither in `chosen` (kept
   * by choice) nor saved since the update reported them, against a base
   * whose file is still the one reported. One without a report, or whose
   * file the base changed since, is reported now against `base` (so a save
   * from now on counts). Records how the others were resolved.
   */
  private async resolve(
    changeSet: ChangeSet,
    base: string,
    matters: readonly LockSubject[],
    chosen: ReadonlySet<string>,
    resolutions: Map<string, Resolution>,
  ): Promise<LockSubject[]> {
    const toCheck: LockSubject[] = [];
    for (const subject of matters) {
      if (chosen.has(keyOf(subject))) resolutions.set(keyOf(subject), 'chosen');
      else toCheck.push(subject);
    }
    if (toCheck.length === 0) return [];
    const reports = new Map(
      (await this.unit.run((tx) => this.reported.of(tx, changeSet.id))).map(
        (r) => [keyOf(r.subject), r],
      ),
    );
    const same = this.sameFileSince(base);
    const unresolved: LockSubject[] = [];
    const stale: LockSubject[] = [];
    for (const subject of toCheck) {
      const report = reports.get(keyOf(subject));
      if (!report || !(await same(report.base, subject))) {
        stale.push(subject);
        unresolved.push(subject);
      } else if (report.savedAt === undefined) {
        unresolved.push(subject);
      } else {
        resolutions.set(keyOf(subject), 'edited');
      }
    }
    if (stale.length > 0) {
      await this.unit.run((tx) =>
        this.reported.report(
          tx,
          changeSet.id,
          stale.map((subject) => ({ subject, base })),
        ),
      );
    }
    return unresolved;
  }

  /**
   * Records the subjects among `conflicts` (those an answer lists) as
   * reported against `base`: anew where none was, or where the base's file
   * changed since the one before (what was saved for it was saved against
   * another change). A report that still holds keeps its save.
   */
  private async report(
    changeSet: ChangeSet,
    base: string,
    conflicts: readonly MergeConflictPath[],
  ): Promise<void> {
    const subjects = subjectsOf(
      conflicts.slice(0, MAX_REFRESH_CONFLICTS).map((c) => c.path),
    );
    if (subjects.length === 0) return;
    const reports = new Map(
      (await this.unit.run((tx) => this.reported.of(tx, changeSet.id))).map(
        (r) => [keyOf(r.subject), r],
      ),
    );
    const same = this.sameFileSince(base);
    const fresh: LockSubject[] = [];
    for (const subject of subjects) {
      const report = reports.get(keyOf(subject));
      if (!report || !(await same(report.base, subject))) fresh.push(subject);
    }
    if (fresh.length === 0) return;
    await this.unit.run((tx) =>
      this.reported.report(
        tx,
        changeSet.id,
        fresh.map((subject) => ({ subject, base })),
      ),
    );
  }

  /**
   * Whether a subject's file is the same at `base` as at an earlier base
   * head; false when that cannot be told (fail closed: reported anew).
   */
  private sameFileSince(
    base: string,
  ): (since: string, subject: LockSubject) => Promise<boolean> {
    const changed = new Map<string, Promise<Set<string> | undefined>>();
    return async (since, subject) => {
      if (since === base) return true;
      let paths = changed.get(since);
      if (!paths) {
        paths = this.branches
          .changedPaths(since, base)
          .then((list) => new Set(list.map((c) => c.path)))
          .catch(() => undefined);
        changed.set(since, paths);
      }
      const found = await paths;
      return found !== undefined && !changedIn(found, subject);
    };
  }

  /**
   * Moves each working copy whose file is the same at `head` as at the
   * commit it is based on to `head`, one version further (a tab holding
   * it reads it again), so it does not look stale once the base commit
   * moved on. `known` holds the changed paths already known per commit.
   * How many moved.
   */
  private async moveWorkingCopies(
    tx: Transaction,
    changeSetId: string,
    head: string,
    known: Map<string, Set<string>>,
  ): Promise<number> {
    const changedSince = new Map<string, Promise<Set<string> | undefined>>(
      [...known].map(([commit, paths]) => [commit, Promise.resolve(paths)]),
    );
    let moved = 0;
    for (const { subject } of await this.workingCopies.sizesOf(
      tx,
      changeSetId,
    )) {
      const copy = await this.workingCopies.get(tx, changeSetId, subject);
      if (!copy || copy.baseCommit === head) continue;
      let paths = changedSince.get(copy.baseCommit);
      if (!paths) {
        paths = this.branches
          .changedPaths(copy.baseCommit, head)
          .then((list) => new Set(list.map((c) => c.path)))
          .catch(() => undefined);
        changedSince.set(copy.baseCommit, paths);
      }
      const changed = await paths;
      if (!changed || changedIn(changed, subject)) continue;
      if (
        await this.workingCopies.rebase(
          tx,
          changeSetId,
          subject,
          copy.baseCommit,
          head,
        )
      ) {
        moved++;
      }
    }
    return moved;
  }
}

/** 409 `refresh-conflict`, the paths (with their subjects) as data. */
export function refreshConflict(
  changeSet: Pick<ChangeSet, 'baseRef'>,
  conflicts: readonly MergeConflictPath[],
): ConflictError {
  const listed: RefreshConflict[] = conflicts.map((c) => {
    const subject = subjectOfPath(c.path);
    return { path: c.path, ...(subject && { subject }), kinds: [...c.kinds] };
  });
  return new ConflictError(
    'refresh-conflict',
    `Updating from ${changeSet.baseRef} conflicts in ${conflicts.length} file(s); nothing was written. Make them what they should be in the editor, then update again keeping them.`,
    {
      conflicts: listed.slice(0, MAX_REFRESH_CONFLICTS),
      total: listed.length,
    },
  );
}

/**
 * 409 `refresh-unresolved`: kept subjects neither saved since the update
 * reported them nor kept by choice, as data.
 */
export function refreshUnresolved(
  changeSet: Pick<ChangeSet, 'baseRef'>,
  subjects: readonly LockSubject[],
): ConflictError {
  const listed = [...subjects].sort(bySubjectKey);
  return new ConflictError(
    'refresh-unresolved',
    `${listed.length} kept file(s) were not saved since updating from ${changeSet.baseRef} reported them conflicting (or ${changeSet.baseRef} changed them again); nothing was written. Save each as it should be in the editor, or keep it as it is (\`keepMine\`), then update again.`,
    {
      unresolved: listed.map((subject) => ({
        path: subjectPath(subject),
        subject,
      })),
      total: listed.length,
    },
  );
}

/** The subject keys resolved as `how`, in order. */
function resolvedAs(
  resolutions: ReadonlyMap<string, Resolution>,
  how: Resolution,
): string[] {
  return [...resolutions]
    .filter(([, r]) => r === how)
    .map(([key]) => key)
    .sort();
}

/** Subjects in subject-key order, each once. */
export function subjectsOf(paths: Iterable<string>): LockSubject[] {
  const seen = new Map<string, LockSubject>();
  for (const path of paths) {
    const subject = subjectOfPath(path);
    if (subject) seen.set(keyOf(subject), subject);
  }
  return [...seen.values()].sort(bySubjectKey);
}
