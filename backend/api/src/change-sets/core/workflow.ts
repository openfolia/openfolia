import { randomUUID } from 'node:crypto';
import {
  ConfigParseError,
  type Manifest,
  type Module,
  parseConfig,
  type ProjectConfig,
  type PageDesign,
  type Term,
  isConfigFileName,
  LEGACY_CONFIG_FILE_NAME,
} from '@openfolia/content-model';
import { Injectable } from '@nestjs/common';
import type { Actor } from '../../access/core/actor.js';
import { AuditLog } from '../../audit/core/audit-log.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../base/core/errors.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { OpenSnapshotAction } from '../../content/core/actions/open-snapshot.action.js';
import { RELEASED_BRANCH } from '../../content/core/released.js';
import { approversOf } from './approval.js';
import { ChangeSetAuthors } from './change-set-authors.js';
import { ApprovalStore } from './approval-store.js';
import type {
  ChangeSet,
  ChangeSetAuthor,
  ChangeSetState,
} from './change-set.js';
import { ChangeSetBranches } from './change-set-branches.js';
import { ChangeSetEvents } from './change-set-events.js';
import { ChangeSetStore } from './change-set-store.js';
import { DeprecationEvents } from './deprecation-events.js';
import {
  checkedFile,
  type ConfigUsage,
  configUsages,
  narrows,
} from './config-usage.js';
import { subjectKey, subjectName } from './lock.js';
import { termUsages, type TermUsage } from './term-usage.js';
import { CONFIG_FILE, subjectOfPath } from './subject-kinds.js';
import { LockStore } from './lock-store.js';
import { WorkingCopyStore } from './working-copy-store.js';
import { isActor, readsChangeSets } from './own-work.js';
import { reviewedChanges, type ReviewedChanges } from './review-scope.js';
import { allowsSelf, type SelfApproval } from './self-approval.js';

/**
 * The workflow's transitions, each an action of its own
 * (`core/actions/*-change-set.action.ts`) with the permission it needs:
 *
 * | Action   | From                    | To          | Who                                                      |
 * | -------- | ----------------------- | ----------- | -------------------------------------------------------- |
 * | submit   | `draft`                 | `in-review` | its author, or an editor (`content.edit`) over all of it |
 * | return   | `in-review`, `approved` | `draft`     | a reviewer (`content.review`) over all of it, not its author |
 * | approve  | `in-review`             | `approved`¹ | a reviewer (`content.review`) over all of it, not its author² |
 * | sign-off | `in-review`             | `approved`¹ | `content.approve` over a restricted type's modules, not its author² |
 * | merge    | `approved`              | `merged`    | a publisher (`release.publish`) over all of it           |
 * | abandon  | any open state          | `abandoned` | its author (`AbandonChangeSetAction`)                    |
 *
 * ¹ once every requirement is met (`requirementsOf`); until then it stays
 * `in-review` with the approval recorded.
 *
 * ² unless the installation's self-approval rule (`SelfApprovalRule`, #588)
 * lets its author give it: then it is recorded with `self: true`.
 *
 * "Its author" is everyone who wrote it (`authorsOf`, #597): the recorded
 * author and the writers of the commits it holds, carried ones included.
 *
 * "Over all of it": the permission's scope covers every module and manual
 * the change set changes, as they are at its base commit and at its review
 * head (`coversChanges`); restricted types are also read from the base
 * branch's tip. Every transition writes one audit event on the
 * change set (with its comment) and one outbox row, in its transaction.
 */
export const TRANSITIONS = {
  submit: { from: ['draft'], to: 'in-review' },
  return: { from: ['in-review', 'approved'], to: 'draft' },
  approve: { from: ['in-review'], to: 'approved' },
  'sign-off': { from: ['in-review'], to: 'approved' },
  merge: { from: ['approved'], to: 'merged' },
} as const satisfies Record<
  string,
  { from: readonly ChangeSetState[]; to: ChangeSetState }
>;

export type TransitionName = keyof typeof TRANSITIONS;

/** Who a recovered merge is recorded as when its commit names nobody the API wrote. */
export const RECONCILER_ACTOR: Actor = Object.freeze({
  kind: 'service',
  // Outside the `UserId` format (":"), so no user can have this ID.
  id: 'service:reconciler',
  roles: Object.freeze([]),
}) as Actor;

