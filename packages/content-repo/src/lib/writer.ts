import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { deflate } from 'node:zlib';
import {
  type BatchObject,
  CatFileBatch,
  gitEnv,
  GitError,
  isSafePath,
  isSafeRef,
  readsAsCommitId,
  refsMoved,
} from './git.js';
import { DesignTemplateId, isTemplateFilePath } from '@openfolia/content-model';
import { type MergeConflict, parseMergeTree } from './merge-tree.js';
import { LAYOUT } from './snapshot.js';

export type { MergeConflict } from './merge-tree.js';

/** Who a commit is by: becomes its author and, unless given separately, its committer. */
export interface Actor {
  name: string;
  email: string;
}

/** A trailer at the end of a commit message (`Key: value`); a key may repeat. */
export interface Trailer {
  key: string;
  value: string;
}

/** A file to write (created or replaced) or delete, at a repository path. */
export type FileChange =
  | { path: string; content: Uint8Array | string }
  | { path: string; delete: true };

export interface CommitRequest {
  /** The branch to move, without `refs/heads/`. */
  branch: string;
  /**
   * The commit the branch must point to now (what the caller read and edited
   * on). The branch is moved only if it still points there, so a write never
   * replaces a commit the caller has not seen. `null` makes the first commit
   * of a branch that must not exist yet.
   */
  parent: string | null;
  changes: readonly FileChange[];
  message: string;
  author: Actor;
  /** Defaults to the author. */
  committer?: Actor;
  trailers?: readonly Trailer[];
  /** Author and committer date; defaults to now. */
  date?: Date;
}

export interface CommitResult {
  commit: string;
  tree: string;
  /** The identities as recorded (see `normalizeActor`). */
  author: Actor;
  committer: Actor;
}

export interface MergeRequest {
  /** The branch to move (the merge target), without `refs/heads/`. */
  branch: string;
  /**
   * The commit the branch must point to now. The branch is moved only if
   * it still points there (compare-and-swap), so a merge never replaces a
   * commit the caller has not seen.
   */
  expected: string;
  /** The exact commit to merge in (say a change set's head), never a name. */
  source: string;
  /** The merge commit's message (validated even when none is made). */
  message: string;
  author: Actor;
  /** Defaults to the author. */
  committer?: Actor;
  trailers?: readonly Trailer[];
  /** Author and committer date; defaults to now. */
  date?: Date;
  /**
   * `allow` (default): when `expected` is an ancestor of `source`, the
   * branch just moves to `source` and no merge commit (so no message and
   * no trailers) is recorded. `never`: always a merge commit with both
   * parents, so the message and trailers (an approval) are recorded.
   */
  fastForward?: 'allow' | 'never';
  /**
   * Paths whose conflict keeps the branch's own file (`expected`'s; no
   * file when it has none): a person resolved the conflict by saving the
   * file there. Only a plain file conflict is kept (`KEEPABLE_CONFLICTS`,
   * at a path `commit` may write, the file a regular one); any other
   * conflict, and one at a path not listed, still fails the merge. A
   * listed path that does not conflict merges as usual.
   */
  keep?: readonly string[];
}

/** The conflict kinds `MergeRequest.keep` can resolve: one file, two versions. */
export const KEEPABLE_CONFLICTS: ReadonlySet<string> = new Set([
  'contents',
  'add/add',
  'modify/delete',
]);

/** What `GitWriter.previewMerge` found: what `merge` would do, written nowhere. */
export type MergePreview =
  /** `source` is in the branch's history already. */
  | { kind: 'up-to-date' }
  /**
   * `merge` would fast-forward (when allowed) or make a merge commit;
   * `changed` lists the files the result holds differently from
   * `expected` (a deletion: `deleted`).
   */
  | {
      kind: 'fast-forward' | 'merge';
      changed: { path: string; deleted: boolean }[];
    }
  /** The conflicts `merge` would refuse with (those `keep` does not resolve). */
  | { kind: 'conflicts'; conflicts: MergeConflict[] };

export type MergeResult =
  /** `source` was already in the branch's history: nothing changed. */
  | { kind: 'up-to-date'; commit: string }
  /** The branch moved to `source`. */
  | { kind: 'fast-forward'; commit: string }
  /** A merge commit with parents `expected` and `source`. */
  | {
      kind: 'merge';
      commit: string;
      tree: string;
      /** The identities as recorded (see `normalizeActor`). */
      author: Actor;
      committer: Actor;
    };

export interface TagRequest {
  /** The tag's name, without `refs/tags/` (`release/x/1.2`). */
  name: string;
  /** The exact commit to tag, never a name. */
  commit: string;
  message: string;
  tagger: Actor;
  /** Metadata at the end of the message (`Revision: 1.2`). */
  trailers?: readonly Trailer[];
  /** Tagger date; defaults to now. */
  date?: Date;
}

export interface TagResult {
  /** The full ref, `refs/tags/<name>`. */
  ref: string;
  /** The annotated tag object. */
  tag: string;
  /** The commit it points to. */
  commit: string;
  /** The identity as recorded. */
  tagger: Actor;
}

/**
 * A merge that git cannot make without help: the paths that conflict,
 * with what kind of conflict. Nothing was written to any ref; conflicts
 * are never resolved automatically.
 */
export class MergeConflictError extends Error {
  constructor(
    readonly ref: string,
    readonly expected: string,
    readonly source: string,
    readonly conflicts: readonly MergeConflict[],
  ) {
    super(
      `merging ${source} into ${ref} conflicts in ${conflicts.map((c) => c.path).join(', ')}`,
    );
    this.name = 'MergeConflictError';
  }
}

/**
 * The oldest git merges run on: `merge-tree --write-tree` needs 2.38, and
 * `GIT_ATTR_SOURCE` (attributes from an empty tree, never from content)
 * 2.40.
 */
export const MIN_MERGE_GIT_VERSION = [2, 40] as const;

export interface WriterLimits {
  /** Largest file a change may write, in bytes. Default 20 MiB. */
  maxFileBytes: number;
  /** Largest total of all files one commit may write, in bytes. Default 100 MiB. */
  maxCommitBytes: number;
  /** Most changes (writes and deletes) in one commit. Default 1000. */
  maxChanges: number;
}

export const DEFAULT_WRITER_LIMITS: Readonly<WriterLimits> = {
  maxFileBytes: 20 * 1024 * 1024,
  maxCommitBytes: 100 * 1024 * 1024,
  maxChanges: 1000,
};

/**
 * A ref did not point where the caller expected: someone else moved,
 * created or deleted it first. Nothing was changed; read the ref again and
 * retry on top of `actual`.
 */
export class RefConflictError extends Error {
  constructor(
    readonly ref: string,
    /** What the caller expected; undefined: that the ref does not exist. */
    readonly expected: string | undefined,
    /** Where the ref points now; undefined: it does not exist. */
    readonly actual: string | undefined,
  ) {
    super(
      `${ref} is at ${actual ?? '(none)'}, expected ${expected ?? '(none)'}`,
    );
    this.name = 'RefConflictError';
  }
}

export type WriteErrorCode =
  | 'invalid-ref'
  | 'invalid-path'
  | 'invalid-commit'
  | 'invalid-identity'
  | 'invalid-message'
  | 'invalid-trailer'
  | 'duplicate-path'
  | 'path-conflict'
  | 'not-found'
  | 'too-large'
  | 'too-many-changes'
  | 'no-changes'
  | 'protected-ref'
  | 'checked-out'
  | 'invalid-change'
  | 'invalid-asset'
  | 'invalid-merge'
  | 'unrelated-histories';

/** A write request that can never succeed as given; nothing was changed. */
export class WriteError extends Error {
  constructor(
    readonly code: WriteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WriteError';
  }
}

/**
 * Writes content to a Git repository without a working tree or index: the
 * blobs and trees of a write hashed here and written in one
 * `unpack-objects --strict`, commits with `commit-tree`, and refs only by
 * compare-and-swap (`update-ref` in a transaction with the
 * expected old value), so concurrent writers never lose each other's commits.
 */
export class GitWriter {
  private readonly gitBinary: string;
  private readonly limits: WriterLimits;
  private readonly protectedBranches: readonly string[];
  private readonly env: NodeJS.ProcessEnv;
  private emptyTreeId?: string;

