import { createHash } from 'node:crypto';
import { ConflictError } from '../../src/base/core/errors.js';
import type { ChangeSetAuthor } from '../../src/change-sets/core/change-set.js';
import {
  type BranchCommit,
  type BranchHead,
  type BranchMerge,
  type BranchRefresh,
  ChangeSetBranches,
  type MergeConflictPath,
  type RefreshPreview,
} from '../../src/change-sets/core/change-set-branches.js';
import type { BranchChange } from '../../src/change-sets/core/commit.js';
import { fakeCommitId } from './fake-content.js';

/** A commit the fake made. */
export interface FakeCommit {
  readonly branch: string;
  readonly parent: string;
  readonly changes: readonly BranchChange[];
  readonly message: string;
  readonly author: ChangeSetAuthor;
  readonly changeSetId: string;
  /** Its tree: the same for the same changes on the same parent (`fakeTree`). */
  readonly tree: string;
  /** A merge commit's second parent (the merged head). */
  readonly mergeOf?: string;
  /** A merge commit's approvers. */
  readonly approvedBy?: readonly ChangeSetAuthor[];
  /** Who wrote what it carries over from another change set (#597). */
  readonly carried?: readonly ChangeSetAuthor[];
  /** Pushed from outside the API (`push`): it names nobody, whatever it claims. */
  readonly pushed?: true;
}

/** The request of a `merge`, as the fake saw it. */
export type FakeMergeRequest = Parameters<ChangeSetBranches['merge']>[0];

/**
 * Change-set branches in memory: name → commit. `ownCommits` lists the
 * branches whose head no ref outside the change sets holds. Commits are
 * compare-and-swap on the head, as in Git; `onCommit` lets a test make the
 * new commit readable (a new snapshot of the content).
 */
export class FakeChangeSetBranches extends ChangeSetBranches {
  readonly heads = new Map<string, string>();
  readonly ownCommits = new Set<string>();
  /** Every commit made, by ID. */
  readonly commits = new Map<string, FakeCommit>();
  /** The changes of each tree `prepare` made. */
  private readonly prepared = new Map<string, readonly BranchChange[]>();
  /** What `defaultBase` answers. */
  base: string | undefined = 'main';
  /** Called right before a commit compares the head: a test moves the branch there. */
  beforeCommit?: (name: string) => void;
  /** Called after a commit (a merge commit too) landed. */
  onCommit?: (commit: string, made: FakeCommit) => void;
  /** Called right before a merge compares the target's head: a test moves it there. */
  beforeMerge?: (request: FakeMergeRequest) => void;

  async create(name: string, commit: string): Promise<void> {
    if (this.heads.has(name)) {
      throw new ConflictError('branch-exists', `${name} exists`);
    }
    this.heads.set(name, commit);
  }

  async deleteIfAt(name: string, expected: string): Promise<boolean> {
    if (this.heads.get(name) !== expected) return false;
    this.heads.delete(name);
    return true;
  }

  async hasOwnCommits(name: string): Promise<boolean> {
    return this.ownCommits.has(name);
  }

  async defaultBase(): Promise<string | undefined> {
    return this.base;
  }

  async list(): Promise<BranchHead[]> {
    return [...this.heads].map(([name, commit]) => ({ name, commit }));
  }

  async prepare(
    _name: string,
    request: {
      readonly parent: string;
      readonly changes: readonly BranchChange[];
    },
  ): Promise<{ tree: string }> {
    const tree = fakeTree(this.treeOf(request.parent), request.changes);
    this.prepared.set(tree, request.changes);
    return { tree };
  }

  async commit(
    name: string,
    request: Omit<FakeCommit, 'branch' | 'changes' | 'pushed'>,
  ): Promise<{ commit: string } | { moved: string | undefined }> {
    this.beforeCommit?.(name);
    const at = this.heads.get(name);
    if (at !== request.parent) return { moved: at };
    const changes = this.prepared.get(request.tree);
    if (!changes) throw new Error(`fake: no prepared tree ${request.tree}`);
    const commit = fakeCommitId();
    const made = { ...request, changes, branch: name };
    this.commits.set(commit, made);
    this.heads.set(name, commit);
    this.onCommit?.(commit, made);
    return { commit };
  }