/** The detail of the four-eyes refusal. */
export const NOT_YOUR_OWN =
  'An author does not review, sign off or return their own change set.';

/** The detail when the installation lets an author approve, but not sign off, their own (#588). */
export const NO_OWN_SIGN_OFF =
  'This installation lets an author give the review approval of their own change set, but a restricted type’s sign-off needs someone else.';

/**
 * Who counts as a change set's author (`ChangeSetAuthors`), at the head they were read at; or
 * why they could not be read (`failed`), held until the change set is found for the actor.
 */
export type AuthorsAt =
  | { readonly head: string; readonly authors: readonly ChangeSetAuthor[] }
  | { readonly head: string; readonly failed: unknown };

/**
 * `read`'s authors when they were read at `head`, the head the transition reads under the row
 * lock; undefined when it moved since (returned and submitted again meanwhile): read them again.
 * Call it only after `Workflow.locked` found the change set for the actor: it throws the failure
 * held in `read`.
 */
export function readAuthors(
  read: AuthorsAt | undefined,
  head: string,
): readonly ChangeSetAuthor[] | undefined {
  if (read?.head !== head) return undefined;
  // Called after `locked`: the actor sees the change set, so why it failed may be told.
  if ('failed' in read) throw read.failed;
  return read.authors;
}

/** How often a transition reads the authors again when the head moved meanwhile. */
export const AUTHOR_READS = 3;

/** A transition's audit event and outbox row. */
export interface TransitionRecord {
  /** A transition of `TRANSITIONS`, or `abandon` (`AbandonChangeSetAction`). */
  readonly name: TransitionName | 'abandon';
  readonly from: ChangeSetState;
  readonly to: ChangeSetState;
  readonly comment?: string;
  readonly data?: Readonly<Record<string, unknown>>;
  /** The outbox key, when it must be unique per change set (a merge); else a new one. */
  readonly key?: string;
}

/**
 * What the transitions share: the change set read under its row lock and
 * the visibility rule, the changes read for scope checks, and recording a
 * transition (audit event and outbox row).
 */
@Injectable()
export class Workflow {
  constructor(
    private readonly store: ChangeSetStore,
    private readonly approvals: ApprovalStore,
    private readonly events: ChangeSetEvents,
    private readonly auditLog: AuditLog,
    private readonly branches: ChangeSetBranches,
    private readonly openSnapshot: OpenSnapshotAction,
    private readonly locks: LockStore,
    private readonly workingCopies: WorkingCopyStore,
    private readonly deprecations: DeprecationEvents,
    private readonly authors: ChangeSetAuthors,
  ) {}

  /**
   * The change set `id`, locked in `tx` until it ends (no other transition,
   * save, commit or abandon of it runs meanwhile). Another author's change
   * set is not found, exactly like a missing one, for an actor who may not
   * read change sets (#125); a state not in `from` is 409 `invalid-state`.
   */
  async locked(
    tx: Transaction,
    actor: Actor,
    id: string,
    name: TransitionName,
  ): Promise<ChangeSet> {
    const found = await this.store.lock(tx, id);
    if (!found || (!isActor(actor, found.author) && !readsChangeSets(actor))) {
      throw new NotFoundError(`No change set "${id}".`);
    }
    const from: readonly ChangeSetState[] = TRANSITIONS[name].from;
    if (!from.includes(found.state)) {
      throw new ConflictError(
        'invalid-state',
        `The change set is ${found.state}; ${name} takes one that is ${from.join(' or ')}.`,
        { state: found.state },
      );
    }
    return found;
  }

  /** Everyone who counts as the change set's author at `head` (`ChangeSetAuthors`, #597). */
  authorsOf(changeSet: ChangeSet, head: string): Promise<ChangeSetAuthor[]> {
    return this.authors.of(changeSet, head);
  }