  constructor(
    readonly dir: string,
    options: {
      gitBinary?: string;
      limits?: Partial<WriterLimits>;
      /**
       * Branches that cannot be deleted, besides the one HEAD names (for
       * the API: its default branch).
       */
      protectedBranches?: readonly string[];
    } = {},
  ) {
    this.gitBinary = options.gitBinary ?? 'git';
    this.limits = { ...DEFAULT_WRITER_LIMITS, ...options.limits };
    this.protectedBranches = options.protectedBranches ?? [];
    this.env = gitEnv(dir);
  }

  /**
   * Commits `changes` on top of `parent` and moves `branch` from `parent` to
   * the new commit. Throws `RefConflictError` if the branch no longer points
   * to `parent` (or, for `parent: null`, already exists).
   */
  async commit(request: CommitRequest): Promise<CommitResult> {
    return this.withObjects(async (objects) => {
      const { tree, written } = await this.prepare(objects, request);
      return this.commitTreeOn(objects, { ...request, tree }, written);
    });
  }

  /**
   * What merging `source` into `expected` would hold at `paths`, without
   * writing a commit or moving a ref (the tree `merge` would commit, or
   * the side it would fast-forward to): each path's bytes, `null` where
   * the merge holds no file; `'conflicts'` when the merge would conflict.
   * Each path must be one `commit` may write (`WriteError`
   * `invalid-path`). Objects the merge writes are unreferenced (`git gc`
   * removes them).
   */
  async mergedFiles(
    expected: string,
    source: string,
    paths: readonly string[],
  ): Promise<Map<string, Buffer | null> | 'conflicts'> {
    assertCommitId(expected);
    assertCommitId(source);
    for (const path of paths) assertWritablePath(path);
    return this.withObjects(async (objects) => {
      let tree: string;
      const ancestry =
        expected === source ? 'merged' : await this.ancestry(expected, source);
      if (ancestry === 'merged') {
        tree = expected;
      } else if (ancestry === 'fast-forward') {
        tree = source;
      } else {
        const merged = await this.mergeTrees(objects, expected, source);
        if (merged.conflicts.length > 0) return 'conflicts';
        tree = merged.tree;
      }
      const files = new Map<string, Buffer | null>();
      for (const path of paths) {
        const entry = await objects.entryAt(tree, path);
        files.set(
          path,
          entry?.type === 'blob' ? await objects.blob(entry.oid) : null,
        );
      }
      return files;
    });
  }

  /**
   * Applies the change `from` → `to` onto `onto`, writing no commit and
   * moving no ref: a three-way merge with `from` as its merge base (`git
   * merge-tree --write-tree --merge-base`), as carrying a fix made on one
   * branch over to another starts. For each of `paths` (each one `commit`
   * may write, `WriteError` `invalid-path` otherwise) that does not
   * conflict and where the result differs from `onto`, `files` holds the
   * result's bytes (`null`: no file there). `conflicts` lists every path
   * git could not combine, paths outside `paths` too, as `merge` names
   * them; they are never resolved, and nothing of them is in `files`. A
   * path the result holds as no regular file (a folder, a symlink, a
   * submodule) is a conflict of kind `not-a-file`. Attributes are read
   * from an empty tree, as for `merge`. Objects git writes are
   * unreferenced (`git gc` removes them).
   */
  async applyChange(request: {
    readonly from: string;
    readonly to: string;
    readonly onto: string;
    readonly paths: readonly string[];
  }): Promise<{
    files: Map<string, Buffer | null>;
    conflicts: MergeConflict[];
  }> {
    const { from, to, onto, paths } = request;
    assertCommitId(from);
    assertCommitId(to);
    assertCommitId(onto);
    for (const path of paths) assertWritablePath(path);
    await this.assertMergeSupport();
    return this.withObjects(async (objects) => {
      const merged = await this.mergeTrees(objects, onto, to, from);
      const conflicts = merged.conflicts.map((c) => ({
        path: c.path,
        kinds: [...c.kinds],
      }));
      const conflicted = new Set(conflicts.map((c) => c.path));
      const files = new Map<string, Buffer | null>();
      for (const path of new Set(paths)) {
        if (conflicted.has(path)) continue;
        const result = await objects.entryAt(merged.tree, path);
        const ours = await objects.entryAt(onto, path);
        if (result?.oid === ours?.oid && result?.mode === ours?.mode) continue;
        if (result === undefined) {
          files.set(path, null);
          continue;
        }
        if (result.type !== 'blob' || !/^1006[0-7]{2}$/.test(result.mode)) {
          conflicts.push({ path, kinds: ['not-a-file'] });
          continue;
        }
        files.set(path, await objects.blob(result.oid));
      }
      return { files, conflicts };
    });
  }

  /**
   * The first half of `commit`: checks the request as `commit` does and
   * writes the blobs and the tree `changes` make of `parent`'s tree, but no
   * commit and no ref. Returns that tree, for `commitPrepared`. A caller
   * that must record what it is about to commit before any ref moves (an
   * intent: the parent and the tree) does it between the two. Throws
   * `WriteError` (`no-changes` when the tree is `parent`'s); the objects
   * it wrote are unreferenced until a commit names them (`git gc` removes
   * them otherwise).
   */
  async prepareCommit(
    request: Omit<CommitRequest, 'branch'> & { branch?: string },
  ): Promise<{ tree: string }> {
    return this.withObjects(async (objects) => {
      const { tree, written } = await this.prepare(objects, request);
      await this.writeObjects(written);
      return { tree };
    });
  }

  /**
   * The second half of `commit`: a commit of `tree` (from `prepareCommit`)
   * on top of `parent`, and `branch` moved from `parent` to it by
   * compare-and-swap. Throws `RefConflictError` if the branch no longer
   * points to `parent` (or, for `parent: null`, already exists), and
   * `WriteError` for a tree that is no tree object or is `parent`'s.
   */
  async commitPrepared(
    request: Omit<CommitRequest, 'changes'> & { tree: string },
  ): Promise<CommitResult> {
    return this.withObjects((objects) => this.commitTreeOn(objects, request));
  }

  /** Creates `branch` at `commit`; throws `RefConflictError` if it already exists. */
  async createBranch(branch: string, commit: string): Promise<void> {
    const ref = branchRef(branch);
    assertCommitId(commit);
    const refs = this.listRefsEarly();
    const tree = await this.withObjects((objects) => objects.treeOf(commit));
    if (tree === undefined) {
      throw new WriteError('invalid-commit', `no commit ${commit}`);
    }
    await this.updateRefs(
      [{ ref, new: commit, old: null }],
      'openfolia: create branch',
      refs,
    );
  }

  /**
   * Deletes `branch` if it still points to `expected`; throws
   * `RefConflictError` otherwise. The branch HEAD names and the writer's
   * `protectedBranches` cannot be deleted.
   */
  async deleteBranch(branch: string, expected: string): Promise<void> {
    const ref = branchRef(branch);
    assertCommitId(expected);
    const refs = this.listRefsEarly();
    const head = await this.headRef();
    const protectedRefs = [
      ...(head ? [head] : []),
      ...this.protectedBranches.map((b) => `refs/heads/${b}`),
    ];
    if (protectedRefs.some((p) => p.toLowerCase() === ref.toLowerCase())) {
      throw new WriteError('protected-ref', `"${branch}" is protected`);
    }
    await this.updateRefs(
      [{ ref, new: null, old: expected }],
      'openfolia: delete branch',
      refs,
    );
  }

