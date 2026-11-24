import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GitRepo,
  GitWriter,
  isWritablePath,
  MergeConflictError,
  RefConflictError,
  WriteError,
} from '@openfolia/content-repo';
import { ConflictError, UnprocessableError } from '../../base/core/errors.js';
import type { Env } from '../../config/env.js';
import { Sandbox } from '../../sandbox/core/sandbox.js';

/** What a sandbox spends for a commit's root tree and commit object (#826). */
const COMMIT_OVERHEAD_BYTES = 2 * 1024;
/** A tree entry's bytes besides its name: the mode, a space, a NUL and the object ID. */
const TREE_ENTRY_BYTES = 28;
/** A carried author's trailer, at most (`Carried-author: <kind>:<id>`). */
const TRAILER_BYTES = 256;
import {
  BRANCH_PREFIX,
  type ChangeSetAuthor,
  idOfBranch,
} from '../core/change-set.js';
import {
  type BranchCommit,
  type BranchHead,
  type BranchMerge,
  type BranchRefresh,
  ChangeSetBranches,
  MAX_BEHIND,
  MAX_WRITER_COMMITS,
  type MergeConflictPath,
  type RefreshPreview,
} from '../core/change-set-branches.js';
import {
  ACTOR_TRAILER,
  actorOfTrailer,
  APPROVED_BY_TRAILER,
  type BranchChange,
  CARRIED_AUTHOR_TRAILER,
  CHANGE_SET_TRAILER,
  MERGED_BY_TRAILER,
  MERGED_CHANGE_SET_TRAILER,
  UPDATED_BY_TRAILER,
  UPDATED_CHANGE_SET_TRAILER,
} from '../core/commit.js';

/**
 * The most first-parent commits of a merge target searched for a merge
 * commit. The search starts at the target's tip and stops where the merged
 * head's history begins (`history`'s `excluding`), so it covers every
 * commit since the change set started however old the merge, up to this
 * many (a guard against a base whose history never meets the head's).
 */
export const MERGE_SEARCH = 20_000;

/**
 * Write errors a client can cause (with what it sends); any other is a
 * bug or a broken repository, and stays a 500.
 */
const CLIENT_WRITE_ERRORS = new Set([
  'invalid-message',
  // A file where a folder of its name is, or the reverse (a template's files, #396).
  'path-conflict',
  'too-large',
  'too-many-changes',
]);

/**
 * `ChangeSetBranches` over the content repository (`CCMS_CONTENT_DIR`),
 * through `GitWriter`: refs move only by compare-and-swap. It refuses any
 * branch that is not a change set's (`change-sets/<id>`), so no bug in a
 * caller can create or delete another branch through it; the one other
 * branch it moves is a merge's target, and only forward (a merge or a
 * fast-forward on top of what the caller expected). The repository
 * should be bare: the writer refuses to move a branch checked out in a
 * worktree.
 */
@Injectable()
export class GitChangeSetBranches extends ChangeSetBranches {
  private readonly writer: GitWriter;
  private readonly repo: GitRepo;
  private readonly defaultRef: string;

  constructor(
    config: ConfigService<Env, true>,
    private readonly sandbox: Sandbox = Sandbox.OFF,
  ) {
    super();
    const dir = config.get('CCMS_CONTENT_DIR', { infer: true });
    const defaultRef = config.get('CCMS_DEFAULT_REF', { infer: true });
    this.defaultRef = defaultRef;
    this.writer = new GitWriter(dir, {
      protectedBranches: defaultRef === 'HEAD' ? [] : [defaultRef],
    });
    // Runs `git for-each-ref` only; no long-running process to close.
    this.repo = new GitRepo(dir);
  }

  async create(name: string, commit: string): Promise<void> {
    assertChangeSetBranch(name);
    try {
      await this.writer.createBranch(name, commit);
    } catch (error) {
      if (error instanceof RefConflictError) {
        throw new ConflictError(
          'branch-exists',
          `The branch "${name}" exists already.`,
        );
      }
      throw error;
    }
  }