  /**
   * Who counts as the author of change set `id` (`authorsOf`), read before the transition
   * `name`'s transaction: Git and the links in Postgres are read outside it, never while its row
   * is held. At its review head, or for a return that else its branch's head (what a return
   * answers for). The transaction then takes the authors only for the head it reads itself, and
   * only once `locked` has found the change set there for the actor (`readAuthors`).
   *
   * Nothing is read, and undefined is the answer, for a change set the actor may not see or one
   * whose state `name` does not take: `locked` then answers 404 or 409 `invalid-state` exactly as
   * without it. A failure reading them (409 `too-many-commits`, the link cap) is held, not thrown
   * here: `readAuthors` throws it after `locked`, so it never tells anyone of a change set they may
   * not see (#597).
   */
  async authorsBefore(
    actor: Actor,
    id: string,
    name: 'approve' | 'sign-off' | 'return',
  ): Promise<AuthorsAt | undefined> {
    const found = await this.store.find(id);
    if (!found || (!isActor(actor, found.author) && !readsChangeSets(actor))) {
      return undefined;
    }
    const from: readonly ChangeSetState[] = TRANSITIONS[name].from;
    if (!from.includes(found.state)) return undefined;
    const head =
      found.reviewHead ??
      (name === 'return' ? await this.branches.head(found.branch) : undefined);
    if (head === undefined) return undefined;
    try {
      return { head, authors: await this.authors.of(found, head) };
    } catch (error) {
      return { head, failed: error };
    }
  }

  /** 403 for any of the change set's authors (`authorsOf`: four eyes). */
  notTheAuthor(actor: Actor, authors: readonly ChangeSetAuthor[]): void {
    if (authors.some((a) => isActor(actor, a))) {
      throw new ForbiddenError(NOT_YOUR_OWN);
    }
  }

  /**
   * Whether `actor` gives `name` to their own change set (#588): false for anyone else; true for
   * one of its authors (`authorsOf`, #597) when the installation's self-approval rule (`rule`,
   * read when the approval is given) allows it; 403 for them otherwise. Scope is checked as for
   * anyone.
   */
  ownApproval(
    actor: Actor,
    authors: readonly ChangeSetAuthor[],
    name: 'approve' | 'sign-off',
    rule: SelfApproval,
  ): boolean {
    if (!authors.some((a) => isActor(actor, a))) return false;
    if (allowsSelf(rule, name)) return true;
    throw new ForbiddenError(
      name === 'sign-off' && allowsSelf(rule, 'approve')
        ? NO_OWN_SIGN_OFF
        : NOT_YOUR_OWN,
    );
  }

  /** Where the change set's branch points now; 409 when it is gone. */
  async headOf(changeSet: ChangeSet): Promise<string> {
    const head = await this.branches.head(changeSet.branch);
    if (head === undefined) {
      throw new ConflictError(
        'branch-missing',
        `The change set's branch ${changeSet.branch} is gone.`,
      );
    }
    return head;
  }

  /**
   * What the change set changes from its base commit to `head`, read by
   * commit ID as `actor` may open them. That needs `content.read.draft`
   * (an author without it, who opens only their own branch by name, gets
   * 404 here: they cannot review, sign off or merge without draft rights).
   * The base branch's tip is opened too, by commit ID, for its restricted
   * types: a base branch that is gone is a 409 `base-missing`. `baseTip`,
   * when given, is the base commit to read them at instead (a merge's: the
   * one it merges onto).
   */
  async changes(
    actor: Actor,
    changeSet: ChangeSet,
    head: string,
    baseTip?: string,
  ): Promise<ReviewedChanges> {
    // Where it will be merged now: a type restricted there since the
    // change set started needs its sign-off too.
    const tip = baseTip ?? (await this.branches.head(changeSet.baseRef));
    if (tip === undefined) {
      throw new ConflictError(
        'base-missing',
        `The change set’s base branch ${changeSet.baseRef} is gone.`,
      );
    }
    const [base, at, target] = await Promise.all([
      this.openSnapshot.handle({ actor, ref: changeSet.baseCommit }),
      this.openSnapshot.handle({ actor, ref: head }),
      this.openSnapshot.handle({ actor, ref: tip }),
    ]);
    if (
      base.commit !== changeSet.baseCommit ||
      at.commit !== head ||
      target.commit !== tip
    ) {
      throw new Error('A commit opened as another; refusing to check it.');
    }
    return reviewedChanges(this.branches, changeSet, base, at, [
      await target.config(),
    ]);
  }