  /**
   * Merges `source` into `branch` without a working tree
   * (`git merge-tree --write-tree`) and moves the branch from `expected`
   * by compare-and-swap: a fast-forward when allowed and possible, else a
   * merge commit with parents `expected` and `source`. Throws
   * `MergeConflictError` (the conflicting paths) when the merge needs a
   * person, and `RefConflictError` when the branch no longer points to
   * `expected`; in both cases no ref changed. Needs git 2.40 or later.
   */
  async merge(request: MergeRequest): Promise<MergeResult> {
    const ref = branchRef(request.branch);
    assertCommitId(request.expected);
    assertCommitId(request.source);
    const fastForward = request.fastForward ?? 'allow';
    if (fastForward !== 'allow' && fastForward !== 'never') {
      throw new WriteError(
        'invalid-merge',
        'fastForward must be "allow" or "never"',
      );
    }
    const body = checkBody(request.message);
    const message = withTrailers(body, request.trailers ?? []);
    const author = normalizeActor(request.author);
    const committer = normalizeActor(request.committer ?? request.author);
    const date = gitDate(request.date ?? new Date());
    const { expected, source } = request;
    return this.withObjects(async (objects) => {
      // Started together, awaited in this order: what is wrong first is
      // what the caller hears, as when they ran one after the other.
      const refs = this.listRefsEarly();
      const trailers = started(this.assertNoTrailers(body));
      const support = started(this.assertMergeSupport());
      const trees = [expected, source].map((c) =>
        started(this.commitTree(objects, c)),
      );
      const related = started(
        expected === source
          ? Promise.resolve('merged' as const)
          : this.ancestry(expected, source),
      );
      await trailers;
      await support;
      for (const tree of trees) await tree;
      // Early, so a stale caller learns it before any work; the
      // transaction below checks the same listing again, and its
      // compare-and-swap catches whatever moved since.
      await this.checkRefUpdates(
        [{ ref, new: expected, old: expected }],
        await refs,
      );
      const ancestry = await related;
      if (ancestry === 'merged') {
        return { kind: 'up-to-date', commit: expected };
      }
      if (fastForward === 'allow' && ancestry === 'fast-forward') {
        await this.updateRefs(
          [{ ref, new: source, old: expected }],
          `openfolia: fast-forward by ${author.email}`,
          refs,
        );
        return { kind: 'fast-forward', commit: source };
      }
      if (ancestry === 'unrelated') {
        throw new WriteError(
          'unrelated-histories',
          `${source} and ${expected} have no common history`,
        );
      }
      const { tree, conflicts, written } = await this.resolvedMerge(
        objects,
        expected,
        source,
        keepPaths(request.keep),
      );
      if (conflicts.length > 0) {
        throw new MergeConflictError(ref, expected, source, conflicts);
      }
      // The kept files' blobs and trees, if any, and the commit: one write.
      const commit = written.commit({
        tree,
        parents: [expected, source],
        message,
        author,
        committer,
        date,
      });
      // Listed again beside the write: the merge took time since the
      // up-front check, and the checks only the listing makes (symbolic,
      // checked out) should see the refs as they are now.
      const fresh = this.listRefsEarly();
      await this.writeObjects(written);
      await this.updateRefs(
        [{ ref, new: commit, old: expected }],
        `openfolia: merge by ${author.email}`,
        fresh,
      );
      return { kind: 'merge', commit, tree, author, committer };
    });
  }

  /**
   * What `merge` of `source` into a branch at `expected` would do, with
   * `keep` as there, writing no commit and moving no ref (objects git
   * writes are unreferenced; `git gc` removes them): up to date, the files
   * the result changes, or the conflicts it would refuse with. Histories
   * with nothing in common are a `WriteError` (`unrelated-histories`), as
   * for `merge`.
   */
  async previewMerge(
    expected: string,
    source: string,
    keep?: readonly string[],
  ): Promise<MergePreview> {
    assertCommitId(expected);
    assertCommitId(source);
    const kept = keepPaths(keep);
    return this.withObjects(async (objects) => {
      const support = started(this.assertMergeSupport());
      const trees = [expected, source].map((c) =>
        started(this.commitTree(objects, c)),
      );
      const related = started(
        expected === source
          ? Promise.resolve('merged' as const)
          : this.ancestry(expected, source),
      );
      await support;
      for (const tree of trees) await tree;
      const ancestry = await related;
      if (ancestry === 'merged') return { kind: 'up-to-date' };
      if (ancestry === 'fast-forward') {
        return {
          kind: 'fast-forward',
          changed: await this.changedBetween(expected, source),
        };
      }
      if (ancestry === 'unrelated') {
        throw new WriteError(
          'unrelated-histories',
          `${source} and ${expected} have no common history`,
        );
      }
      const { tree, conflicts, written } = await this.resolvedMerge(
        objects,
        expected,
        source,
        kept,
      );
      if (conflicts.length > 0) {
        return { kind: 'conflicts', conflicts: [...conflicts] };
      }
      await this.writeObjects(written);
      return {
        kind: 'merge',
        changed: await this.changedBetween(expected, tree),
      };
    });
  }

  /**
   * Creates the annotated tag `name` on `commit`. Tags are immutable:
   * throws `RefConflictError` (with `actual`) when the tag exists, and
   * never moves or deletes one. The name follows `git check-ref-format`,
   * and the stricter rules branch names follow here.
   */
  async createTag(request: TagRequest): Promise<TagResult> {
    const ref = tagRef(request.name);
    assertCommitId(request.commit);
    const body = checkBody(request.message);
    const message = withTrailers(body, request.trailers ?? []);
    const tagger = normalizeActor(request.tagger);
    const date = gitDate(request.date ?? new Date());
    const trailers = started(this.assertNoTrailers(body));
    const format = started(this.run(['check-ref-format', ref]));
    await trailers;
    if ((await format).code !== 0) {
      throw new WriteError('invalid-ref', `invalid tag name "${request.name}"`);
    }
    await this.withObjects((objects) =>
      this.commitTree(objects, request.commit),
    );
    // Listed beside `mktag`, right before the transaction checks it.
    const refs = this.listRefsEarly();
    const tag = (
      await this.git(['mktag'], {
        input:
          `object ${request.commit}\n` +
          'type commit\n' +
          `tag ${request.name}\n` +
          `tagger ${tagger.name} <${tagger.email}> ${date.slice(1)}\n` +
          `\n${message}`,
      })
    ).trim();
    await this.updateRefs(
      [{ ref, new: tag, old: null }],
      `openfolia: tag by ${tagger.email}`,
      refs,
    );
    return { ref, tag, commit: request.commit, tagger };
  }

  // --- building blocks -----------------------------------------------------

  /**
   * Runs one operation with its own object reader (one `cat-file --batch`
   * process for every object it reads), closed when it ends.
   */
  private async withObjects<T>(
    work: (objects: ObjectReader) => Promise<T>,
  ): Promise<T> {
    const objects = new ObjectReader(
      new CatFileBatch(this.gitBinary, this.dir, this.env),
      () => this.git(['rev-parse', '--show-object-format']),
    );
    try {
      return await work(objects);
    } finally {
      objects.close();
    }
  }

  /**
   * `prepareCommit` on an operation's reader: the tree, and the objects to
   * write for it (not written yet).
   */
  private async prepare(
    objects: ObjectReader,
    request: Omit<CommitRequest, 'branch'> & { branch?: string },
  ): Promise<{ tree: string; written: ObjectsToWrite }> {
    if (request.branch !== undefined) branchRef(request.branch);
    if (request.parent !== null) assertCommitId(request.parent);
    const body = checkBody(request.message);
    withTrailers(body, request.trailers ?? []);
    normalizeActor(request.author);
    normalizeActor(request.committer ?? request.author);
    gitDate(request.date ?? new Date());
    const changes = this.checkChanges(request.changes);
    const { parent } = request;
    const trailers = started(this.assertNoTrailers(body));
    const base = started(
      parent === null
        ? Promise.resolve(undefined)
        : this.commitTree(objects, parent),
    );
    await trailers;
    const baseTree = await base;
    const written = new ObjectsToWrite(
      await objects.format(parent ?? undefined),
    );
    const tree =
      (await this.buildTree(objects, written, baseTree, changes, '')) ??
      written.tree([]);
    if (tree === baseTree) {
      throw new WriteError('no-changes', 'the changes change nothing');
    }
    return { tree, written };
  }

  /**
   * `commitPrepared` on an operation's reader. `prepared`: the objects
   * `prepare` made for `tree` in this operation (`commit`), not written
   * yet; it checked the message, the parent and the tree already, and the
   * commit is written with them.
   */
  private async commitTreeOn(
    objects: ObjectReader,
    request: Omit<CommitRequest, 'changes'> & { tree: string },
    prepared?: ObjectsToWrite,
  ): Promise<CommitResult> {
    const ref = branchRef(request.branch);
    if (request.parent !== null) assertCommitId(request.parent);
    const body = checkBody(request.message);
    const message = withTrailers(body, request.trailers ?? []);
    const author = normalizeActor(request.author);
    const committer = normalizeActor(request.committer ?? request.author);
    const date = gitDate(request.date ?? new Date());
    const { tree, parent } = request;
    if (prepared === undefined) {
      const trailers = started(this.assertNoTrailers(body));
      const isTree = started(objects.isTree(tree));
      const parentTree = started(
        parent === null
          ? Promise.resolve(undefined)
          : this.commitTree(objects, parent),
      );
      await trailers;
      if (!(await isTree)) {
        throw new WriteError('invalid-commit', `no tree ${tree}`);
      }
      if ((await parentTree) === tree) {
        throw new WriteError('no-changes', 'the changes change nothing');
      }
    }
    const written = prepared ?? new ObjectsToWrite(await objects.format(tree));
    const commit = written.commit({
      tree,
      parents: parent === null ? [] : [parent],
      message,
      author,
      committer,
      date,
    });
    // Listed now, beside the write, so the checks the listing alone makes
    // (symbolic, checked out, a clashing name) see the refs as late as
    // before.
    const refs = this.listRefsEarly();
    await this.writeObjects(written);
    await this.updateRefs(
      [{ ref, new: commit, old: parent }],
      `openfolia: commit by ${author.email}`,
      refs,
    );
    return { commit, tree, author, committer };
  }