  /**
   * A commit pushed to `name` from outside the API (on top of its head),
   * with whatever it claims: its author and change set are only what a
   * pusher wrote. Returns it.
   */
  push(
    name: string,
    request: Omit<FakeCommit, 'branch' | 'parent' | 'tree'> & {
      readonly mergeOf?: string;
    },
  ): string {
    const parent = this.heads.get(name) as string;
    const commit = fakeCommitId();
    const made: FakeCommit = {
      ...request,
      branch: name,
      parent,
      tree: fakeTree(this.treeOf(parent), request.changes),
      pushed: true,
    };
    this.commits.set(commit, made);
    this.heads.set(name, commit);
    this.onCommit?.(commit, made);
    return commit;
  }

  async history(
    _name: string,
    head: string,
    max: number,
    excluding?: string,
  ): Promise<BranchCommit[]> {
    const found: BranchCommit[] = [];
    const left = excluding === undefined ? undefined : this.ancestry(excluding);
    let at: string | undefined = head;
    while (at !== undefined && found.length < max && !left?.has(at)) {
      const made = this.commits.get(at);
      found.push(
        made
          ? {
              commit: at,
              parent: made.parent,
              parents: made.mergeOf ? 2 : 1,
              tree: made.tree,
            }
          : { commit: at, parents: 0, tree: this.treeOf(at) },
      );
      at = made?.parent;
    }
    return found;
  }

  /**
   * Who wrote the first-parent line from `head` past `excluding`'s history, as the Git adapter
   * reads it: the author and the carried writers of each commit the fake made through `commit`;
   * a merge (an update from the base, a merge commit) and a pushed commit name nobody.
   */
  async writers(
    _name: string,
    head: string,
    excluding: string,
  ): Promise<ChangeSetAuthor[]> {
    const left = this.ancestry(excluding);
    const found = new Map<string, ChangeSetAuthor>();
    const add = (a: ChangeSetAuthor) =>
      found.set(`${a.kind}/${a.id}`, { kind: a.kind, id: a.id });
    let at: string | undefined = head;
    while (at !== undefined && !left.has(at)) {
      const made = this.commits.get(at);
      if (!made) break;
      if (!made.pushed && !made.mergeOf) {
        add(made.author);
        for (const c of made.carried ?? []) add(c);
      }
      at = made.parent;
    }
    return [...found.values()];
  }

  /** A commit's tree: its own for one the fake made, else one made up from its ID. */
  treeOf(commit: string): string {
    return this.commits.get(commit)?.tree ?? fakeTree(commit, []);
  }

  /**
   * The paths the fake's commits from `from` (exclusive) to `to` changed,
   * the latest change of each; throws when `from` is not an ancestor of
   * `to` among the fake's commits (as git does for an unknown commit).
   */
  async changedPaths(from: string, to: string) {
    const changed = new Map<string, boolean>();
    if (!this.onFirstParents(from, to) && this.ancestry(to).has(from)) {
      // Across a merge (an update from the base): the files as they are.
      const [then, now] = [this.files(from), this.files(to)];
      for (const path of new Set([...then.keys(), ...now.keys()])) {
        if (then.get(path) !== now.get(path)) {
          changed.set(path, now.get(path) === null);
        }
      }
      return [...changed].map(([path, deleted]) => ({ path, deleted }));
    }
    let at = to;
    while (at !== from) {
      const made = this.commits.get(at);
      if (!made) throw new Error(`fake: ${from} is not an ancestor of ${to}`);
      for (const c of made.changes) {
        if (!changed.has(c.path)) changed.set(c.path, 'delete' in c);
      }
      at = made.parent;
    }
    return [...changed].map(([path, deleted]) => ({ path, deleted }));
  }