  async deleteIfAt(name: string, expected: string): Promise<boolean> {
    assertChangeSetBranch(name);
    try {
      await this.writer.deleteBranch(name, expected);
      return true;
    } catch (error) {
      if (error instanceof RefConflictError) return false;
      throw error;
    }
  }

  async hasOwnCommits(name: string, commit: string): Promise<boolean> {
    assertChangeSetBranch(name);
    const containing = await this.repo.refsContaining(commit);
    return containing.every((ref) =>
      ref.startsWith(`refs/heads/${BRANCH_PREFIX}`),
    );
  }

  async defaultBase(): Promise<string | undefined> {
    return this.defaultRef === 'HEAD'
      ? this.repo.headBranch()
      : this.defaultRef;
  }

  async prepare(
    name: string,
    request: {
      readonly parent: string;
      readonly changes: readonly BranchChange[];
      readonly message: string;
      readonly author: ChangeSetAuthor;
      readonly changeSetId: string;
      readonly carried?: readonly ChangeSetAuthor[];
    },
  ): Promise<{ tree: string }> {
    assertChangeSetBranch(name);
    // A public sandbox (#826) spends what every commit writes, whichever action makes it (a
    // save point, a rename, a revert, a carry, a translation marked current): the files' bytes
    // and the trees and commit around them.
    if (this.sandbox.on) {
      this.sandbox.spend(await this.commitBytes(request));
    }
    try {
      return await this.writer.prepareCommit({
        branch: name,
        parent: request.parent,
        changes: request.changes.map((c) =>
          'delete' in c
            ? { path: c.path, delete: true as const }
            : { path: c.path, content: c.content },
        ),
        message: request.message,
        author: gitIdentity(request.author),
        trailers: saveTrailers(request),
      });
    } catch (error) {
      if (error instanceof WriteError && CLIENT_WRITE_ERRORS.has(error.code)) {
        throw new UnprocessableError(error.code, error.message);
      }
      throw error;
    }
  }

  /**
   * What a commit of `changes` on `parent` writes, as a public sandbox spends it: the files'
   * bytes, every tree object it rewrites (each folder a change is in, with all its entries at
   * `parent`: about the name and 28 bytes each), the message and the trailers, and
   * `COMMIT_OVERHEAD_BYTES` for the root tree and the rest of the commit. A flat folder of many files costs its full listing on every commit.
   */
  private async commitBytes(request: {
    readonly parent: string;
    readonly changes: readonly BranchChange[];
    readonly message: string;
    readonly carried?: readonly ChangeSetAuthor[];
  }): Promise<number> {
    // The message is the visitor's, up to 10,000 characters; each carried author a trailer.
    let bytes =
      COMMIT_OVERHEAD_BYTES +
      Buffer.byteLength(request.message, 'utf8') +
      (request.carried?.length ?? 0) * TRAILER_BYTES;
    const folders = new Set<string>();
    for (const change of request.changes) {
      if (!('delete' in change))
        bytes += Buffer.byteLength(change.content, 'utf8');
      const parts = change.path.split('/');
      for (let i = 1; i < parts.length; i++)
        folders.add(parts.slice(0, i).join('/'));
      // A new entry adds itself to its folder's tree.
      bytes += TREE_ENTRY_BYTES + (parts.at(-1)?.length ?? 0);
    }
    for (const folder of folders) {
      const entries = new Set(
        (await this.repo.listFiles(request.parent, folder)).map(
          (path) => path.slice(folder.length + 1).split('/')[0] ?? '',
        ),
      );
      for (const entry of entries) bytes += TREE_ENTRY_BYTES + entry.length;
    }
    return bytes;
  }