  /**
   * What merging `head` onto `tip` (its base branch's head now) would make
   * invalid (#253), checked on the files the merge holds: a file only the
   * change set changed as at its head (valid under its configuration), a
   * file only the base changed as at the tip (valid under the base's), and
   * a file both changed, `openfolia.yaml` included, as Git would merge it
   * (`ChangeSetBranches.mergedFiles`; valid under either). The merged
   * configuration is the change set's, the base's, or the merged file.
   * Read past the reading filter (a check). Empty when the merged
   * configuration takes nothing away from either side's (`narrows`); a
   * merged `openfolia.yaml` that is no configuration is 409 `merge-conflict`.
   */
  async mergeUsages(
    actor: Actor,
    changeSet: ChangeSet,
    head: string,
    tip: string,
  ): Promise<ConfigUsage[]> {
    const [at, target] = await Promise.all([
      this.openSnapshot.handle({ actor, ref: head }),
      this.openSnapshot.handle({ actor, ref: tip }),
    ]);
    if (at.commit !== head || target.commit !== tip) {
      throw new Error('A commit opened as another; refusing to check it.');
    }
    const [ours, theirs] = await Promise.all([
      this.branches.changedPaths(changeSet.baseCommit, head),
      this.branches.changedPaths(changeSet.baseCommit, tip),
    ]);
    const onTip = new Set(theirs.map((c) => c.path));
    const subjectOf = (path: string) =>
      isConfigFileName(path) ? undefined : subjectOfPath(path);
    const both = ours
      .map((c) => c.path)
      .filter(
        (path) =>
          onTip.has(path) && (isConfigFileName(path) || subjectOf(path)),
      );
    const merged =
      both.length > 0
        ? await this.branches.mergedFiles(tip, head, both)
        : new Map<string, Uint8Array | null>();
    // A conflict is the merge's own answer, given when it is tried.
    if (merged === 'conflicts') return [];
    const [headConfig, tipConfig] = await Promise.all([
      at.config(),
      target.config(),
    ]);
    // The file in effect after the merge: `openfolia.yaml` when either side has it, else
    // `ccms.yaml` (read for one release). An edit of `ccms.yaml` the merge would ignore is
    // refused, so what was signed off is what takes effect, and so is the base's edit of
    // `ccms.yaml` since the change set began once the change set's `openfolia.yaml` replaces it
    // (it is updated from the base first). Taking `ccms.yaml` out is no edit lost.
    const inEffect = await Promise.all([
      at.configFileInEffect(),
      target.configFileInEffect(),
    ]);
    const configPath = inEffect.includes(CONFIG_FILE)
      ? CONFIG_FILE
      : LEGACY_CONFIG_FILE_NAME;
    if (configPath === CONFIG_FILE) {
      if (ours.some((c) => c.path === LEGACY_CONFIG_FILE_NAME && !c.deleted)) {
        throw ignoredLegacyConfig('change set');
      }
      if (
        inEffect[1] === LEGACY_CONFIG_FILE_NAME &&
        theirs.some((c) => c.path === LEGACY_CONFIG_FILE_NAME)
      ) {
        throw ignoredLegacyConfig('base');
      }
    }
    let config = tipConfig;
    if (merged.has(configPath)) {
      config = mergedConfig(merged.get(configPath) ?? null);
    } else if (ours.some((c) => c.path === configPath)) {
      config = headConfig;
    }
    if (!narrows(tipConfig, config) && !narrows(headConfig, config)) {
      return [];
    }
    const replaced = new Map<
      string,
      Module | Manifest | Term | PageDesign | null
    >();
    const alsoFrom = new Map<string, ProjectConfig>();
    for (const { path, deleted } of ours) {
      const subject = subjectOf(path);
      if (subject === undefined || subject.type === 'config') continue;
      const name = subjectName(subject);
      const bytes = merged.has(path)
        ? merged.get(path)
        : deleted
          ? null
          : await at.sourceForCheck(path);
      // A file that does not parse is no content to keep valid.
      replaced.set(name, bytes ? (checkedFile(subject, bytes) ?? null) : null);
      if (merged.has(path)) alsoFrom.set(name, tipConfig);
    }
    return configUsages(
      target,
      tipConfig,
      config,
      replaced,
      headConfig,
      alsoFrom,
    );
  }