  /**
   * Applies ref updates as one transaction: all or none. Every update names
   * the value it expects (`old: null`: the ref must not exist), so a ref
   * that moved fails the whole transaction with `RefConflictError`.
   * `listed`: the refs as this operation listed them (`listRefsEarly`),
   * checked again here; whatever moved since, the transaction's
   * compare-and-swap refuses.
   */
  private async updateRefs(
    updates: readonly RefUpdate[],
    reason: string,
    listed: Promise<RefListing>,
  ): Promise<void> {
    try {
      await this.applyRefUpdates(updates, reason, await listed);
    } finally {
      // Whatever happened, a listing begun before is not shared any more.
      refsMoved(this.dir);
    }
  }

  private async applyRefUpdates(
    updates: readonly RefUpdate[],
    reason: string,
    listed: RefListing,
  ): Promise<void> {
    await this.checkRefUpdates(updates, listed);
    const input = updates.map(refCommand).join('');
    for (let attempt = 1; ; attempt++) {
      try {
        await this.git(
          [
            '-c',
            'core.filesRefLockTimeout=1000',
            'update-ref',
            '-m',
            reason.replace(/[\0\n]/g, ' '),
            '--stdin',
            '-z',
          ],
          { input },
        );
        return;
      } catch (error) {
        // Tell a ref that moved (a conflict) from a lock held by a concurrent
        // writer (transient): only the ref values decide, never the message.
        // If the refs cannot even be read, the update-ref error says more.
        const refs = await this.listRefs().catch(() => {
          throw error;
        });
        for (const u of updates) {
          const actual = refs.get(u.ref)?.oid;
          if (actual !== (u.old ?? undefined)) {
            throw new RefConflictError(u.ref, u.old ?? undefined, actual);
          }
        }
        // A clashing ref created concurrently, after the up-front check:
        // as git saw it, or (for a failure git reports as a ref it cannot
        // lock, never any other error) by the same rule as that check.
        const clash = isNameClash(error)
          ? 'another ref'
          : isLockError(error)
            ? updates
                .filter((u) => u.old === null)
                .map((u) => clashingRef(refs, u.ref))
                .find(Boolean)
            : undefined;
        if (clash) {
          throw new WriteError(
            'invalid-ref',
            `${updates.map((u) => u.ref).join(', ')} clashes with ${clash}`,
          );
        }
        if (attempt >= 5 || !isLockError(error)) throw error;
        await sleep(20 * attempt + Math.random() * 20);
      }
    }
  }

  // --- merges --------------------------------------------------------------

  /**
   * Fails clearly when git is older than `MIN_MERGE_GIT_VERSION`, instead
   * of with a usage message from git (or attributes read from content).
   * Asked once per git binary in a process.
   */
  private assertMergeSupport(): Promise<void> {
    const known = mergeSupport.get(this.gitBinary);
    if (known) return known;
    const asked = this.git(['version']).then((out) => {
      const [, major = '0', minor = '0'] = /(\d+)\.(\d+)/.exec(out) ?? [];
      const [needMajor, needMinor] = MIN_MERGE_GIT_VERSION;
      if (
        Number(major) < needMajor ||
        (Number(major) === needMajor && Number(minor) < needMinor)
      ) {
        throw new GitError(
          `merges need git ${needMajor}.${needMinor} or later (merge-tree --write-tree, GIT_ATTR_SOURCE); found "${out.trim()}"`,
        );
      }
    });
    mergeSupport.set(this.gitBinary, asked);
    asked.catch(() => {
      if (mergeSupport.get(this.gitBinary) === asked) {
        mergeSupport.delete(this.gitBinary);
      }
    });
    return asked;
  }

  /**
   * How `theirs` stands to `ours` (two different commits), from their
   * merge bases (`merge-base --all`, one process): `merged` when `theirs`
   * is in `ours`' history (it is a merge base), `fast-forward` when `ours`
   * is in `theirs`' (it is one), `unrelated` when there is none, else
   * `diverged`. The same answers as `merge-base --is-ancestor` each way:
   * a commit in the other's history is their one best common ancestor.
   */
  private async ancestry(
    ours: string,
    theirs: string,
  ): Promise<'merged' | 'fast-forward' | 'diverged' | 'unrelated'> {
    const result = await this.run(['merge-base', '--all', ours, theirs]);
    if (result.code === 1 && !result.stdout.trim()) return 'unrelated';
    if (result.code !== 0) {
      throw new GitCommandError('merge-base', result.code, result.stderr);
    }
    const bases = result.stdout.split('\n').filter(Boolean);
    if (bases.length === 0 || !bases.every((b) => COMMIT_ID.test(b))) {
      throw new GitError(`unexpected git merge-base output: ${result.stdout}`);
    }
    if (bases.includes(theirs)) return 'merged';
    if (bases.includes(ours)) return 'fast-forward';
    return 'diverged';
  }

  /**
   * The merged tree of two commits, or the paths that conflict. Attributes
   * are read from an empty tree, never from the commits being merged: a
   * `.gitattributes` pushed in content (`merge=union`, say) must not
   * resolve a conflict silently. The repository's own `info/attributes`
   * and configuration still apply; they are the host's.
   */
  private async mergeTrees(
    objects: ObjectReader,
    ours: string,
    theirs: string,
    /** The merge base to use instead of the one git finds. */
    base?: string,
    /** Detect renames (off with `base`): a rename carries an edit to another path. */
    renames = base === undefined,
  ): Promise<{ tree: string; conflicts: readonly MergeConflict[] }> {
    const emptyTree = await this.emptyTree(objects);
    const args = [
      '-c',
      `attr.tree=${emptyTree}`,
      // Applying a change at its own paths (`base` given): a rename on one
      // side would carry an edit to a path nobody asked about.
      ...(renames ? [] : ['-c', 'merge.renames=false']),
      'merge-tree',
      '--write-tree',
      '-z',
      '--name-only',
      ...(base === undefined ? [] : [`--merge-base=${base}`]),
      ours,
      theirs,
    ];
    const result = await this.run(args, {
      env: { GIT_ATTR_SOURCE: emptyTree },
    });
    if (result.code !== 0 && result.code !== 1) {
      throw new GitCommandError('merge-tree', result.code, result.stderr);
    }
    return parseMergeTree(result.stdout, result.code === 1);
  }

  /**
   * The empty tree's ID, written to the repository unless it reads as a
   * tree there already (git knows it without its object; attributes are
   * read from it, so it must read). Asked once per writer.
   */
  private async emptyTree(objects: ObjectReader): Promise<string> {
    if (this.emptyTreeId !== undefined) return this.emptyTreeId;
    const written = new ObjectsToWrite(await objects.format());
    const id = written.tree([]);
    if (!(await objects.isTree(id))) await this.writeObjects(written);
    this.emptyTreeId = id;
    return id;
  }

  /**
   * `mergeTrees` of `ours` and `theirs`, with the conflicts at `keep`
   * resolved to `ours`' file (`MergeRequest.keep`): the conflicts left are
   * those it could not resolve (all of them, when any is left, so nothing
   * is resolved halfway). A kept path `ours` holds as no regular file is
   * left as a conflict of kind `not-a-file`. `written`: the objects of a
   * tree with kept files, not written yet (none for a tree git wrote).
   */
  private async resolvedMerge(
    objects: ObjectReader,
    ours: string,
    theirs: string,
    keep: ReadonlySet<string>,
  ): Promise<{
    tree: string;
    conflicts: readonly MergeConflict[];
    written: ObjectsToWrite;
  }> {
    const written = new ObjectsToWrite(await objects.format(ours));
    // Keeping files is keeping them at their own paths: with renames, a file
    // the other side moved would be kept at (or dropped from) a path `ours`
    // never had, so a kept merge sees no renames; the conflicts it then
    // finds at other paths are left unresolved.
    const merged = await this.mergeTrees(
      objects,
      ours,
      theirs,
      undefined,
      keep.size === 0,
    );
    if (merged.conflicts.length === 0 || keep.size === 0) {
      return { ...merged, written };
    }
    const unresolved = merged.conflicts.filter(
      (c) =>
        !keep.has(c.path) ||
        c.kinds.length === 0 ||
        !c.kinds.every((kind) => KEEPABLE_CONFLICTS.has(kind)),
    );
    if (unresolved.length > 0) {
      return { tree: merged.tree, conflicts: unresolved, written };
    }
    const changes = new Map<string, Buffer | null>();
    for (const { path, kinds } of merged.conflicts) {
      const mine = await objects.entryAt(ours, path);
      if (mine === undefined) {
        if ((await objects.entryAt(merged.tree, path)) !== undefined) {
          changes.set(path, null);
        }
        continue;
      }
      if (mine.type !== 'blob' || mine.mode !== '100644') {
        return {
          tree: merged.tree,
          conflicts: [{ path, kinds: [...kinds, 'not-a-file'] }],
          written,
        };
      }
      changes.set(path, await objects.blob(mine.oid));
    }
    const tree =
      (await this.buildTree(objects, written, merged.tree, changes, '')) ??
      written.tree([]);
    return { tree, conflicts: [], written };
  }