  async commit(
    name: string,
    request: {
      readonly parent: string;
      readonly tree: string;
      readonly message: string;
      readonly author: ChangeSetAuthor;
      readonly changeSetId: string;
      readonly carried?: readonly ChangeSetAuthor[];
    },
  ): Promise<{ commit: string } | { moved: string | undefined }> {
    assertChangeSetBranch(name);
    try {
      const { commit } = await this.writer.commitPrepared({
        branch: name,
        parent: request.parent,
        tree: request.tree,
        message: request.message,
        author: gitIdentity(request.author),
        trailers: saveTrailers(request),
      });
      return { commit };
    } catch (error) {
      if (error instanceof RefConflictError) return { moved: error.actual };
      if (error instanceof WriteError && CLIENT_WRITE_ERRORS.has(error.code)) {
        throw new UnprocessableError(error.code, error.message);
      }
      throw error;
    }
  }

  async history(
    name: string,
    head: string,
    max: number,
    excluding?: string,
  ): Promise<BranchCommit[]> {
    assertChangeSetBranch(name);
    const entries = await this.repo.history(
      head,
      max,
      excluding === undefined ? {} : { excluding },
    );
    // Trailers and the author are left out on purpose: a pusher writes them.
    return entries.map((entry) => ({
      commit: entry.commit,
      ...(entry.parent !== undefined && { parent: entry.parent }),
      parents: entry.parents,
      tree: entry.tree,
    }));
  }

  async writers(
    name: string,
    head: string,
    excluding: string,
  ): Promise<ChangeSetAuthor[]> {
    assertChangeSetBranch(name);
    const entries = await this.repo.history(head, MAX_WRITER_COMMITS + 1, {
      excluding,
    });
    if (entries.length > MAX_WRITER_COMMITS) {
      throw new ConflictError(
        'too-many-commits',
        `The change set holds more than ${MAX_WRITER_COMMITS} commits: who wrote them cannot be read whole.`,
        { max: MAX_WRITER_COMMITS },
      );
    }
    const found = new Map<string, ChangeSetAuthor>();
    const add = (actor: ChangeSetAuthor) =>
      found.set(actorValue(actor), { kind: actor.kind, id: actor.id });
    for (const entry of entries) {
      // Only a commit naming an actor this adapter would have written as its author: anything
      // else (a push, an import, an update from the base) names nobody.
      const by = entry.trailers.findLast((t) => t.key === ACTOR_TRAILER);
      const named = by === undefined ? undefined : actorOfTrailer(by.value);
      if (!named || gitIdentity(named).email !== entry.authorEmail) continue;
      add(named);
      for (const t of entry.trailers) {
        if (t.key !== CARRIED_AUTHOR_TRAILER) continue;
        const carried = actorOfTrailer(t.value);
        if (carried) add(carried);
      }
    }
    return [...found.values()];
  }

  changedPaths(
    from: string,
    to: string,
  ): Promise<{ path: string; deleted: boolean }[]> {
    return this.repo.changedPaths(from, to);
  }

  mergedFiles(
    expected: string,
    head: string,
    paths: readonly string[],
  ): Promise<ReadonlyMap<string, Uint8Array | null> | 'conflicts'> {
    return this.writer.mergedFiles(expected, head, paths);
  }