  /**
   * Merges as git would, over the fake's commits: compare-and-swap on the
   * target (any name in `heads`, `main` say), up to date when `head` is in
   * its history, a fast-forward when allowed and possible, and otherwise a
   * merge commit, unless a path changed on both sides since they diverged
   * to different results: then `conflicts` (`contents`, or
   * `modify/delete` when one side deleted it) and nothing changes. Commits
   * the fake did not make count as the common history.
   */
  /** The merge `merge` would make, at `paths` changed on either side only (the fake knows no other bytes). */
  async mergedFiles(expected: string, head: string, paths: readonly string[]) {
    const ours = this.ancestry(expected);
    const theirs = this.ancestry(head);
    const ourChanges = this.changesOnly(expected, theirs);
    const theirChanges = this.changesOnly(head, ours);
    const files = new Map<string, Uint8Array | null>();
    for (const path of paths) {
      const mine = ourChanges.get(path);
      const other = theirChanges.get(path);
      if (mine !== undefined && other !== undefined && mine !== other) {
        return 'conflicts' as const;
      }
      const content = other !== undefined ? other : mine;
      if (content === undefined) {
        throw new Error(`fake: ${path} is changed on neither side`);
      }
      files.set(
        path,
        content === null ? null : new TextEncoder().encode(content),
      );
    }
    return files;
  }

  /**
   * Applies the fake's changes from `from` to `to` onto `onto`: a path
   * changed there and since `from` on `onto`'s side to something else
   * conflicts (`contents`, `modify/delete`); the others take `to`'s
   * content where `onto` differs (the fake knows no other bytes). Commits
   * the fake did not make count as the common history.
   */
  async applyChange(request: {
    readonly from: string;
    readonly to: string;
    readonly onto: string;
    readonly paths: readonly string[];
  }) {
    const theirs = this.changesOnly(request.to, this.ancestry(request.from));
    const ours = this.changesOnly(request.onto, this.ancestry(request.from));
    const files = new Map<string, Uint8Array | null>();
    const conflicts: MergeConflictPath[] = [];
    for (const path of request.paths) {
      const change = theirs.get(path);
      if (change === undefined) continue;
      const mine = ours.get(path);
      if (mine === change) continue;
      if (mine !== undefined) {
        conflicts.push({
          path,
          kinds: [
            mine === null || change === null ? 'modify/delete' : 'contents',
          ],
        });
        continue;
      }
      files.set(
        path,
        change === null ? null : new TextEncoder().encode(change),
      );
    }
    return { files, conflicts };
  }

  async merge(request: FakeMergeRequest): Promise<BranchMerge> {
    if (request.into.toLowerCase().startsWith('change-sets/')) {
      throw new Error(`"${request.into}" is a change-set branch.`);
    }
    this.beforeMerge?.(request);
    const at = this.heads.get(request.into);
    if (at !== request.expected) return { kind: 'moved', head: at };
    const ours = this.ancestry(request.expected);
    const theirs = this.ancestry(request.head);
    if (ours.has(request.head)) {
      return { kind: 'up-to-date', commit: request.expected };
    }
    const fastForward = request.approvedBy?.length
      ? 'never'
      : (request.fastForward ?? 'allow');
    if (fastForward === 'allow' && theirs.has(at)) {
      this.heads.set(request.into, request.head);
      return { kind: 'merged', commit: request.head, fastForward: true };
    }
    const ourChanges = this.changesOnly(request.expected, theirs);
    const theirChanges = this.changesOnly(request.head, ours);
    const conflicts: MergeConflictPath[] = [];
    for (const [path, mine] of ourChanges) {
      const other = theirChanges.get(path);
      if (other === undefined || other === mine) continue;
      conflicts.push({
        path,
        kinds: [mine === null || other === null ? 'modify/delete' : 'contents'],
      });
    }
    if (conflicts.length > 0) {
      conflicts.sort((a, b) => a.path.localeCompare(b.path));
      return { kind: 'conflicts', conflicts };
    }
    const commit = fakeCommitId();
    const merged: BranchChange[] = [...theirChanges]
      .filter(([path, content]) => ourChanges.get(path) !== content)
      .map(([path, content]) =>
        content === null ? { path, delete: true as const } : { path, content },
      );
    const made: FakeCommit = {
      branch: request.into,
      parent: request.expected,
      mergeOf: request.head,
      tree: fakeTree(
        `${this.treeOf(request.expected)}+${request.head}`,
        merged,
      ),
      changes: merged,
      message: request.message,
      author: request.actor,
      changeSetId: request.changeSetId,
      ...(request.approvedBy && { approvedBy: request.approvedBy }),
    };
    this.commits.set(commit, made);
    this.heads.set(request.into, commit);
    this.onCommit?.(commit, made);
    return { kind: 'merged', commit, fastForward: false };
  }