  /** The files that differ between two trees (or commits), as `GitRepo.changedPaths` lists them. */
  private async changedBetween(
    from: string,
    to: string,
  ): Promise<{ path: string; deleted: boolean }[]> {
    const out = await this.git(
      [
        'diff-tree',
        '-r',
        '-z',
        '--no-renames',
        '--name-status',
        '--end-of-options',
        from,
        to,
      ],
      { encoding: 'latin1' },
    );
    const fields = out.split('\0');
    const changed: { path: string; deleted: boolean }[] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const status = fields[i] ?? '';
      const path = Buffer.from(fields[i + 1] ?? '', 'latin1').toString('utf8');
      if (status && path) changed.push({ path, deleted: status === 'D' });
    }
    return changed;
  }

  // --- trees ---------------------------------------------------------------

  /**
   * The tree `base` with `changes` (paths relative to it) applied, or
   * undefined if it ends up empty. Only the directories on a changed path
   * are read and rewritten; every other entry is kept as it is. The blobs
   * and trees it makes are added to `written`, for `writeObjects`.
   */
  private async buildTree(
    objects: ObjectReader,
    written: ObjectsToWrite,
    base: string | undefined,
    changes: Map<string, Buffer | null>,
    prefix: string,
  ): Promise<string | undefined> {
    const entries = new Map<string, TreeEntry>();
    for (const e of base ? await objects.tree(base) : []) {
      entries.set(e.name, e);
    }
    const files = new Map<string, Buffer | null>();
    const dirs = new Map<string, Map<string, Buffer | null>>();
    for (const [path, content] of changes) {
      const slash = path.indexOf('/');
      if (slash < 0) {
        files.set(path, content);
      } else {
        const name = path.slice(0, slash);
        let sub = dirs.get(name);
        if (!sub) dirs.set(name, (sub = new Map()));
        sub.set(path.slice(slash + 1), content);
      }
    }
    for (const [name, content] of files) {
      const full = prefix + name;
      if (dirs.has(name)) {
        throw new WriteError(
          'path-conflict',
          `"${full}" is both a file and a folder`,
        );
      }
      const existing = entries.get(name);
      if (existing?.type === 'tree') {
        throw new WriteError('path-conflict', `"${full}" is a folder`);
      }
      if (content === null) {
        if (!existing) throw new WriteError('not-found', `no file "${full}"`);
        entries.delete(name);
      } else {
        const oid = written.blob(content);
        entries.set(name, { mode: '100644', type: 'blob', oid, name });
      }
    }
    for (const [name, sub] of dirs) {
      const full = prefix + name;
      const existing = entries.get(name);
      if (existing && existing.type !== 'tree') {
        throw new WriteError('path-conflict', `"${full}" is not a folder`);
      }
      const oid = await this.buildTree(
        objects,
        written,
        existing?.oid,
        sub,
        `${full}/`,
      );
      if (oid) {
        entries.set(name, { mode: '040000', type: 'tree', oid, name });
      } else {
        entries.delete(name);
      }
    }
    if (entries.size === 0) return undefined;
    return written.tree([...entries.values()]);
  }

  /**
   * Writes the objects an operation made, all in one `unpack-objects
   * --strict` (loose, as `hash-object -w` and `mktree` wrote them): git
   * checks each (a tree's entries sorted, their names and modes sane, every
   * object they name there) and refuses the lot if one is wrong, so no
   * object is written that git would not have written itself.
   */
  private async writeObjects(written: ObjectsToWrite): Promise<void> {
    if (written.size === 0) return;
    await this.git(['unpack-objects', '-q', '--strict'], {
      input: written.pack(),
    });
  }

  /** The tree of a commit; refuses an ID that is not a commit. */
  private async commitTree(
    objects: ObjectReader,
    commit: string,
  ): Promise<string> {
    const tree = await objects.treeOf(commit);
    if (tree === undefined) {
      throw new WriteError('invalid-commit', `no commit ${commit}`);
    }
    return tree;
  }

  // --- refs ----------------------------------------------------------------

  /**
   * Checks ref updates against the repository before the transaction, so a
   * ref is only ever changed by its exact name: the ref must hold the
   * expected value under exactly that name (on a case-insensitive file
   * system `MAIN` would otherwise reach `main`), must not be symbolic (an
   * update would move the ref it points to) or checked out in a worktree
   * (its index and files would fall behind), and a new branch or tag must
   * not share its name, in any case, with an existing branch or tag, nor
   * clash with one as file and folder (`a` and `a/b`).
   */
  private async checkRefUpdates(
    updates: readonly RefUpdate[],
    refs: RefListing,
  ): Promise<void> {
    // Refs created earlier in this transaction count for later ones.
    const known = new Map<string, unknown>(refs);
    for (const u of updates) {
      const current = refs.get(u.ref);
      if (current?.symref) {
        throw new WriteError('invalid-ref', `${u.ref} is a symbolic ref`);
      }
      if (current?.oid !== (u.old ?? undefined)) {
        throw new RefConflictError(u.ref, u.old ?? undefined, current?.oid);
      }
      if (
        u.old !== null &&
        (await this.isCheckedOut(u.ref, current?.worktree))
      ) {
        throw new WriteError(
          'checked-out',
          `${u.ref} is checked out in a worktree`,
        );
      }
      const clash = u.old === null ? clashingRef(known, u.ref) : undefined;
      if (clash) {
        throw new WriteError(
          'invalid-ref',
          `${u.ref} would clash with ${clash}`,
        );
      }
      // A delete frees its name for a later create (a rename by case);
      // what git refuses in one transaction (`a` deleted, `a/b` created)
      // comes back typed as a clash.
      if (u.new === null) known.delete(u.ref);
      else known.set(u.ref, u.new);
    }
  }

  /**
   * `listRefs` started now, for this operation's ref check: started early,
   * it runs beside the operation's other steps. A failure is the check's
   * to report, so it is never an unhandled rejection meanwhile.
   */
  private listRefsEarly(): Promise<RefListing> {
    return started(this.listRefs());
  }

  /**
   * Every branch and tag by its exact name, with the worktree each is
   * checked out in (`%(worktreepath)`: the worktrees `git worktree list`
   * lists, one listing for both).
   */
  private async listRefs(): Promise<RefListing> {
    const out = await this.git([
      'for-each-ref',
      '--format=%(refname)%00%(objectname)%00%(symref)%00%(worktreepath)%00',
      'refs/heads',
      'refs/tags',
    ]);
    // Each ref ends in NUL and a newline; a worktree path may hold a
    // newline, a ref name never does.
    const fields = out.split('\0');
    const refs: RefListing = new Map();
    for (let i = 0; i + 3 < fields.length; i += 4) {
      const name = (fields[i] ?? '').replace(/^\n/, '');
      const oid = fields[i + 1] ?? '';
      const symref = fields[i + 2] ?? '';
      const worktree = fields[i + 3] ?? '';
      if (!name.startsWith('refs/') || !/^[0-9a-f]*$/.test(oid)) {
        throw new GitError(`unexpected git for-each-ref output: ${name}`);
      }
      refs.set(name, {
        oid,
        symref: symref !== '',
        ...(worktree ? { worktree } : {}),
      });
    }
    return refs;
  }

  /**
   * Whether `ref`, whose `%(worktreepath)` is `worktree`, is checked out in
   * a worktree as `git worktree list` tells it: in any worktree but the
   * main one of a bare repository, which git reports at the repository's
   * own folder (for its `HEAD`) but which has no files or index to fall
   * behind. A non-bare repository's folder holds a `.git`. `%(worktreepath)`
   * names one worktree per ref, so where a bare repository has linked
   * worktrees too, `git worktree list` itself is asked whether one of them
   * has the branch `HEAD` names. Anything uncertain (a path that cannot be
   * read) counts as checked out.
   */
  private async isCheckedOut(
    ref: string,
    worktree: string | undefined,
  ): Promise<boolean> {
    if (!worktree) return false;
    if ((await presence(join(this.dir, '.git'))) !== 'absent') return true;
    try {
      const [listed, own] = await Promise.all([stat(worktree), stat(this.dir)]);
      if (listed.dev !== own.dev || listed.ino !== own.ino) return true;
    } catch {
      return true;
    }
    // The bare repository's own HEAD: checked out only in a linked worktree.
    if ((await presence(join(this.dir, 'worktrees'))) === 'absent') {
      return false;
    }
    return (await this.checkedOutRefs()).has(ref);
  }

  /** Branches checked out in the repository's worktrees. */
  private async checkedOutRefs(): Promise<Set<string>> {
    // Without -z, which needs git 2.36.
    const out = await this.git(['worktree', 'list', '--porcelain']);
    return new Set(
      out
        .split('\n')
        .filter((l) => l.startsWith('branch '))
        .map((l) => l.slice('branch '.length)),
    );
  }

  /**
   * Trailers come only from the request's `trailers`: a body that git
   * itself would read as ending in trailers (an approval, say) is refused.
   */
  private async assertNoTrailers(body: string): Promise<void> {
    const parsed = await this.git(
      ['interpret-trailers', '--parse', '--no-divider'],
      { input: `${body}\n` },
    );
    if (parsed.trim()) {
      throw new WriteError(
        'invalid-message',
        'the message ends in lines git reads as trailers; pass trailers separately',
      );
    }
  }

  private async headRef(): Promise<string | undefined> {
    try {
      return (await this.git(['symbolic-ref', '--quiet', 'HEAD'])).trim();
    } catch (e) {
      if ((e as GitCommandError).exitCode === 1) return undefined;
      throw e;
    }
  }

  // --- validation ----------------------------------------------------------

  /** Validated changes by path; `null` content deletes. */
  private checkChanges(
    changes: readonly FileChange[],
  ): Map<string, Buffer | null> {
    if (changes.length === 0) {
      throw new WriteError('no-changes', 'a commit needs at least one change');
    }
    if (changes.length > this.limits.maxChanges) {
      throw new WriteError(
        'too-many-changes',
        `${changes.length} changes; at most ${this.limits.maxChanges} per commit`,
      );
    }
    const result = new Map<string, Buffer | null>();
    let total = 0;
    for (const change of changes) {
      assertWritablePath(change.path);
      if (result.has(change.path)) {
        throw new WriteError(
          'duplicate-path',
          `"${change.path}" is changed twice`,
        );
      }
      // Exactly one of `delete: true` and a content; anything else (say
      // `delete: false` next to a content from a JSON body) is refused
      // rather than guessed.
      const c = change as { content?: unknown; delete?: unknown };
      const isDelete = c.delete === true;
      const hasContent =
        typeof c.content === 'string' || c.content instanceof Uint8Array;
      if (
        isDelete === hasContent ||
        (c.delete !== undefined && !isDelete) ||
        (c.content !== undefined && !hasContent)
      ) {
        throw new WriteError(
          'invalid-change',
          `"${change.path}" needs either content or delete: true`,
        );
      }
      if (isDelete) {
        result.set(change.path, null);
        continue;
      }
      const content =
        typeof c.content === 'string'
          ? Buffer.from(c.content, 'utf8')
          : Buffer.from(c.content as Uint8Array);
      if (content.length > this.limits.maxFileBytes) {
        throw new WriteError(
          'too-large',
          `"${change.path}" has ${content.length} bytes; at most ${this.limits.maxFileBytes}`,
        );
      }
      total += content.length;
      if (total > this.limits.maxCommitBytes) {
        throw new WriteError(
          'too-large',
          `the changes exceed ${this.limits.maxCommitBytes} bytes`,
        );
      }
      if (change.path.startsWith(`${LAYOUT.assets}/`)) {
        const hash = createHash('sha256').update(content).digest('hex');
        if (change.path !== `${LAYOUT.assets}/${hash}`) {
          throw new WriteError(
            'invalid-asset',
            `"${change.path}" must be named by its content's SHA-256 (${hash})`,
          );
        }
      }
      result.set(change.path, content);
    }
    return result;
  }

  // --- process -------------------------------------------------------------

  /** Runs git; rejects unless it exits with 0. */
  private async git(
    args: string[],
    options: {
      /** Bytes for stdin; an iterable is streamed with backpressure. */
      input?: string | Buffer | AsyncIterable<Buffer>;
      env?: Record<string, string>;
      encoding?: BufferEncoding;
    } = {},
  ): Promise<string> {
    const result = await this.run(args, options);
    if (result.code !== 0) {
      throw new GitCommandError(subcommand(args), result.code, result.stderr);
    }
    return result.stdout;
  }

  /**
   * Runs git and resolves with its exit code and output, whatever the
   * code; rejects only when it cannot start or is killed (the timeout).
   */
  private run(
    args: string[],
    options: {
      /** Bytes for stdin; an iterable is streamed with backpressure. */
      input?: string | Buffer | AsyncIterable<Buffer>;
      env?: Record<string, string>;
      encoding?: BufferEncoding;
    } = {},
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.gitBinary, ['-C', this.dir, ...args], {
        env: { ...this.env, ...options.env },
        timeout: 60_000,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      proc.stdout.on('data', (d: Buffer) => stdout.push(d));
      proc.stderr.on('data', (d: Buffer) => stderr.push(d));
      proc.stdin.on('error', () => {
        // The process failed before reading its input; 'close' reports it.
      });
      proc.on('error', (e) =>
        reject(new GitCommandError(subcommand(args), undefined, e.message)),
      );
      proc.on('close', (code) => {
        const err = Buffer.concat(stderr).toString('utf8').trim();
        if (code === null) {
          reject(new GitCommandError(subcommand(args), undefined, err));
          return;
        }
        resolve({
          code,
          stdout: Buffer.concat(stdout).toString(options.encoding ?? 'utf8'),
          stderr: err,
        });
      });
      const input = options.input ?? '';
      if (typeof input === 'string' || Buffer.isBuffer(input)) {
        proc.stdin.end(input);
        return;
      }
      const source = Readable.from(input, { highWaterMark: 1 });
      // A failure making the input (never git's) ends git too, so 'close'
      // reports it, as an error and not a partial write: the stream is
      // killed before it ends, so git never sees the rest as complete.
      source.on('error', (e: Error) => {
        reject(new GitCommandError(subcommand(args), undefined, e.message));
        proc.kill();
      });
      source.pipe(proc.stdin);
    });
  }
}