  async merge(request: {
    readonly into: string;
    readonly expected: string;
    readonly head: string;
    readonly message: string;
    readonly actor: ChangeSetAuthor;
    readonly changeSetId: string;
    readonly approvedBy?: readonly ChangeSetAuthor[];
    readonly fastForward?: 'allow' | 'never';
  }): Promise<BranchMerge> {
    // Merges go from a change set into its base, never into a change set
    // (nor anything named like one).
    if (request.into.toLowerCase().startsWith(BRANCH_PREFIX)) {
      throw new Error(`"${request.into}" is a change-set branch.`);
    }
    try {
      const result = await this.writer.merge({
        branch: request.into,
        expected: request.expected,
        source: request.head,
        message: request.message,
        author: gitIdentity(request.actor),
        // Approvals are recorded in Git: never a fast-forward then.
        fastForward: request.approvedBy?.length
          ? 'never'
          : (request.fastForward ?? 'allow'),
        // Never `Change-set` and `Actor`, a save point's trailers (recovery
        // matches commit intents, never trailers, and skips merges).
        trailers: [
          { key: MERGED_CHANGE_SET_TRAILER, value: request.changeSetId },
          { key: MERGED_BY_TRAILER, value: actorValue(request.actor) },
          ...(request.approvedBy ?? []).map((a) => ({
            key: APPROVED_BY_TRAILER,
            value: actorValue(a),
          })),
        ],
      });
      return result.kind === 'up-to-date'
        ? { kind: 'up-to-date', commit: result.commit }
        : {
            kind: 'merged',
            commit: result.commit,
            fastForward: result.kind === 'fast-forward',
          };
    } catch (error) {
      if (error instanceof RefConflictError) {
        return { kind: 'moved', head: error.actual };
      }
      if (error instanceof MergeConflictError) {
        return {
          kind: 'conflicts',
          conflicts: error.conflicts.map((c) => ({
            path: c.path,
            kinds: [...c.kinds],
          })),
        };
      }
      if (error instanceof WriteError) {
        if (error.code === 'unrelated-histories') {
          throw new ConflictError(error.code, error.message);
        }
        if (CLIENT_WRITE_ERRORS.has(error.code)) {
          throw new UnprocessableError(error.code, error.message);
        }
      }
      throw error;
    }
  }

  async previewRefresh(request: {
    readonly expected: string;
    readonly base: string;
    readonly keep: readonly string[];
  }): Promise<RefreshPreview> {
    try {
      const preview = await this.writer.previewMerge(
        request.expected,
        request.base,
        request.keep,
      );
      switch (preview.kind) {
        case 'up-to-date':
          return { kind: 'up-to-date' };
        case 'conflicts':
          return { kind: 'conflicts', conflicts: conflictPaths(preview) };
        default:
          return {
            kind: 'clean',
            fastForward: preview.kind === 'fast-forward',
            changed: preview.changed,
          };
      }
    } catch (error) {
      throw mergeWriteError(error);
    }
  }

  async refresh(
    name: string,
    request: {
      readonly expected: string;
      readonly base: string;
      readonly keep: readonly string[];
      readonly message: string;
      readonly actor: ChangeSetAuthor;
      readonly changeSetId: string;
    },
  ): Promise<BranchRefresh> {
    assertChangeSetBranch(name);
    try {
      const result = await this.writer.merge({
        branch: name,
        expected: request.expected,
        source: request.base,
        message: request.message,
        author: gitIdentity(request.actor),
        fastForward: 'allow',
        keep: request.keep,
        trailers: [
          { key: UPDATED_CHANGE_SET_TRAILER, value: request.changeSetId },
          { key: UPDATED_BY_TRAILER, value: actorValue(request.actor) },
        ],
      });
      return result.kind === 'up-to-date'
        ? { kind: 'up-to-date' }
        : {
            kind: 'merged',
            commit: result.commit,
            fastForward: result.kind === 'fast-forward',
          };
    } catch (error) {
      if (error instanceof RefConflictError) {
        return { kind: 'moved', head: error.actual };
      }
      if (error instanceof MergeConflictError) {
        return { kind: 'conflicts', conflicts: conflictPaths(error) };
      }
      throw mergeWriteError(error);
    }
  }

  behind(head: string, base: string): Promise<number> {
    return this.repo.countAhead(base, head, MAX_BEHIND);
  }

  async applyChange(request: {
    readonly from: string;
    readonly to: string;
    readonly onto: string;
    readonly paths: readonly string[];
  }): Promise<{
    files: ReadonlyMap<string, Uint8Array | null>;
    conflicts: MergeConflictPath[];
  }> {
    // A path no commit may write (pushed from outside) is never carried.
    const unsupported = request.paths.filter((p) => !isWritablePath(p));
    const { files, conflicts } = await this.writer.applyChange({
      ...request,
      paths: request.paths.filter((p) => isWritablePath(p)),
    });
    return {
      files,
      conflicts: [
        ...conflicts,
        ...unsupported.map((path) => ({ path, kinds: ['unsupported'] })),
      ],
    };
  }

