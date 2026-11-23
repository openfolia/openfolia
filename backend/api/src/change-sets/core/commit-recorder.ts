import { Injectable } from '@nestjs/common';
import { AuditLog } from '../../audit/core/audit-log.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import type { ChangeSet } from './change-set.js';
import { ChangeSetBranches } from './change-set-branches.js';
import { ChangeSetCommits } from './change-set-commits.js';
import { type CommitIntent, CommitIntents } from './commit-intents.js';
import {
  type ChangeSetCommit,
  MAX_RECOVERED_COMMITS,
  changedIn,
  subjectPath,
} from './commit.js';
import { type LockSubject, subjectKey } from './lock.js';
import { kindOf, type Printed } from './subject-kinds.js';
import type { WorkingCopyContent } from './working-copy.js';
import { sameBytes } from './working-copy-rules.js';
import { WorkingCopyStore } from './working-copy-store.js';

/** What `CommitRecorder.catchUp` did. */
export interface CatchUp {
  /** The commits it recorded, oldest first. */
  readonly recovered: string[];
  /** Working copies it dropped: they held exactly what a recovered commit wrote. */
  readonly dropped: number;
  /**
   * The newest commit it found unrecorded and matching no intent: one
   * not made by a save point of this API (pushed from
   * outside, a merge), whatever its trailers or author say. Never
   * recorded; left for a person to look at.
   */
  readonly unmatched?: string;
}

/**
 * Records commits made on change-set branches: the outbox row and the
 * audit events, in the caller's transaction. A commit is recorded once:
 * recording one that is recorded already writes nothing.
 *
 * `catchUp` records the commits a branch has that were never recorded,
 * because the process stopped (or the database failed) between the Git
 * commit and the transaction recording it. It records only a commit whose
 * first parent and tree are those of a commit intent (`CommitIntents`,
 * written before the Git write, #154), as that intent's actor and with
 * its subjects; nothing a commit says about itself (its trailers, its
 * author), which anyone who can push to the branch can write.
 */
@Injectable()
export class CommitRecorder {
  constructor(
    private readonly commits: ChangeSetCommits,
    private readonly branches: ChangeSetBranches,
    private readonly auditLog: AuditLog,
    private readonly workingCopies: WorkingCopyStore,
    private readonly intents: CommitIntents,
  ) {}

  /**
   * Records `commit` inside `tx`: its outbox row, a `change-set.commit`
   * audit event and one `<module|manual>.write` or `.delete` event per
   * subject. False (nothing written) when it is recorded already.
   */
  async record(
    tx: Transaction,
    commit: ChangeSetCommit,
    extra: { comment?: string; recovered?: boolean } = {},
  ): Promise<boolean> {
    if (!(await this.commits.record(tx, commit))) return false;
    // Only kind and ID are stored (`AuditLog.record`); no roles needed.
    const actor = { ...commit.actor, roles: [] };
    await this.auditLog.record(tx, actor, {
      action: 'change-set.commit',
      subject: { type: 'change-set', id: commit.changeSetId },
      ...(extra.comment !== undefined && { comment: extra.comment }),
      data: {
        commit: commit.commit,
        parent: commit.parent,
        branch: commit.branch,
        written: commit.written.length,
        deleted: commit.deleted.length,
        ...(extra.recovered && { recovered: true }),
      },
    });
    const each = [
      ...commit.written.map((s) => ({ subject: s, verb: 'write' as const })),
      ...commit.deleted.map((s) => ({ subject: s, verb: 'delete' as const })),
    ];
    for (const { subject, verb } of each) {
      await this.auditLog.record(tx, actor, {
        action: `${subject.type}.${verb}`,
        subject: subjectKey(subject),
        data: {
          changeSetId: commit.changeSetId,
          commit: commit.commit,
          ...(extra.recovered && { recovered: true }),
        },
      });
    }
    return true;
  }

  /**
   * Whether `head`, the change set's branch head, may need catching up:
   * neither its base commit nor recorded, and the change set has a commit
   * intent. Asked outside any transaction, before taking the row lock.
   */
  async mayCatchUp(changeSet: ChangeSet, head: string): Promise<boolean> {
    if (head === changeSet.baseCommit) return false;
    if ((await this.commits.recorded([head])).has(head)) return false;
    return (await this.intents.pendingFor([changeSet.id])).has(changeSet.id);
  }