/** One ref change in an `updateRefs` transaction. */
interface RefUpdate {
  /** Full ref name, `refs/heads/…` or `refs/tags/…`. */
  ref: string;
  /** New value; null deletes the ref. */
  new: string | null;
  /** Required current value; null: the ref must not exist. */
  old: string | null;
}

/** An `update-ref --stdin -z` command that verifies the old value. */
function refCommand(u: RefUpdate): string {
  if (u.new === null) {
    // A delete without an old value would delete unconditionally.
    if (u.old === null) throw new Error(`delete of ${u.ref} without old value`);
    return `option no-deref\0delete ${u.ref}\0${u.old}\0`;
  }
  return u.old === null
    ? `option no-deref\0create ${u.ref}\0${u.new}\0`
    : `option no-deref\0update ${u.ref}\0${u.new}\0${u.old}\0`;
}

/** The git subcommand in an argument list (after `-c key=value` pairs). */
function subcommand(args: readonly string[]): string {
  let i = 0;
  while (args[i] === '-c') i += 2;
  return args[i] ?? '';
}

interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
  name: string;
}

class GitCommandError extends GitError {
  constructor(
    readonly command: string,
    readonly exitCode: number | undefined,
    readonly stderr: string,
  ) {
    super(`git ${command} failed (${exitCode ?? 'not started'}): ${stderr}`);
  }
}

const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const deflateAsync = promisify(deflate);
const REF_COMPONENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const FOLDERS = [
  LAYOUT.modules,
  LAYOUT.manuals,
  LAYOUT.terms,
  LAYOUT.designs,
  LAYOUT.assets,
  LAYOUT.symbols,
] as const;
const FILES: readonly string[] = [
  LAYOUT.config,
  LAYOUT.legacyConfig,
  LAYOUT.template,
];
const MAX_PATH = 1024;
const MAX_SEGMENT = 255;