  async head(name: string): Promise<string | undefined> {
    const { branches } = await this.repo.refs();
    return branches.find((b) => b.name === name)?.commit;
  }

  async contains(into: string, commit: string): Promise<boolean> {
    const containing = await this.repo.refsContaining(commit);
    return containing.includes(`refs/heads/${into}`);
  }

  async mergedInto(
    into: string,
    head: string,
    changeSetId: string,
  ): Promise<
    | { commit: string | undefined; mergedBy: ChangeSetAuthor | undefined }
    | undefined
  > {
    if (!(await this.contains(into, head))) return undefined;
    const tip = await this.head(into);
    if (tip === undefined) return undefined;
    // Only what the base gained since the head: the merge is among them.
    const recent = await this.repo.history(tip, MERGE_SEARCH, {
      excluding: head,
    });
    const found = recent.find(
      (entry) =>
        entry.trailers.findLast((t) => t.key === MERGED_CHANGE_SET_TRAILER)
          ?.value === changeSetId,
    );
    if (!found) return { commit: undefined, mergedBy: undefined };
    const by = found.trailers.findLast((t) => t.key === MERGED_BY_TRAILER);
    const named = by === undefined ? undefined : actorOfTrailer(by.value);
    // Only an actor this adapter would have written as the author.
    const mergedBy =
      named && gitIdentity(named).email === found.authorEmail
        ? named
        : undefined;
    return { commit: found.commit, mergedBy };
  }

  async list(): Promise<BranchHead[]> {
    const { branches } = await this.repo.refs();
    return branches.filter((b) => b.name.startsWith(BRANCH_PREFIX));
  }
}

/**
 * A Git identity for an actor: its ID as the name, and an address in the
 * reserved `.invalid` domain (no mail is ever sent to it), so the commit
 * names who made it without any personal data beyond the ID.
 */
export function gitIdentity(actor: ChangeSetAuthor): {
  name: string;
  email: string;
} {
  const local = actor.id.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 200);
  // Git refuses `<`, `>` and control characters in a name.
  const name = actor.id.replace(/[<>\p{Cc}]/gu, '-').slice(0, 200);
  return { name, email: `${local}@${actor.kind}.openfolia.invalid` };
}

/** A save point's trailers: the change set and the actor, for people reading the history. */
/** An actor as the `Actor` trailer names it: `<kind>/<id>`. */
const actorValue = (a: ChangeSetAuthor) => `${a.kind}/${a.id}`;

function saveTrailers(request: {
  readonly author: ChangeSetAuthor;
  readonly changeSetId: string;
  readonly carried?: readonly ChangeSetAuthor[];
}): { key: string; value: string }[] {
  const own = actorValue(request.author);
  const carried = [...new Set((request.carried ?? []).map(actorValue))].filter(
    (value) => value !== own,
  );
  return [
    { key: CHANGE_SET_TRAILER, value: request.changeSetId },
    ...carried.map((value) => ({ key: CARRIED_AUTHOR_TRAILER, value })),
    // Last: `writers` and recovery read the last `Actor`.
    { key: ACTOR_TRAILER, value: own },
  ];
}

/** A merge's conflicts as the port lists them. */
function conflictPaths(found: {
  readonly conflicts: readonly { path: string; kinds: readonly string[] }[];
}): MergeConflictPath[] {
  return found.conflicts.map((c) => ({ path: c.path, kinds: [...c.kinds] }));
}

/** A write error a client can cause, as a domain error; any other as it is. */
function mergeWriteError(error: unknown): unknown {
  if (error instanceof WriteError) {
    if (error.code === 'unrelated-histories') {
      return new ConflictError(error.code, error.message);
    }
    if (CLIENT_WRITE_ERRORS.has(error.code)) {
      return new UnprocessableError(error.code, error.message);
    }
  }
  return error;
}

function assertChangeSetBranch(name: string): void {
  if (idOfBranch(name) === undefined) {
    throw new Error(`"${name}" is not a change-set branch.`);
  }
}