  /**
   * The term links (#245) the tree merging `head` onto `tip` would hold to
   * a term it does not: a term one side deleted (since the change set's
   * base commit) that the other side, or a file Git merges, still links,
   * as a commit deleting a linked term is refused on its branch. The merged
   * tree is the tip with the change set's files (as Git merges those both
   * sides changed); every module of it counts, read past the reading
   * filter (`termUsages`). Empty when neither side deleted a term the
   * merge leaves out, or the merge conflicts (its own answer).
   */
  async mergeTermUsages(
    actor: Actor,
    changeSet: ChangeSet,
    head: string,
    tip: string,
  ): Promise<TermUsage[]> {
    const [ours, theirs] = await Promise.all([
      this.branches.changedPaths(changeSet.baseCommit, head),
      this.branches.changedPaths(changeSet.baseCommit, tip),
    ]);
    const termOf = (path: string) => {
      const subject = isConfigFileName(path) ? undefined : subjectOfPath(path);
      return subject?.type === 'term' ? subject.termId : undefined;
    };
    const gone = new Set(
      [...ours, ...theirs].flatMap(({ path, deleted }) => {
        const id = deleted ? termOf(path) : undefined;
        return id === undefined ? [] : [id];
      }),
    );
    if (gone.size === 0) return [];
    const onTip = new Set(theirs.map((c) => c.path));
    const both = ours
      .map((c) => c.path)
      .filter((path) => onTip.has(path) && subjectOfPath(path));
    const merged =
      both.length > 0
        ? await this.branches.mergedFiles(tip, head, both)
        : new Map<string, Uint8Array | null>();
    if (merged === 'conflicts') return [];
    const [at, target] = await Promise.all([
      this.openSnapshot.handle({ actor, ref: head }),
      this.openSnapshot.handle({ actor, ref: tip }),
    ]);
    if (at.commit !== head || target.commit !== tip) {
      throw new Error('A commit opened as another; refusing to check it.');
    }
    const replaced = new Map<
      string,
      Module | Manifest | Term | PageDesign | null
    >();
    for (const { path, deleted } of ours) {
      const subject = isConfigFileName(path) ? undefined : subjectOfPath(path);
      if (subject === undefined || subject.type === 'config') continue;
      const bytes = merged.has(path)
        ? merged.get(path)
        : deleted
          ? null
          : await at.sourceForCheck(path);
      replaced.set(
        subjectName(subject),
        bytes ? (checkedFile(subject, bytes) ?? null) : null,
      );
    }
    // A term the merged tree still holds (one side deleted it, the other
    // wrote it again) is no term gone.
    for (const id of gone) {
      const name = subjectName({ type: 'term', termId: id });
      const kept = replaced.has(name)
        ? replaced.get(name) !== null
        : (await target.termSource(id)) !== undefined;
      if (kept) gone.delete(id);
    }
    return termUsages(target, gone, replaced);
  }

  /** Records a transition of `changeSet` in `tx`: one audit event, one outbox row. */
  async record(
    tx: Transaction,
    actor: Actor,
    changeSet: ChangeSet,
    record: TransitionRecord,
  ): Promise<void> {
    await recordTransition(
      { auditLog: this.auditLog, events: this.events },
      tx,
      actor,
      changeSet.id,
      record,
    );
  }

  /**
   * Returns the change set to draft in `tx`: its review head cleared, its
   * approvals removed (the audit log keeps them), recorded as `return`.
   * The locks stay: the author goes on with the same modules.
   */
  async returnToDraft(
    tx: Transaction,
    actor: Actor,
    changeSet: ChangeSet,
    extra: { comment?: string; data?: Record<string, unknown> } = {},
  ): Promise<ChangeSet> {
    const returned = await this.store.transition(tx, changeSet.id, {
      state: 'draft',
      reviewHead: null,
    });
    const removed = await this.approvals.removeAllOf(tx, changeSet.id);
    await this.record(tx, actor, changeSet, {
      name: 'return',
      from: changeSet.state,
      to: 'draft',
      ...(extra.comment !== undefined && { comment: extra.comment }),
      data: {
        head: changeSet.reviewHead ?? null,
        ...(removed > 0 && { approvals: removed }),
        ...extra.data,
      },
    });
    return returned;
  }