/**
 * The existing branch or tag a new ref would clash with: the same short
 * name in any case (a branch and a tag included), or one name a folder of
 * the other (`a` and `a/b`), also in any case. The one rule for both the
 * up-front check and a failed transaction.
 */
function clashingRef(
  refs: Map<string, unknown>,
  ref: string,
): string | undefined {
  const name = shortName(ref).toLowerCase();
  for (const other of refs.keys()) {
    if (other === ref) continue;
    const otherName = shortName(other).toLowerCase();
    if (
      otherName === name ||
      otherName.startsWith(`${name}/`) ||
      name.startsWith(`${otherName}/`)
    ) {
      return other;
    }
  }
  return undefined;
}

/** `refs/heads/a/b` → `a/b`. */
function shortName(ref: string): string {
  return ref.split('/').slice(2).join('/');
}

function branchRef(branch: string): string {
  if (
    !isSafeRef(branch) ||
    branch === 'HEAD' ||
    // The reader would read it as a commit ID (`readsAsCommitId`).
    readsAsCommitId(branch) ||
    branch.split('/')[0] === 'refs' ||
    !branch
      .split('/')
      .every(
        (c) =>
          REF_COMPONENT.test(c) && !c.endsWith('.lock') && !c.endsWith('.'),
      )
  ) {
    throw new WriteError('invalid-ref', `invalid branch name "${branch}"`);
  }
  return `refs/heads/${branch}`;
}

/**
 * `refs/tags/<name>` for a tag name that follows the branch rules above
 * (a strict subset of `git check-ref-format`, which `createTag` runs too).
 */
function tagRef(name: string): string {
  try {
    return `refs/tags/${shortName(branchRef(name))}`;
  } catch {
    throw new WriteError('invalid-ref', `invalid tag name "${name}"`);
  }
}

function assertCommitId(commit: string): void {
  if (!COMMIT_ID.test(commit)) {
    throw new WriteError('invalid-commit', `not a commit ID: "${commit}"`);
  }
}

/**
 * A path a change may write: a file inside one of the layout's folders, or
 * one of its fixed files. No `..`, no hidden or absolute paths, no
 * characters outside `A-Za-z0-9._-`. In `templates/`, the one fixed file and an own template's
 * files (#396): `templates/<id>/<path>`, its ID a slug and its path one the content model allows
 * in a template's folder (`isTemplateFilePath`: at most 8 folders deep, 150 characters).
 */
export function isWritablePath(path: string): boolean {
  if (path.length > MAX_PATH || !isSafePath(path)) return false;
  const segments = path.split('/');
  if (segments.some((s) => s.length > MAX_SEGMENT)) return false;
  if (FILES.includes(path)) return true;
  if (segments[0] === LAYOUT.assets) {
    return segments.length === 2 && /^[0-9a-f]{64}$/.test(segments[1] ?? '');
  }
  if (segments[0] === LAYOUT.templates) {
    return (
      segments.length >= 3 &&
      DesignTemplateId.safeParse(segments[1]).success &&
      isTemplateFilePath(segments.slice(2).join('/'))
    );
  }
  return (
    segments.length >= 2 &&
    (FOLDERS as readonly string[]).includes(segments[0] ?? '')
  );
}

/** `MergeRequest.keep` checked: each a path `commit` may write. */
function keepPaths(keep: readonly string[] | undefined): Set<string> {
  for (const path of keep ?? []) assertWritablePath(path);
  return new Set(keep ?? []);
}

function assertWritablePath(path: string): void {
  if (typeof path !== 'string' || !isWritablePath(path)) {
    throw new WriteError('invalid-path', `cannot write "${path}"`);
  }
}

/**
 * Characters git strips from either end of a name or email ("crud"):
 * stripping them here as git does keeps "Ada Smith Jr." usable while the
 * identity returned in `CommitResult` is exactly the one recorded.
 */
