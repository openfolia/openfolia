import type { Actor } from '../../src/access/core/actor.js';
import { OpenSnapshotAction } from '../../src/content/core/actions/open-snapshot.action.js';
import {
  ContentRepository,
  type ContentSnapshot,
  type RefInfo,
} from '../../src/content/core/content.repository.js';
import {
  BRANCH_PREFIX,
  type ChangeSet,
  changeSetBranch,
  newChangeSetId,
} from '../../src/change-sets/core/change-set.js';
import { ChangeSetAuthoredBranches } from '../../src/change-sets/core/change-set-authored-branches.js';
import type { BranchHead } from '../../src/change-sets/core/change-set-branches.js';
import { FakeChangeSetBranches } from './fake-change-set-branches.js';
import { FakeChangeSetStore } from './fake-change-set-store.js';
import {
  fakeChangedPaths,
  type FakeContent,
  FakeSnapshot,
} from './fake-content.js';

/**
 * A repository of several commits, each a `FakeSnapshot`: branches (`main`
 * and change sets' branches) and tags (`tags`, newest first) point to
 * them; any other ref is read as a commit ID. With the change sets' store,
 * their branches (`changedPaths` compares two commits' files, as git
 * does) and `OpenSnapshotAction` over all of it.
 */
export class FakeHistory extends ContentRepository {
  readonly commits = new Map<string, FakeSnapshot>();
  readonly heads = new Map<string, string>();
  /** Newest first. */
  readonly tags: RefInfo[] = [];
  readonly store = new FakeChangeSetStore();
  readonly branches: FakeChangeSetBranches;
  readonly openSnapshot: OpenSnapshotAction;

  constructor(main: FakeContent) {
    super();
    this.heads.set('main', this.commit(main).commit);
    this.branches = new HistoryBranches(this);
    this.openSnapshot = new OpenSnapshotAction(
      this,
      new ChangeSetAuthoredBranches(this.store),
    );
  }

  /** A new commit holding `content`. */
  commit(content: FakeContent): FakeSnapshot {
    const snapshot = new FakeSnapshot(content);
    this.commits.set(snapshot.commit, snapshot);
    return snapshot;
  }

  /**
   * A new commit on `main` holding `content`, with `main`'s commit before
   * it as its first parent (its `line`, for `moduleHistory`), described by
   * `info`; `main` moves to it.
   */
  onMain(
    content: FakeContent,
    info: FakeContent['commitInfo'] = {},
  ): FakeSnapshot {
    const head = this.commits.get(this.heads.get('main') as string);
    const line = head ? [head, ...(head.content.line ?? [])] : [];
    const snapshot = this.commit({ ...content, line, commitInfo: info });
    this.heads.set('main', snapshot.commit);
    return snapshot;
  }

  /** Tags the commit `commit` as the newest release. */
  tag(name: string, commit: string): void {
    this.tags.unshift({ name, commit });
  }

  /** A change set by `author` from `main`, its branch at a commit holding `content`. */
  changeSet(
    author: Actor,
    content: FakeContent,
    over: Partial<ChangeSet> = {},
  ): ChangeSet {
    const id = newChangeSetId();
    const now = new Date();
    const changeSet: ChangeSet = {
      id,
      title: 'A change',
      description: null,
      author: { kind: author.kind, id: author.id },
      baseRef: 'main',
      baseCommit: this.heads.get('main') as string,
      baseReleased: true,
      branch: changeSetBranch(id),
      state: 'draft',
      createdAt: now,
      updatedAt: now,
      ...over,
    };
    this.heads.set(changeSet.branch, this.commit(content).commit);
    this.store.changeSets.push(changeSet);
    return changeSet;
  }

  at(ref: string): Promise<ContentSnapshot | undefined> {
    const tag = ref.startsWith('refs/tags/')
      ? ref.slice('refs/tags/'.length)
      : undefined;
    const commit =
      tag !== undefined
        ? this.tags.find((t) => t.name === tag)?.commit
        : (this.heads.get(ref) ??
          this.tags.find((t) => t.name === ref)?.commit);
    return Promise.resolve(this.commits.get(commit ?? ref));
  }

  refs() {
    return Promise.resolve({
      branches: [...this.heads].map(([name, commit]) => ({ name, commit })),
      tags: [...this.tags],
    });
  }

  override releases() {
    return Promise.resolve([...this.tags]);
  }

  /** Every file that differs between two commits (`fakeChangedPaths`), for the module index. */
  override differingPaths(from: string, to: string) {
    return fakeChangedPaths(from, to);
  }

  /**
   * The files that differ between two commits: modules, manifests, the configuration, and
   * every other file a snapshot holds (`FakeSnapshot.paths`: terms, page designs, their
   * templates, symbols).
   */
  async changedPaths(from: string, to: string) {
    const [a, b] = [this.commits.get(from), this.commits.get(to)];
    if (!a || !b) throw new Error(`fake: no commit ${a ? to : from}`);
    const paths = new Set<string>(['openfolia.yaml']);
    for (const snapshot of [a, b]) {
      for (const m of await snapshot.modules()) {
        paths.add(`modules/${m.lang}/${m.id}.adoc`);
      }
      for (const id of await snapshot.manifests()) {
        paths.add(`manuals/${id}.yaml`);
      }
      for (const path of snapshot.paths()) paths.add(path);
    }
    const changed: { path: string; deleted: boolean }[] = [];
    for (const path of [...paths].sort()) {
      const [x, y] = await Promise.all([a.file(path), b.file(path)]);
      if (
        x === undefined ||
        y === undefined ||
        Buffer.compare(Buffer.from(x), Buffer.from(y)) !== 0
      ) {
        if (x === undefined && y === undefined) continue;
        changed.push({ path, deleted: y === undefined });
      }
    }
    return changed;
  }
}

/** The history's branches, as `ChangeSetBranches` reads them. */
class HistoryBranches extends FakeChangeSetBranches {
  constructor(private readonly repo: FakeHistory) {
    super();
  }

  override async head(name: string) {
    return this.repo.heads.get(name);
  }

  override async list(): Promise<BranchHead[]> {
    return [...this.repo.heads]
      .filter(([name]) => name.startsWith(BRANCH_PREFIX))
      .map(([name, commit]) => ({ name, commit }));
  }

  override async changedPaths(from: string, to: string) {
    return this.repo.changedPaths(from, to);
  }
}