  /**
   * When the approved `changeSet` (locked in `tx`) is merged already in
   * Git (its review head in its base's history: a merge whose recording
   * failed), records that merge now (`recordMerge`, `data.recovered`) and
   * returns the change set as merged; else undefined. Return and abandon
   * ask first, so a merge that landed is never lost from the database and
   * the audit log (`ReconcileChangeSetMergesAction` does the same later).
   */
  async landedMerge(
    tx: Transaction,
    changeSet: ChangeSet,
  ): Promise<ChangeSet | undefined> {
    const reviewHead = changeSet.reviewHead;
    if (changeSet.state !== 'approved' || reviewHead === undefined) {
      return undefined;
    }
    const found = await this.branches.mergedInto(
      changeSet.baseRef,
      reviewHead,
      changeSet.id,
    );
    if (!found) return undefined;
    const approvals = await this.approvals.listOf(tx, changeSet.id);
    // Recorded as the reconciler: who merged is only what the commit
    // says of itself, so it is kept as a claim, never as the actor.
    return this.recordMerge(tx, RECONCILER_ACTOR, changeSet, {
      commit: found.commit ?? reviewHead,
      fastForward: false,
      ...(found.commit === undefined && { mergeCommitFound: false }),
      approvedBy: approversOf(approvals, reviewHead),
      recovered: true,
      ...(found.mergedBy && { claimedMergedBy: found.mergedBy }),
    });
  }

  /**
   * Records in `tx` that the approved change set was merged into its base
   * at `merge.commit`: `merged`, one `change-set.merge` audit event and
   * outbox row (keyed by the change set, so it is recorded once), its
   * locks released (one `lock.release` event each, `data.reason`
   * `change-set.merge`) and any working copies dropped. What it deprecates
   * gets its outbox rows too (`module.deprecated`, `manual.deprecated`,
   * `DeprecationEvents`), from its base commit to its review head.
   */
  async recordMerge(
    tx: Transaction,
    actor: Actor,
    changeSet: ChangeSet,
    merge: {
      readonly commit: string;
      readonly fastForward: boolean;
      readonly approvedBy: readonly { kind: string; id: string }[];
      readonly recovered?: boolean;
      readonly mergeCommitFound?: false;
      /** A recovered merge: who its `Merged-by` trailer names. */
      readonly claimedMergedBy?: { kind: string; id: string };
      readonly comment?: string;
    },
  ): Promise<ChangeSet> {
    const merged = await this.store.transition(tx, changeSet.id, {
      state: 'merged',
      mergeCommit: merge.commit,
    });
    const dropped = await this.workingCopies.removeAllOf(tx, changeSet.id);
    await this.record(tx, actor, changeSet, {
      name: 'merge',
      from: changeSet.state,
      to: 'merged',
      key: changeSet.id,
      ...(merge.comment !== undefined && { comment: merge.comment }),
      data: {
        head: changeSet.reviewHead ?? null,
        into: changeSet.baseRef,
        commit: merge.commit,
        fastForward: merge.fastForward,
        approvedBy: merge.approvedBy.map((a) => `${a.kind}/${a.id}`),
        ...(dropped > 0 && { workingCopies: dropped }),
        ...(merge.recovered && { recovered: true }),
        ...(merge.mergeCommitFound === false && { mergeCommitFound: false }),
        ...(merge.claimedMergedBy && {
          claimedMergedBy: `${merge.claimedMergedBy.kind}/${merge.claimedMergedBy.id}`,
        }),
      },
    });
    // A deprecation is one on the released line (`main`): a maintenance line's merge writes none
    // (its change reaches `main` when it is carried forward, and is written then).
    const head = changeSet.reviewHead;
    if (head !== undefined && changeSet.baseRef === RELEASED_BRANCH) {
      const changed = () =>
        this.branches.changedPaths(changeSet.baseCommit, head);
      for (const event of await this.deprecations.of(changed, {
        changeSetId: changeSet.id,
        baseCommit: changeSet.baseCommit,
        head,
        commit: merge.commit,
      })) {
        await this.events.emit(tx, event);
      }
    }
    for (const lock of await this.locks.removeAllOf(tx, changeSet.id)) {
      await this.auditLog.record(tx, actor, {
        action: 'lock.release',
        subject: subjectKey(lock.subject),
        data: {
          lockId: lock.id,
          changeSetId: changeSet.id,
          reason: 'change-set.merge',
        },
      });
    }
    return merged;
  }
}