const CRUD = /^[\s.,:;"'\\]+|[\s.,:;"'\\]+$/g;

function normalizeActor(actor: Actor): Actor {
  const name = actor.name.replace(CRUD, '');
  const email = actor.email.replace(CRUD, '');
  // git would silently drop or mangle these; refuse them instead.
  const bad = /[<>\p{Cc}]/u;
  if (!name || name.length > 200 || bad.test(name)) {
    throw new WriteError('invalid-identity', `invalid name "${actor.name}"`);
  }
  if (
    email.length > 254 ||
    bad.test(email) ||
    /\s/.test(email) ||
    !/^[^@]+@[^@]+$/.test(email)
  ) {
    throw new WriteError('invalid-identity', `invalid email "${actor.email}"`);
  }
  return { name, email };
}

const TRAILER_KEY = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/**
 * The message body: 1 to 65536 characters, no control characters but
 * newline and tab, and no `---` line (where some tools stop reading).
 */
function checkBody(message: string): string {
  const body = message.replace(/\r\n?/g, '\n').trim();
  if (
    !body ||
    body.length > 64 * 1024 ||
    /[^\P{Cc}\n\t]/u.test(body) ||
    /^---/m.test(body)
  ) {
    throw new WriteError(
      'invalid-message',
      'a commit message must be 1 to 65536 characters, without control characters or "---" lines',
    );
  }
  return body;
}

function withTrailers(body: string, trailers: readonly Trailer[]): string {
  for (const t of trailers) {
    if (
      !TRAILER_KEY.test(t.key) ||
      !t.value.trim() ||
      t.value.length > 1000 ||
      /\p{Cc}/u.test(t.value)
    ) {
      throw new WriteError('invalid-trailer', `invalid trailer "${t.key}"`);
    }
  }
  const lines = trailers.map((t) => `${t.key}: ${t.value.trim()}`);
  return lines.length > 0 ? `${body}\n\n${lines.join('\n')}\n` : `${body}\n`;
}

function gitDate(date: Date): string {
  const ms = date.getTime();
  if (!Number.isFinite(ms) || ms < 0) {
    throw new WriteError('invalid-message', 'invalid commit date');
  }
  return `@${Math.floor(ms / 1000)} +0000`;
}

/**
 * A ref lock held by another writer, or a ref created and deleted again
 * meanwhile: transient, worth a bounded retry. Only asked once the refs
 * still hold their expected values and no clashing ref is listed; a retry
 * resends the same compare-and-swap, so it can never overwrite anything.
 */
function isLockError(error: unknown): boolean {
  return (
    error instanceof GitCommandError &&
    !isNameClash(error) &&
    /\.lock': File exists|cannot lock ref/i.test(error.stderr)
  );
}

/**
 * Git refusing a ref that clashes as file and folder with another one.
 * Only asked once the refs still hold their expected values.
 */
function isNameClash(error: unknown): boolean {
  return (
    error instanceof GitCommandError &&
    /exists; cannot create|cannot process '[^']*' and '[^']*' at the same time/i.test(
      error.stderr,
    )
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Every branch and tag by its exact name (`GitWriter.listRefs`). */
type RefListing = Map<
  string,
  {
    oid: string;
    symref: boolean;
    /** Where it is checked out (`%(worktreepath)`), when it is. */
    worktree?: string;
  }
>;

/**
 * Whether a path is there: `absent` only when the file system says so
 * (`ENOENT`); any other failure is `unknown`.
 */
async function presence(
  path: string,
): Promise<'present' | 'absent' | 'unknown'> {
  try {
    await lstat(path);
    return 'present';
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'absent'
      : 'unknown';
  }
}

/** Per git binary: whether it merges (`GitWriter.assertMergeSupport`). */
const mergeSupport = new Map<string, Promise<void>>();

/**
 * `promise`, started now and awaited later: a rejection meanwhile is the
 * later `await`'s to throw, never an unhandled one.
 */
function started<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

type ObjectFormat = 'sha1' | 'sha256';

/** The empty tree's ID in each object format (git knows it without its object). */
const EMPTY_TREE: Record<ObjectFormat, string> = {
  sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
};

/**
 * The objects one operation reads, through one `git cat-file --batch`
 * process (`CatFileBatch`) instead of a process per read. Objects are read
 * by full ID only, never by name, and never peeled: a commit ID names a
 * commit or nothing.
 */
class ObjectReader {
  private knownFormat?: Promise<ObjectFormat>;

  constructor(
    private readonly batch: CatFileBatch,
    /** Asks git for the object format, when no empty tree reads as one. */
    private readonly askFormat: () => Promise<string>,
  ) {}

  close(): void {
    this.batch.close();
  }

  /** The object with this full ID; undefined when there is none. */
  private async read(oid: string): Promise<BatchObject | undefined> {
    if (!COMMIT_ID.test(oid)) return undefined;
    const found = await this.batch.readObject(oid);
    if (found !== undefined && found.id !== oid) {
      throw new GitError(`git cat-file answered ${found.id} for ${oid}`);
    }
    return found;
  }

  /**
   * The repository's object format: the length of a full ID it holds
   * (`known`), else which empty tree it knows.
   */
  format(known?: string): Promise<ObjectFormat> {
    if (known !== undefined && COMMIT_ID.test(known)) {
      return Promise.resolve(known.length === 64 ? 'sha256' : 'sha1');
    }
    this.knownFormat ??= (async () => {
      for (const format of ['sha1', 'sha256'] as const) {
        if ((await this.read(EMPTY_TREE[format]))?.type === 'tree') {
          return format;
        }
      }
      const format = (await this.askFormat()).trim();
      if (format !== 'sha1' && format !== 'sha256') {
        throw new GitError(`unknown object format "${format}"`);
      }
      return format;
    })();
    this.knownFormat.catch(() => {
      this.knownFormat = undefined;
    });
    return this.knownFormat;
  }

  /**
   * The tree of a commit object, or undefined if `oid` is missing or not a
   * commit (a tag or tree is not peeled). Git failures throw.
   */
  async treeOf(oid: string): Promise<string | undefined> {
    const found = await this.read(oid);
    if (found?.type !== 'commit') return undefined;
    const tree = /^tree ([0-9a-f]+)\n/.exec(
      found.content.subarray(0, 80).toString('latin1'),
    );
    if (!tree) throw new GitError(`unexpected commit object ${oid}`);
    return tree[1];
  }

  /** Whether `oid` (a full object ID) names a tree object of the repository. */
  async isTree(oid: string): Promise<boolean> {
    return (await this.read(oid))?.type === 'tree';
  }

  /**
   * Entries of a tree, as `ls-tree` lists them (the mode in six octal
   * digits, the type from it). Names are kept as latin1 (one character
   * per byte), so a name that is not UTF-8 is written back unchanged.
   */
  async tree(oid: string): Promise<TreeEntry[]> {
    const found = await this.read(oid);
    if (found?.type !== 'tree') throw new GitError(`no tree ${oid}`);
    return parseTree(found.content, oid.length / 2);
  }

  /** A blob's bytes; a missing blob is a git failure. */
  async blob(oid: string): Promise<Buffer> {
    const found = await this.read(oid);
    if (found?.type !== 'blob') throw new GitError(`no blob ${oid}`);
    return found.content;
  }

  /**
   * The entry at `path` (segments of a path `commit` may write) in the
   * tree of `treeish`, a commit or a tree, as `ls-tree <treeish> <path>`
   * gives it; undefined for none.
   */
  async entryAt(treeish: string, path: string): Promise<TreeEntry | undefined> {
    const found = await this.read(treeish);
    const root: string | undefined =
      found?.type === 'tree'
        ? treeish
        : found?.type === 'commit'
          ? await this.treeOf(treeish)
          : undefined;
    if (root === undefined) throw new GitError(`no tree or commit ${treeish}`);
    let tree: string = root;
    const segments = path.split('/');
    for (const [i, segment] of segments.entries()) {
      const name = Buffer.from(segment, 'utf8').toString('latin1');
      const entry: TreeEntry | undefined = (await this.tree(tree)).find(
        (e) => e.name === name,
      );
      if (entry === undefined) return undefined;
      if (i === segments.length - 1) return entry;
      if (entry.type !== 'tree') return undefined;
      tree = entry.oid;
    }
    return undefined;
  }
}

/** The entries of a tree object's content; `hashBytes`: 20 (SHA-1) or 32. */
function parseTree(content: Buffer, hashBytes: number): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < content.length) {
    const space = content.indexOf(0x20, at);
    const nul = space < 0 ? -1 : content.indexOf(0, space);
    if (space < 0 || nul < 0 || nul + 1 + hashBytes > content.length) {
      throw new GitError('unexpected tree object');
    }
    const raw = content.subarray(at, space).toString('latin1');
    if (!/^[0-7]{1,6}$/.test(raw)) throw new GitError('unexpected tree mode');
    const bits = parseInt(raw, 8);
    const type =
      (bits & 0o170000) === 0o040000
        ? 'tree'
        : (bits & 0o170000) === 0o160000
          ? 'commit'
          : 'blob';
    entries.push({
      mode: bits.toString(8).padStart(6, '0'),
      type,
      oid: content.subarray(nul + 1, nul + 1 + hashBytes).toString('hex'),
      name: content.subarray(space + 1, nul).toString('latin1'),
    });
    at = nul + 1 + hashBytes;
  }
  return entries;
}

/** Pack object types (`unpack-objects`). */
const PACK_TYPE = { commit: 1, tree: 2, blob: 3, tag: 4 } as const;

/**
 * Blobs and trees an operation makes, by ID, hashed here as git hashes
 * them (`<type> <size>\0<content>`), and written together
 * (`GitWriter.writeObjects`) once the operation knows what it writes.
 */
class ObjectsToWrite {
  private readonly objects = new Map<
    string,
    { type: 'blob' | 'tree' | 'commit'; content: Buffer }
  >();

  constructor(readonly format: ObjectFormat) {}

  get size(): number {
    return this.objects.size;
  }

  blob(content: Buffer): string {
    return this.add('blob', content);
  }

  /**
   * A tree of `entries` (as `mktree` makes it: sorted as git sorts them, a
   * folder's name as if it ended in `/`, modes without leading zeros).
   */
  tree(entries: readonly TreeEntry[]): string {
    const key = (e: TreeEntry) => (e.type === 'tree' ? `${e.name}/` : e.name);
    const sorted = [...entries].sort((a, b) =>
      key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0,
    );
    const content = Buffer.concat(
      sorted.flatMap((e) => [
        Buffer.from(`${parseInt(e.mode, 8).toString(8)} ${e.name}\0`, 'latin1'),
        Buffer.from(e.oid, 'hex'),
      ]),
    );
    return this.add('tree', content);
  }

  /**
   * A commit object, byte for byte as `git commit-tree --no-gpg-sign -F -`
   * makes it from the same tree, parents, identities (as `normalizeActor`
   * gave them: git would strip nothing more) and `gitDate`, its message
   * taken as given. The identities hold no `<`, `>` or control character,
   * so no header can be added through them.
   */
  commit(c: {
    tree: string;
    parents: readonly string[];
    message: string;
    author: Actor;
    committer: Actor;
    date: string;
  }): string {
    const when = c.date.replace(/^@/, '');
    const content =
      `tree ${c.tree}\n` +
      c.parents.map((p) => `parent ${p}\n`).join('') +
      `author ${c.author.name} <${c.author.email}> ${when}\n` +
      `committer ${c.committer.name} <${c.committer.email}> ${when}\n` +
      `\n${c.message}`;
    return this.add('commit', Buffer.from(content, 'utf8'));
  }

  /**
   * A pack of every object (version 2, none deltified), for
   * `unpack-objects`, made as it is read: one object deflated at a time,
   * the checksum hashed along the way, so a large write is never held
   * twice more in memory.
   */
  async *pack(): AsyncGenerator<Buffer> {
    const checksum = createHash(this.format);
    const emit = (bytes: Buffer) => {
      checksum.update(bytes);
      return bytes;
    };
    const header = Buffer.alloc(12);
    header.write('PACK', 0, 'latin1');
    header.writeUInt32BE(2, 4);
    header.writeUInt32BE(this.objects.size, 8);
    yield emit(header);
    for (const { type, content } of this.objects.values()) {
      let size = content.length;
      const head = [(PACK_TYPE[type] << 4) | (size & 0x0f)];
      size = Math.floor(size / 16);
      while (size > 0) {
        head[head.length - 1] = (head[head.length - 1] as number) | 0x80;
        head.push(size & 0x7f);
        size = Math.floor(size / 128);
      }
      yield emit(Buffer.from(head));
      yield emit(await deflateAsync(content, { level: 1 }));
    }
    yield checksum.digest();
  }

  private add(type: 'blob' | 'tree' | 'commit', content: Buffer): string {
    const oid = createHash(this.format)
      .update(`${type} ${content.length}\0`, 'latin1')
      .update(content)
      .digest('hex');
    this.objects.set(oid, { type, content });
    return oid;
  }
}