  /** Called right before a refresh compares the branch's head: a test moves it there. */
  beforeRefresh?: (name: string) => void;

  /** What `refresh` would do, as `merge` judges it, with `keep` kept as the branch's. */
  async previewRefresh(request: {
    readonly expected: string;
    readonly base: string;
    readonly keep: readonly string[];
  }): Promise<RefreshPreview> {
    const planned = this.planRefresh(request);
    if (planned.kind !== 'merge') return planned;
    return {
      kind: 'clean',
      fastForward: false,
      changed: planned.changes.map((c) => ({
        path: c.path,
        deleted: 'delete' in c,
      })),
    };
  }

  async refresh(
    name: string,
    request: Parameters<ChangeSetBranches['refresh']>[1],
  ): Promise<BranchRefresh> {
    if (!name.startsWith('change-sets/')) {
      throw new Error(`"${name}" is not a change-set branch.`);
    }
    this.beforeRefresh?.(name);
    const at = this.heads.get(name);
    if (at !== request.expected) return { kind: 'moved', head: at };
    const planned = this.planRefresh(request);
    switch (planned.kind) {
      case 'up-to-date':
      case 'conflicts':
        return planned;
      case 'clean':
        this.heads.set(name, request.base);
        return { kind: 'merged', commit: request.base, fastForward: true };
    }
    const commit = fakeCommitId();
    const made: FakeCommit = {
      branch: name,
      parent: request.expected,
      mergeOf: request.base,
      tree: fakeTree(
        `${this.treeOf(request.expected)}+${request.base}`,
        planned.changes,
      ),
      changes: planned.changes,
      message: request.message,
      author: request.actor,
      changeSetId: request.changeSetId,
    };
    this.commits.set(commit, made);
    this.heads.set(name, commit);
    this.refreshes.push({ name, ...request });
    this.onCommit?.(commit, made);
    return { kind: 'merged', commit, fastForward: false };
  }

  /** Every refresh that made a merge commit, as requested. */
  readonly refreshes: (Parameters<ChangeSetBranches['refresh']>[1] & {
    name: string;
  })[] = [];

  async behind(head: string, base: string): Promise<number> {
    const ours = this.ancestry(head);
    return [...this.ancestry(base)].filter(
      (c) => !ours.has(c) && this.commits.has(c),
    ).length;
  }

  /**
   * What updating `expected` from `base` takes: nothing (`up-to-date`), a
   * fast-forward (`clean`, with what it changes), the merge's changes on
   * the branch (`merge`), or the conflicts `keep` leaves.
   */
  private planRefresh(request: {
    readonly expected: string;
    readonly base: string;
    readonly keep: readonly string[];
  }):
    | { kind: 'up-to-date' }
    | {
        kind: 'clean';
        fastForward: true;
        changed: { path: string; deleted: boolean }[];
      }
    | { kind: 'merge'; changes: BranchChange[] }
    | { kind: 'conflicts'; conflicts: MergeConflictPath[] } {
    const ours = this.ancestry(request.expected);
    const theirs = this.ancestry(request.base);
    if (ours.has(request.base)) return { kind: 'up-to-date' };
    const ourChanges = this.changesOnly(request.expected, theirs);
    const theirChanges = this.changesOnly(request.base, ours);
    if (theirs.has(request.expected)) {
      return {
        kind: 'clean',
        fastForward: true,
        changed: [...theirChanges].map(([path, content]) => ({
          path,
          deleted: content === null,
        })),
      };
    }
    const keep = new Set(request.keep);
    const conflicts: MergeConflictPath[] = [];
    const kept = new Set<string>();
    for (const [path, mine] of ourChanges) {
      const other = theirChanges.get(path);
      if (other === undefined || other === mine) continue;
      if (keep.has(path)) {
        kept.add(path);
        continue;
      }
      conflicts.push({
        path,
        kinds: [mine === null || other === null ? 'modify/delete' : 'contents'],
      });
    }
    if (conflicts.length > 0) {
      conflicts.sort((a, b) => a.path.localeCompare(b.path));
      return { kind: 'conflicts', conflicts };
    }
    const changes: BranchChange[] = [...theirChanges]
      .filter(
        ([path, content]) =>
          !kept.has(path) && ourChanges.get(path) !== content,
      )
      .map(([path, content]) =>
        content === null ? { path, delete: true as const } : { path, content },
      );
    return { kind: 'merge', changes };
  }