  /**
   * Records, inside `tx`, the commits of the change set's branch up to
   * `head` that were never recorded, oldest first. Walks back from `head`
   * (at most `MAX_RECOVERED_COMMITS`) and stops at the change set's base
   * commit and at a recorded commit. A commit that matches no intent of
   * the change set (a single parent, the intent's parent, and the
   * intent's tree) was made outside a save point: it is never recorded
   * (the newest one is `unmatched`), and the walk goes on past it, so a
   * pushed commit cannot keep a save point under it out of the record. Each recovered commit is recorded as its
   * intent's actor, with its subjects and message, and consumes the
   * intent; the working copies it consumed are dropped when still the
   * very copies committed (version and `createdAt`), and a later one moves its base on (see below).
   * Hold the change set's row lock in `tx`, so no commit of it is being
   * recorded meanwhile.
   */
  async catchUp(
    tx: Transaction,
    changeSet: ChangeSet,
    head: string,
  ): Promise<CatchUp> {
    const none: CatchUp = { recovered: [], dropped: 0 };
    if (head === changeSet.baseCommit) return none;
    if ((await this.commits.recorded([head], tx)).has(head)) return none;
    const intents = await this.intents.of(tx, changeSet.id);
    if (intents.length === 0) return { ...none, unmatched: head };
    const history = await this.branches.history(
      changeSet.branch,
      head,
      MAX_RECOVERED_COMMITS,
    );
    const recorded = await this.commits.recorded(
      history.map((h) => h.commit),
      tx,
    );
    const missing: {
      commit: string;
      parent: string;
      intent: CommitIntent;
    }[] = [];
    const used = new Set<number>();
    let unmatched: string | undefined;
    for (const entry of history) {
      if (entry.commit === changeSet.baseCommit) break;
      if (recorded.has(entry.commit)) break;
      const intent =
        entry.parents === 1 && entry.parent !== undefined
          ? intents.find(
              (i) =>
                !used.has(i.id) &&
                i.parent === entry.parent &&
                i.tree === entry.tree,
            )
          : undefined;
      if (!intent || entry.parent === undefined) {
        // Never recorded, but no reason to leave a save point under it
        // unrecorded: a match proves the API made exactly that change.
        unmatched ??= entry.commit;
        continue;
      }
      used.add(intent.id);
      missing.push({ commit: entry.commit, parent: entry.parent, intent });
    }
    missing.reverse();
    const paths = new Map<string, Promise<Set<string> | undefined>>();
    let dropped = 0;
    for (const { commit, parent, intent } of missing) {
      await this.record(
        tx,
        {
          changeSetId: changeSet.id,
          branch: changeSet.branch,
          commit,
          parent,
          actor: intent.actor,
          written: intent.written,
          deleted: intent.deleted,
        },
        {
          recovered: true,
          ...(intent.message !== undefined && { comment: intent.message }),
        },
      );
      await this.intents.remove(tx, intent.id);
      // What the commit consumed, still at the version committed: gone, as
      // the save point would have dropped it.
      const kept: LockSubject[] = [];
      for (const { subject, version, createdAt } of intent.consumes) {
        if (
          await this.workingCopies.removeAt(
            tx,
            changeSet.id,
            subject,
            version,
            createdAt,
          )
        ) {
          dropped++;
        } else {
          kept.push(subject);
        }
      }
      // A working copy saved since still names an older base: the commit's
      // parent, or any commit since which the file did not change up to
      // that parent (a save keeps its stored base, and a commit takes any
      // base the file is unchanged since). It was typed on from what the
      // commit wrote, so it moves on to it, one version further, rather
      // than look stale for good.
      const written = new Set(intent.written.map(keyOf));
      for (const subject of kept.filter((s) => written.has(keyOf(s)))) {
        const copy = await this.workingCopies.get(tx, changeSet.id, subject);
        if (!copy || copy.baseCommit === commit) continue;
        if (
          copy.baseCommit !== parent &&
          !(await this.unchangedBetween(
            copy.baseCommit,
            parent,
            subject,
            paths,
          ))
        ) {
          continue;
        }
        await this.workingCopies.rebase(
          tx,
          changeSet.id,
          subject,
          copy.baseCommit,
          commit,
        );
      }
    }
    return {
      recovered: missing.map((m) => m.commit),
      dropped,
      ...(unmatched !== undefined && { unmatched }),
    };
  }

  /**
   * Whether `subject`'s file is the same at `since` as at `until`: no
   * change to its path between them. False when `since` is not a commit
   * of the repository. `paths` memoizes the changed paths per pair.
   */
  private async unchangedBetween(
    since: string,
    until: string,
    subject: LockSubject,
    paths: Map<string, Promise<Set<string> | undefined>>,
  ): Promise<boolean> {
    const key = `${since}..${until}`;
    let changed = paths.get(key);
    if (!changed) {
      changed = this.branches.changedPaths(since, until).then(
        (list) => new Set(list.map((c) => c.path)),
        () => undefined,
      );
      paths.set(key, changed);
    }
    const set = await changed;
    return set !== undefined && !changedIn(set, subject);
  }

  /**
   * Drops, inside `tx`, the change set's working copies whose canonical
   * print is the file on the branch at `head` byte for byte: committed,
   * nothing of them is lost. The others stay. Returns how many it dropped.
   */
  async dropCommitted(
    tx: Transaction,
    changeSetId: string,
    head: ReadableContent,
  ): Promise<number> {
    let dropped = 0;
    for (const { subject } of await this.workingCopies.sizesOf(
      tx,
      changeSetId,
    )) {
      const copy = await this.workingCopies.get(tx, changeSetId, subject);
      if (!copy) continue;
      const printed = printWorkingCopy(subject, copy.content);
      if (!('text' in printed)) continue;
      const committed = await head.sourceForCheck(subjectPath(subject));
      if (!sameBytes(new TextEncoder().encode(printed.text), committed)) {
        continue;
      }
      if (
        await this.workingCopies.removeAt(
          tx,
          changeSetId,
          subject,
          copy.version,
        )
      ) {
        dropped++;
      }
    }
    return dropped;
  }
}

/**
 * The working copy as its file, printed canonically by its subject's kind
 * (`SUBJECT_KINDS`: AsciiDoc for a module, YAML for a manifest, the
 * configuration or a term). The text must read back to itself
 * (`print(parse(text))` is `text`); when it does not, or the content is
 * no file yet (a manifest with no entries), the reason comes back instead.
 */
export function printWorkingCopy(
  subject: LockSubject,
  content: WorkingCopyContent,
): Printed {
  return kindOf(subject).print(subject, content);
}

/** `<type>/<id>`, one key per subject. */
function keyOf(subject: LockSubject): string {
  const { type, id } = subjectKey(subject);
  return `${type}/${id}`;
}