/**
 * Records a transition of the change set `changeSetId` in `tx`: one audit
 * event (`change-set.<name>`, `data: { from, to, … }`) and one outbox row
 * on the same topic with the same data, the change set and the actor.
 */
export async function recordTransition(
  deps: { readonly auditLog: AuditLog; readonly events: ChangeSetEvents },
  tx: Transaction,
  actor: Actor,
  changeSetId: string,
  record: TransitionRecord,
): Promise<void> {
  const data = { from: record.from, to: record.to, ...record.data };
  await deps.auditLog.record(tx, actor, {
    action: `change-set.${record.name}`,
    subject: { type: 'change-set', id: changeSetId },
    ...(record.comment !== undefined && { comment: record.comment }),
    data,
  });
  await deps.events.emit(tx, {
    topic: `change-set.${record.name}`,
    key: record.key ?? `${changeSetId}/${randomUUID()}`,
    payload: {
      changeSetId,
      actor: { kind: actor.kind, id: actor.id },
      ...(record.comment !== undefined && { comment: record.comment }),
      ...data,
    },
  });
}

/** 409 `invalid-state` for a change set found merged (in Git) meanwhile. */
export function mergedMeanwhile(): ConflictError {
  return new ConflictError(
    'invalid-state',
    'The change set is merged (its merge is recorded now).',
    { state: 'merged' },
  );
}

/**
 * 409 `head-moved`: the change set's branch is no longer at the commit
 * submitted for review (something was pushed to it outside the API), so no
 * approval of it holds. The change set has been returned to draft; its
 * author submits it again.
 */
export function headMoved(reviewHead: string, head: string): ConflictError {
  return new ConflictError(
    'head-moved',
    'The change set’s branch moved after it was submitted, so its approvals no longer hold; it is back in draft, to be submitted again.',
    { reviewHead, head },
  );
}

/**
 * 409 `merge-conflict`: the change set edits `ccms.yaml` (the configuration's earlier name) while
 * the merged tree has `openfolia.yaml`, which wins, so the edit would be ignored.
 */
function ignoredLegacyConfig(side: 'change set' | 'base'): ConflictError {
  return new ConflictError(
    'merge-conflict',
    side === 'change set'
      ? `The change set changes ${LEGACY_CONFIG_FILE_NAME}, but the configuration in effect after the merge is ${CONFIG_FILE}: the change would be ignored. Return it for its author to make the change in ${CONFIG_FILE}.`
      : `The base changed ${LEGACY_CONFIG_FILE_NAME} since the change set began, but the change set's ${CONFIG_FILE} would replace it after the merge: the base's change would be ignored. Return it for its author to update it from the base and carry the change into ${CONFIG_FILE}.`,
    {
      conflicts: [{ path: LEGACY_CONFIG_FILE_NAME, kinds: ['contents'] }],
      total: 1,
    },
  );
}

/** The configuration a merge holds, from its merged `openfolia.yaml`. */
function mergedConfig(bytes: Uint8Array | null): ProjectConfig {
  const refuse = () =>
    new ConflictError(
      'merge-conflict',
      'The configuration the merge would make does not read as one; it stays approved but unmerged. Return it for its author to resolve.',
      {
        conflicts: [{ path: CONFIG_FILE, kinds: ['contents'] }],
        total: 1,
      },
    );
  if (bytes === null) throw refuse();
  try {
    return parseConfig(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof ConfigParseError || error instanceof TypeError) {
      throw refuse();
    }
    throw error;
  }
}