  /** Whether `from` is on `to`'s first-parent line (or `to` itself). */
  private onFirstParents(from: string, to: string): boolean {
    let at: string | undefined = to;
    while (at !== undefined) {
      if (at === from) return true;
      at = this.commits.get(at)?.parent;
    }
    return false;
  }

  /**
   * The files at `commit` as far as the fake knows them: the changes along
   * its first parents (a merge commit holds what it took in), oldest
   * first; `null` for one deleted.
   */
  private files(commit: string): Map<string, string | null> {
    const line: FakeCommit[] = [];
    let at: string | undefined = commit;
    while (at !== undefined) {
      const made = this.commits.get(at);
      if (!made) break;
      line.push(made);
      at = made.parent;
    }
    const files = new Map<string, string | null>();
    for (const made of line.reverse()) {
      for (const c of made.changes) {
        files.set(c.path, 'delete' in c ? null : c.content);
      }
    }
    return files;
  }

  async head(name: string): Promise<string | undefined> {
    return this.heads.get(name);
  }

  async contains(into: string, commit: string): Promise<boolean> {
    const tip = this.heads.get(into);
    return tip !== undefined && this.ancestry(tip).has(commit);
  }

  async mergedInto(into: string, head: string, changeSetId: string) {
    const tip = this.heads.get(into);
    if (tip === undefined || !this.ancestry(tip).has(head)) return undefined;
    const found = [...this.commits].find(
      ([, made]) =>
        made.branch === into &&
        made.mergeOf === head &&
        made.changeSetId === changeSetId,
    );
    return found
      ? { commit: found[0], mergedBy: found[1].author }
      : { commit: undefined, mergedBy: undefined };
  }

  /** A commit and every commit the fake made in its history (both parents). */
  private ancestry(commit: string): Set<string> {
    const seen = new Set<string>();
    const todo = [commit];
    while (todo.length > 0) {
      const at = todo.pop() as string;
      if (seen.has(at)) continue;
      seen.add(at);
      const made = this.commits.get(at);
      if (made) todo.push(made.parent, ...(made.mergeOf ? [made.mergeOf] : []));
    }
    return seen;
  }

  /**
   * The net change per path (content, or null for a delete) since `other`
   * (a history): along `tip`'s first parents, newest first, the latest
   * change of a path wins. A merge commit counts with the changes it took in.
   */
  private changesOnly(
    tip: string,
    other: Set<string>,
  ): Map<string, string | null> {
    const changes = new Map<string, string | null>();
    let at: string | undefined = tip;
    while (at !== undefined && !other.has(at)) {
      const made = this.commits.get(at);
      if (!made) break;
      for (const change of made.changes) {
        if (!changes.has(change.path)) {
          changes.set(change.path, 'delete' in change ? null : change.content);
        }
      }
      at = made.parent;
    }
    return changes;
  }
}

/**
 * A tree ID for `changes` applied to the tree `base`: the same changes on
 * the same base give the same tree, as in Git.
 */
export function fakeTree(
  base: string,
  changes: readonly BranchChange[],
): string {
  const sorted = [...changes].sort((a, b) => a.path.localeCompare(b.path));
  return createHash('sha1')
    .update(JSON.stringify([base, sorted]))
    .digest('hex');
}
