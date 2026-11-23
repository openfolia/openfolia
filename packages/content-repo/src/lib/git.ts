import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Lru } from './lru.js';

const run = promisify(execFile);

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

export interface RefInfo {
  name: string;
  /** The commit the ref points to (tags are peeled). */
  commit: string;
}

const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** An annotated tag as recorded (`GitRepo.tag`). */
export interface TagInfo {
  readonly name: string;
  /** The annotated tag object. */
  readonly tag: string;
  /** The commit it points to. */
  readonly commit: string;
  /** The tagger date. */
  readonly taggedAt: Date;
  /** Its message without the trailers, trimmed. */
  readonly message: string;
  /** The trailers of its message (`Key: value`), in order. */
  readonly trailers: readonly { key: string; value: string }[];
}

/** A commit in a first-parent history (`GitRepo.history`). */
export interface HistoryEntry {
  readonly commit: string;
  /** Its first parent; undefined for a root commit. */
  readonly parent?: string;
  /** How many parents it has: 0 for a root commit, 2 or more for a merge. */
  readonly parents: number;
  /** Its tree. */
  readonly tree: string;
  /** Its author's email address, as recorded. */
  readonly authorEmail: string;
  /** The trailers of its message, in order. */
  readonly trailers: readonly { key: string; value: string }[];
}

/**
 * A commit on a first-parent line that changed one file, compared with its
 * first parent (`GitRepo.pathHistory`).
 */
export interface PathVersion {
  readonly commit: string;
  /** Its first parent; undefined for a root commit. */
  readonly parent?: string;
  /** How many parents it has: 2 or more for a merge. */
  readonly parents: number;
  /** When it was committed, as ISO 8601 with the committer's offset. */
  readonly committedAt: string;
  /** Its author's email address, as recorded. */
  readonly authorEmail: string;
  /** Its message without the trailers paragraph. */
  readonly message: string;
  /** The trailers of its message, in order. */
  readonly trailers: readonly { key: string; value: string }[];
  /** The file's blob ID after the commit; undefined when it deleted the file. */
  readonly blob?: string;
}

/** The versions of one file on a first-parent line (`GitRepo.pathHistory`). */
export interface PathHistory {
  /** Newest first. */
  readonly versions: readonly PathVersion[];
  /** Whether the line is longer than the commits looked at. */
  readonly truncated: boolean;
  /**
   * When truncated: the file's blob ID at the newest commit not looked at
   * (what the oldest version changed), undefined when it had no file there.
   */
  readonly before?: string;
}

/** A file deleted on a first-parent line (`GitRepo.deletedFiles`). */
export interface DeletedFile {
  readonly path: string;
  /** Its blob ID before the deletion: the file as it last was. */
  readonly blob: string;
  /** The commit that deleted it (its newest deletion, compared with its first parent). */
  readonly commit: string;
  /** When that commit was committed, as ISO 8601 with the committer's offset. */
  readonly committedAt: string;
}

/** The files deleted below a folder on a first-parent line (`GitRepo.deletedFiles`). */
export interface DeletedFiles {
  /** Newest deletion first; each path once. */
  readonly files: readonly DeletedFile[];
  /** Whether the line is longer than the commits looked at. */
  readonly truncated: boolean;
}

/**
 * How many bytes a `GitRepo`'s indexes of the repository take at most by default
 * (`GitRepoOptions.indexCacheBytes`): 32 MiB.
 */
export const DEFAULT_INDEX_CACHE_BYTES = 32 * 1024 * 1024;

/**
 * The share of `indexCacheBytes` each index of a `GitRepo` gets (the module listings of a
 * `ContentRepo` take theirs from the same budget, `MODULE_LISTINGS_SHARE`): together all of it.
 */
export const INDEX_SHARES = {
  /** Blob IDs by `commit:path` (`knownFileId`). */
  fileIds: 0.3,
  /** Blob IDs of every file below a folder, per commit (`fileIds`). */
  blobIds: 0.25,
  /** The files two commits differ by (`changedPaths`). */
  changes: 0.1,
  /** A file's versions on a first-parent line (`pathHistory`). */
  pathHistories: 0.1,
  /** The files deleted below a folder (`deletedFiles`). */
  deletions: 0.05,
  /** The paths below a folder, per commit (`listFiles`). */
  listings: 0.1,
} as const;

/** The share of `indexCacheBytes` a `ContentRepo`'s module listings take. */
export const MODULE_LISTINGS_SHARE = 0.1;

/** What a kept entry costs besides its strings (the map's entry, the object), in bytes. */
export const ENTRY_BYTES = 64;

/**
 * The bytes a string takes in memory: one per character while all fit in one byte (hex IDs,
 * paths, as V8 keeps them), else two per UTF-16 code unit.
 */
export const stringBytes = (s: string | undefined): number =>
  s === undefined ? 0 : /[\u0100-\uffff]/.test(s) ? 2 * s.length : s.length;

/** What a path history's version costs (`GitRepo.pathHistory`), its message and trailers too. */
function versionBytes(v: PathVersion): number {
  return (
    stringBytes(v.commit) +
    stringBytes(v.parent) +
    stringBytes(v.committedAt) +
    stringBytes(v.authorEmail) +
    stringBytes(v.message) +
    stringBytes(v.blob) +
    v.trailers.reduce(
      (n, t) => n + stringBytes(t.key) + stringBytes(t.value) + ENTRY_BYTES,
      0,
    ) +
    ENTRY_BYTES
  );
}

/**
 * Per repository (its real path): the generation of its refs, raised each time a writer of
 * this process moved them (`refsMoved`). A ref listing in flight is shared only with callers
 * that came while no ref moved since it began (`GitRepo.listRefs`), so a read after a write in
 * this process always sees the write. Bounded (`REF_GENERATIONS_KEPT`, #552): generations come
 * from one counter, and a repository forgotten reads as `refGenerationFloor`, the highest
 * generation forgotten, never lower than its own was, so it never matches a listing begun
 * before its last write; it only shares less.
 */
const refGenerations = new Map<string, number>();

/** How many repositories `refGenerations` keeps; past that, the one written longest ago is forgotten. */
export const REF_GENERATIONS_KEPT = 1_000;

/** The last generation given out (`refsMoved`). */
let lastGeneration = 0;

/** The highest generation of a repository `refGenerations` forgot. */
let refGenerationFloor = 0;

/** The generation of a repository's refs (`refGenerations`). @internal Exported for tests. */
export function refGeneration(dir: string): number {
  return refGenerationOf(repositoryKey(dir));
}

function refGenerationOf(key: string): number {
  return refGenerations.get(key) ?? refGenerationFloor;
}

/** How many repositories `refGenerations` holds. @internal Exported for tests. */
export function refGenerationsKept(): number {
  return refGenerations.size;
}

/** The key of `refGenerations` for a repository folder. */
function repositoryKey(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

/**
 * Called by a writer (`GitWriter`) after it tried to move refs of the
 * repository in `dir`, whether or not they moved: listings already in
 * flight are no longer shared with later callers.
 */
export function refsMoved(dir: string): void {
  const key = repositoryKey(dir);
  // Re-inserted, so the map's order is by last write: the first is the one to forget.
  refGenerations.delete(key);
  refGenerations.set(key, ++lastGeneration);
  if (refGenerations.size > REF_GENERATIONS_KEPT) {
    const [oldest, generation] = refGenerations.entries().next().value as [
      string,
      number,
    ];
    refGenerations.delete(oldest);
    refGenerationFloor = Math.max(refGenerationFloor, generation);
  }
}

/** One ref as `for-each-ref` lists it (`GitRepo.listRefs`). */
interface ListedRef {
  readonly object: string;
  readonly type: string;
  /** What a tag points to, and its type; empty for anything else. */
  readonly peeled: string;
  readonly peeledType: string;
}

/** How many path walks (`GitRepo.pathHistory`) run at once; more wait. */
const PATH_WALKS = 4;

/** The most trailers (each value at most 1,000 characters) a path history keeps of a commit. */
const MAX_TRAILERS = 100;

/** The longest message a path history keeps of a commit (characters). */
const MAX_MESSAGE = 16_384;

const PATH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/**
 * Branch, tag or commit names accepted from callers. Excludes anything git
 * could read as an option or as revision syntax (`~`, `^`, `:`, `@{`, `..`),
 * so a ref names exactly one existing branch, tag or commit.
 */
export function isSafeRef(ref: string): boolean {
  return (
    /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(ref) &&
    ref.length <= 256 &&
    !ref.includes('..') &&
    !ref.includes('//') &&
    !ref.endsWith('/') &&
    !ref.endsWith('.lock')
  );
}

/**
 * Whether `resolveRef` would read a name as a commit ID when no branch or
 * tag has it: all hex, 7 to 64 characters. The writer refuses such branch
 * names, so it never writes a branch the reader could mistake for an ID.
 */
export function readsAsCommitId(name: string): boolean {
  return /^[0-9a-f]{7,64}$/.test(name);
}

export function isSafePath(path: string): boolean {
  return path.split('/').every((s) => PATH_SEGMENT.test(s) && s !== '..');
}

export interface GitRepoOptions {
  /**
   * How many bytes the indexes of the repository kept in memory take at most, together
   * (blob IDs by path and by folder, changed files, path histories, deletions, folder
   * listings; `INDEX_SHARES`), as estimated from their strings. Default
   * `DEFAULT_INDEX_CACHE_BYTES`. File contents are bounded on their own (64 MiB).
   */
  readonly indexCacheBytes?: number;
}

/** The folder of a `commit:dir` key: what an oversized folder index is kept per. */
const folderOf = (key: string) => key.slice(key.indexOf(':') + 1);

/** Weighs a list of paths (`listFiles`) kept under `key`. */
const weighPaths = (paths: readonly string[], key: string) =>
  paths.reduce(
    (n, p) => n + stringBytes(p) + 16,
    stringBytes(key) + ENTRY_BYTES,
  );

/**
 * Read-only access to a Git repository without a working tree: files are
 * read at a commit, never from disk. Content at a commit never changes, so
 * reads are cached, in bounded caches (`GitRepoOptions`).
 */
export class GitRepo {
  private batch?: CatFileBatch;
  private readonly files = new Lru<Buffer | null>(64 * 1024 * 1024, (b) =>
    b ? b.length + 100 : 100,
  );
  private readonly listings: Lru<string[]>;
  /** Blob IDs by `commit:path` (null: no such file there), as reads gave them. */
  private readonly fileIdsByPath: Lru<string | null>;
  /** `ls-tree` listings in flight, shared by their callers. */
  private readonly listingBlobIds = new Map<
    string,
    Promise<ReadonlyMap<string, string>>
  >();
  /** Blob IDs by path, per `commit:dir`. */
  private readonly blobIds: Lru<ReadonlyMap<string, string>>;
  /** Per `head:max:path`; a commit's history never changes. */
  private readonly pathHistories: Lru<PathHistory>;
  /** Path history walks in flight, shared by their callers. */
  private readonly walkingPaths = new Map<string, Promise<PathHistory>>();
  /** Per `head:max:dir` (`deletedFiles`); a commit's history never changes. */
  private readonly deletions: Lru<DeletedFiles>;
  /** Deletion walks in flight, shared by their callers. */
  private readonly walkingDeletions = new Map<string, Promise<DeletedFiles>>();
  /** Per `head:max`: the newest commit past the window (null: none). */
  private readonly windows = new Lru<string | null>(10_000);
  /** Path walks running, and those waiting for one to end (`PATH_WALKS`). */
  private pathWalks = 0;
  /** Commit times by commit, in whole seconds (`committedAt`); cleared past 10,000. */
  private readonly commitTimes = new Map<string, Promise<number>>();
  /**
   * Full commit IDs that named a commit (`abbreviated`): an object never
   * changes and its full ID never becomes ambiguous, so each is looked up
   * once. Cleared past 10,000.
   */
  private readonly commitIds = new Set<string>();
  private readonly waitingWalks: (() => void)[] = [];
  private readonly env: NodeJS.ProcessEnv;
  /** `refGenerations`' key for this repository. */
  private readonly key: string;
  /** Ref listings in flight by kind, each with the generation it began in (`sharedListing`). */
  private readonly refListings = new Map<
    string,
    { readonly generation: number; readonly result: Promise<unknown> }
  >();
  /** `changedPaths` by `from:to`: two commits always differ by the same files. */
  private readonly changes: Lru<readonly { path: string; deleted: boolean }[]>;

  constructor(
    readonly dir: string,
    private readonly gitBinary = 'git',
    options: GitRepoOptions = {},
  ) {
    this.env = gitEnv(dir);
    this.key = repositoryKey(dir);
    const budget = options.indexCacheBytes ?? DEFAULT_INDEX_CACHE_BYTES;
    const share = (name: keyof typeof INDEX_SHARES) =>
      Math.floor(budget * INDEX_SHARES[name]);
    this.fileIdsByPath = new Lru<string | null>(
      share('fileIds'),
      (id, key) =>
        stringBytes(key) + stringBytes(id ?? undefined) + ENTRY_BYTES,
    );
    // A whole folder per entry (`modules/` at a commit, read by every module read): the
    // newest of each folder is kept however large, beside the others.
    this.blobIds = new Lru<ReadonlyMap<string, string>>(
      share('blobIds'),
      (ids, key) => {
        let n = stringBytes(key) + ENTRY_BYTES;
        for (const [path, id] of ids) {
          n += stringBytes(path) + stringBytes(id) + ENTRY_BYTES;
        }
        return n;
      },
      { pinOversized: folderOf },
    );
    this.changes = new Lru(share('changes'), (changes, key) =>
      changes.reduce(
        (n, c) => n + stringBytes(c.path) + ENTRY_BYTES,
        stringBytes(key) + ENTRY_BYTES,
      ),
    );
    this.pathHistories = new Lru<PathHistory>(
      share('pathHistories'),
      (h, key) =>
        h.versions.reduce(
          (n, v) => n + versionBytes(v),
          stringBytes(key) + stringBytes(h.before) + ENTRY_BYTES,
        ),
    );
    this.deletions = new Lru<DeletedFiles>(share('deletions'), (d, key) =>
      d.files.reduce(
        (n, f) =>
          n +
          stringBytes(f.path) +
          stringBytes(f.blob) +
          stringBytes(f.commit) +
          stringBytes(f.committedAt) +
          ENTRY_BYTES,
        stringBytes(key) + ENTRY_BYTES,
      ),
    );
    this.listings = new Lru<string[]>(share('listings'), weighPaths, {
      pinOversized: folderOf,
    });
  }

  /**
   * The bytes each index keeps now and may keep at most (`GitRepoOptions`).
   * @internal For tests and diagnostics.
   */
  indexCacheWeights(): Record<
    keyof typeof INDEX_SHARES,
    { bytes: number; capacity: number; pinned: number }
  > {
    const of = (lru: {
      weight: number;
      capacity: number;
      pinnedWeight: number;
    }) => ({
      bytes: lru.weight,
      capacity: lru.capacity,
      pinned: lru.pinnedWeight,
    });
    return {
      fileIds: of(this.fileIdsByPath),
      blobIds: of(this.blobIds),
      changes: of(this.changes),
      pathHistories: of(this.pathHistories),
      deletions: of(this.deletions),
      listings: of(this.listings),
    };
  }

  /**
   * Every branch and tag by full name (`refs/heads/…`, `refs/tags/…`), as
   * one `for-each-ref` lists them. Callers that come while a listing is
   * in flight share it, unless a writer of this process moved a ref since
   * it began (`refsMoved`): then they get a listing of their own, which
   * sees the write. Nothing is kept once it is done, so a ref moved by
   * another process is seen by the next listing.
   */
  private listRefs(): Promise<ReadonlyMap<string, ListedRef>> {
    return this.sharedListing('refs', () => this.readRefs());
  }

  /**
   * `read()`, shared with the callers of the same `kind` that come while
   * it runs, unless a writer of this process moved a ref since it began
   * (`refsMoved`). Nothing is kept once it is done.
   */
  private sharedListing<T>(kind: string, read: () => Promise<T>): Promise<T> {
    const generation = refGenerationOf(this.key);
    const running = this.refListings.get(kind);
    if (running?.generation === generation) return running.result as Promise<T>;
    const result = read();
    const listing = { generation, result };
    this.refListings.set(kind, listing);
    const done = () => {
      if (this.refListings.get(kind) === listing) this.refListings.delete(kind);
    };
    result.then(done, done);
    return result;
  }

  private async readRefs(): Promise<ReadonlyMap<string, ListedRef>> {
    const { stdout } = await this.git([
      'for-each-ref',
      '--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)',
      'refs/heads',
      'refs/tags',
    ]);
    const refs = new Map<string, ListedRef>();
    for (const line of stdout.split('\n')) {
      const [name = '', object = '', type = '', peeled = '', peeledType = ''] =
        line.split('\0');
      if (name && object) refs.set(name, { object, type, peeled, peeledType });
    }
    return refs;
  }

  /**
   * The commit a branch, tag or commit ID points to, or undefined if there
   * is none. Branch and tag names are looked up by their exact full name,
   * never by git's lookup rules: `<name>` as `refs/heads/<name>`, then
   * `refs/tags/<name>` (so a branch and a tag of the same name always give
   * the branch); `refs/heads/…` and `refs/tags/…` as given. A commit ID,
   * full or abbreviated to at least 7 hex characters, is matched against
   * objects only (never a ref; it must peel to exactly one commit), and
   * `HEAD` resolves as such.
   */
  async resolveRef(ref: string): Promise<string | undefined> {
    return this.resolveIn(ref, () => this.listRefs());
  }

  /**
   * The commits several refs point to, each exactly as `resolveRef` resolves it (undefined
   * where there is none), in the order given, from one ref listing however many names there
   * are (#764: a product's release tags): `refs` are listed once, never once per name. A commit
   * ID still costs what `resolveRef` spends on one.
   */
  async resolveRefs(refs: readonly string[]): Promise<(string | undefined)[]> {
    let listing: Promise<ReadonlyMap<string, ListedRef>> | undefined;
    const list = () => (listing ??= this.listRefs());
    return Promise.all(refs.map((ref) => this.resolveIn(ref, list)));
  }

  /** `resolveRef`, with the refs from `list` (asked only for a branch or tag name). */
  private async resolveIn(
    ref: string,
    list: () => Promise<ReadonlyMap<string, ListedRef>>,
  ): Promise<string | undefined> {
    if (!isSafeRef(ref)) return undefined;
    if (ref === 'HEAD') return this.peelCommit(ref);
    if (COMMIT.test(ref)) return this.abbreviated(ref);
    const id = readsAsCommitId(ref);
    const names =
      ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/')
        ? [ref]
        : [`refs/heads/${ref}`, `refs/tags/${ref}`];
    let found: ReadonlyMap<string, ListedRef>;
    try {
      found = await list();
    } catch (e) {
      throw new GitError(`cannot resolve "${ref}": ${(e as Error).message}`);
    }
    for (const name of names) {
      const listed = found.get(name);
      if (!listed) continue;
      const { object, type, peeled, peeledType } = listed;
      // A commit, or a tag of one: no second git process to peel it.
      if (type === 'commit' && COMMIT.test(object)) return object;
      if (type === 'tag' && peeledType === 'commit' && COMMIT.test(peeled)) {
        return peeled;
      }
      // Anything else (a tag of a tag, of a tree): peeled by its full object
      // ID, which involves no ref lookup at all.
      return this.peelCommit(object);
    }
    // At least 7, as git abbreviates: shorter, almost every hex name of a
    // missing branch would match some object and read an unrelated commit.
    return id ? this.abbreviated(ref) : undefined;
  }

  /**
   * The commit an ID or ID prefix names, if the objects with that prefix
   * peel to exactly one commit. Listed with `--disambiguate`, which matches objects only,
   * so an ID never falls back to a ref of the same name (in a SHA-256
   * repository a 40-character ID is a prefix too). The full IDs found are
   * peeled as IDs, without any ref lookup.
   */
  private async abbreviated(prefix: string): Promise<string | undefined> {
    if (this.commitIds.has(prefix)) return prefix;
    let stdout: string;
    try {
      ({ stdout } = await this.git(['rev-parse', `--disambiguate=${prefix}`]));
    } catch (e) {
      throw new GitError(`cannot resolve "${prefix}": ${(e as Error).message}`);
    }
    const ids = stdout.split('\n').filter((l) => COMMIT.test(l));
    // Blobs, trees and tags of a commit sharing the prefix do not make it
    // ambiguous: what counts is the commits the objects peel to.
    const commits = new Set<string>();
    for (const id of ids) {
      const commit = await this.peelCommit(id);
      if (commit) commits.add(commit);
    }
    const found = commits.size === 1 ? [...commits][0] : undefined;
    if (found === prefix) {
      if (this.commitIds.size >= 10_000) this.commitIds.clear();
      this.commitIds.add(prefix);
    }
    return found;
  }

  /** `rev-parse <spec>^{commit}`, or undefined if that is no commit. */
  private async peelCommit(spec: string): Promise<string | undefined> {
    try {
      const { stdout } = await this.git([
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        `${spec}^{commit}`,
      ]);
      return stdout.trim();
    } catch (e) {
      if ((e as { code?: unknown }).code === 1) return undefined;
      throw new GitError(`cannot resolve "${spec}": ${(e as Error).message}`);
    }
  }

  /**
   * The branches and tags, sorted by name (`for-each-ref`'s order), each
   * with the commit it points to (a tag peeled once). Shares a listing in
   * flight as `listRefs` says.
   */
  async refs(): Promise<{ branches: RefInfo[]; tags: RefInfo[] }> {
    const branches: RefInfo[] = [];
    const tags: RefInfo[] = [];
    for (const [ref, { object, peeled }] of await this.listRefs()) {
      if (ref.startsWith('refs/heads/')) {
        branches.push({
          name: ref.slice('refs/heads/'.length),
          commit: object,
        });
      } else if (ref.startsWith('refs/tags/')) {
        tags.push({
          name: ref.slice('refs/tags/'.length),
          commit: peeled || object,
        });
      }
    }
    return { branches, tags };
  }

  /**
   * The full names of the branches and tags whose history contains
   * `commit` (a full commit ID), e.g. to tell whether a branch holds any
   * commit no other ref has. It walks history, so it gives up (rejects)
   * after `timeoutMs`.
   */
  async refsContaining(commit: string, timeoutMs = 30_000): Promise<string[]> {
    if (!COMMIT.test(commit)) throw new GitError(`not a commit ID: ${commit}`);
    const { stdout } = await this.git(
      [
        'for-each-ref',
        '--format=%(refname)',
        `--contains=${commit}`,
        'refs/heads',
        'refs/tags',
      ],
      timeoutMs,
    );
    return stdout.split('\n').filter(Boolean);
  }

  /**
   * Up to `max` commits of `head`'s first-parent history, newest first
   * (`head` itself first), each with its first parent (undefined for a root
   * commit), how many parents it has, its tree and the trailers of its
   * message (`Key: value`, in order). With `excluding` (a full commit
   * ID), the commits in that commit's history are left out: on a branch a
   * commit was merged into, what is left starts at the merge (included)
   * and goes back no further than where the two histories meet. It walks history, so it gives up
   * (rejects) after `timeoutMs`.
   */
  async history(
    head: string,
    max: number,
    options: { readonly excluding?: string; readonly timeoutMs?: number } = {},
  ): Promise<HistoryEntry[]> {
    assertCommit(head);
    if (options.excluding !== undefined) assertCommit(options.excluding);
    if (!Number.isInteger(max) || max < 1) {
      throw new GitError(`invalid count: ${max}`);
    }
    const { stdout } = await this.git(
      [
        'log',
        '--first-parent',
        `--max-count=${max}`,
        '-z',
        '--format=%H%x1f%P%x1f%T%x1f%ae%x1f%(trailers:only,unfold)',
        '--end-of-options',
        head,
        ...(options.excluding !== undefined ? [`^${options.excluding}`] : []),
        '--',
      ],
      options.timeoutMs ?? 30_000,
    );
    return stdout
      .split('\0')
      .filter(Boolean)
      .map((record) => {
        const [
          commit = '',
          parents = '',
          tree = '',
          email = '',
          trailers = '',
        ] = record.split('\x1f');
        const parentIds = parents.trim().split(' ').filter(Boolean);
        return {
          commit: commit.trim(),
          tree: tree.trim(),
          parents: parentIds.length,
          authorEmail: email,
          ...(parentIds[0] !== undefined && { parent: parentIds[0] }),
          trailers: parseTrailers(trailers),
        };
      });
  }

  /**
   * The files that differ between two commits (full IDs), with whether
   * each was deleted in `to`; renames are a deletion and an addition.
   */
  async changedPaths(
    from: string,
    to: string,
  ): Promise<{ path: string; deleted: boolean }[]> {
    assertCommit(from);
    assertCommit(to);
    const key = `${from}:${to}`;
    const cached = this.changes.get(key);
    if (cached) return cached.map((change) => ({ ...change }));
    const { stdout } = await this.git([
      'diff-tree',
      '-r',
      '-z',
      '--no-renames',
      '--name-status',
      '--end-of-options',
      from,
      to,
    ]);
    const fields = stdout.split('\0');
    const changed: { path: string; deleted: boolean }[] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const status = fields[i] ?? '';
      const path = fields[i + 1] ?? '';
      if (status && path) changed.push({ path, deleted: status === 'D' });
    }
    this.changes.set(
      key,
      changed.map((change) => ({ ...change })),
    );
    return changed;
  }

  /**
   * How many commits `commit`'s history holds that `excluding`'s does not
   * (both full commit IDs; `git rev-list --count`), counting no further
   * than `max`: how far a branch is behind another. It walks history, so
   * it gives up (rejects) after `timeoutMs`.
   */
  async countAhead(
    commit: string,
    excluding: string,
    max: number,
    timeoutMs = 30_000,
  ): Promise<number> {
    assertCommit(commit);
    assertCommit(excluding);
    if (!Number.isInteger(max) || max < 1) {
      throw new GitError(`invalid count: ${max}`);
    }
    const { stdout } = await this.git(
      [
        'rev-list',
        '--count',
        `--max-count=${max}`,
        '--end-of-options',
        commit,
        `^${excluding}`,
        '--',
      ],
      timeoutMs,
    );
    const count = Number(stdout.trim());
    if (!Number.isSafeInteger(count)) {
      throw new GitError(`unexpected git rev-list output: "${stdout.trim()}"`);
    }
    return count;
  }

  /**
   * Whether the commit `ancestor` is `commit` or in its history (both full
   * commit IDs). False when `ancestor` is no commit of the repository
   * (unknown, or another kind of object); rejects when `commit` is none.
   */
  async isAncestor(ancestor: string, commit: string): Promise<boolean> {
    assertCommit(ancestor);
    assertCommit(commit);
    if ((await this.peelCommit(ancestor)) !== ancestor) return false;
    try {
      await this.git(['merge-base', '--is-ancestor', ancestor, commit]);
      return true;
    } catch (e) {
      if ((e as { code?: unknown }).code === 1) return false;
      throw new GitError(
        `cannot compare "${ancestor}" with "${commit}": ${(e as Error).message}`,
      );
    }
  }

  /**
   * When `commit` (a full commit ID) was committed, in whole seconds since
   * the epoch (its committer date): what a PDF built from it says it was
   * made at, so the same commit always gives the same bytes (#328).
   * Cached: a commit never changes.
   */
  committedAt(commit: string): Promise<number> {
    assertCommit(commit);
    let known = this.commitTimes.get(commit);
    if (!known) {
      known = this.git(
        ['show', '-s', '--format=%ct', commit, '--'],
        30_000,
      ).then(({ stdout }) => {
        const seconds = Number(stdout.trim());
        if (!Number.isSafeInteger(seconds)) {
          throw new GitError(`no commit time for "${commit}"`);
        }
        return seconds;
      });
      known.catch(() => this.commitTimes.delete(commit));
      if (this.commitTimes.size >= 10_000) this.commitTimes.clear();
      this.commitTimes.set(commit, known);
    }
    return known;
  }

  /**
   * The commits among the newest `max` of `head`'s first-parent history
   * (a full commit ID; `head` itself first) that changed the file at
   * `path`, each compared with its first parent (a merge is listed when it
   * brought a change of the file into this line), newest first, with the
   * file's blob ID after it. `truncated` when the line goes on past `max`
   * commits; `before` then is the file's blob ID at the newest commit not
   * looked at. Cached per head, `max` and path (a commit's history never
   * changes); callers asking for the same at once share one walk. It walks
   * history, so it gives up (rejects) after `timeoutMs` per git command.
   */
  async pathHistory(
    head: string,
    path: string,
    max: number,
    timeoutMs = 30_000,
  ): Promise<PathHistory> {
    assertCommit(head);
    if (!isSafePath(path)) throw new GitError(`invalid path "${path}"`);
    if (!Number.isInteger(max) || max < 1) {
      throw new GitError(`invalid count: ${max}`);
    }
    const key = `${head}:${max}:${path}`;
    const cached = this.pathHistories.get(key);
    if (cached) return cached;
    let walk = this.walkingPaths.get(key);
    if (!walk) {
      walk = this.limited(() =>
        this.walkPath(head, path, max, timeoutMs),
      ).finally(() => this.walkingPaths.delete(key));
      this.walkingPaths.set(key, walk);
    }
    const history = await walk;
    this.pathHistories.set(key, history);
    return history;
  }

  private async walkPath(
    head: string,
    path: string,
    max: number,
    timeoutMs: number,
  ): Promise<PathHistory> {
    const boundary = await this.windowEnd(head, max, timeoutMs);
    // No pathspec magic: the path is exactly that file.
    const pathspec = `:(literal)${path}`;
    const { stdout: raw } = await this.git(
      [
        'log',
        '--first-parent',
        '--diff-merges=first-parent',
        '--no-renames',
        '--raw',
        '--no-abbrev',
        '-z',
        '--format=%x1e%H',
        '--end-of-options',
        head,
        ...(boundary === undefined ? [] : [`^${boundary}`]),
        '--',
        pathspec,
      ],
      timeoutMs,
    );
    // Only object IDs, modes and the path (checked, so no NUL or newline):
    // nothing a commit's author wrote.
    const blobs = new Map<string, string | undefined>();
    for (const record of raw.split('\x1e').filter(Boolean)) {
      const commit = /^[0-9a-f]+/.exec(record)?.[0];
      const change =
        /:[0-7]{6} ([0-7]{6}) [0-9a-f]+ ([0-9a-f]+) ([A-Z])[0-9]*\0([^\0]*)\0/.exec(
          record,
        );
      if (!commit || !change || change[4] !== path) continue;
      blobs.set(commit, change[3] === 'D' ? undefined : change[2]);
    }
    const versions = blobs.size
      ? await this.describe([...blobs.keys()], blobs, timeoutMs)
      : [];
    return {
      versions,
      truncated: boundary !== undefined,
      ...(boundary !== undefined && {
        before: await this.blobAt(boundary, path, timeoutMs),
      }),
    };
  }

  /**
   * The files below `dir` that were deleted among the newest `max` commits
   * of `head`'s first-parent history, each compared with its first parent
   * (so a merge counts when it brought a deletion into that line), and are
   * not there at `head`: each with its newest deletion and its blob before
   * it. Newest deletion first; `truncated` when the line is longer than
   * `max` (a file deleted before the window is not listed). The folder is
   * read literally (no pathspec magic); results are cached per head, `max`
   * and folder.
   */
  async deletedFiles(
    head: string,
    dir: string,
    max: number,
    timeoutMs = 30_000,
  ): Promise<DeletedFiles> {
    assertCommit(head);
    if (!isSafePath(dir)) throw new GitError(`invalid path "${dir}"`);
    if (!Number.isInteger(max) || max < 1) {
      throw new GitError(`invalid count: ${max}`);
    }
    const key = `${head}:${max}:${dir}`;
    const cached = this.deletions.get(key);
    if (cached) return cached;
    let walk = this.walkingDeletions.get(key);
    if (!walk) {
      walk = this.limited(() =>
        this.walkDeletions(head, dir, max, timeoutMs),
      ).finally(() => this.walkingDeletions.delete(key));
      this.walkingDeletions.set(key, walk);
    }
    const found = await walk;
    this.deletions.set(key, found);
    return found;
  }

  private async walkDeletions(
    head: string,
    dir: string,
    max: number,
    timeoutMs: number,
  ): Promise<DeletedFiles> {
    const boundary = await this.windowEnd(head, max, timeoutMs);
    const [{ stdout: raw }, present] = await Promise.all([
      this.git(
        [
          'log',
          '--first-parent',
          '--diff-merges=first-parent',
          '--no-renames',
          '--diff-filter=D',
          '--raw',
          '--no-abbrev',
          '-z',
          '--format=%x1e%H %cI',
          '--end-of-options',
          head,
          ...(boundary === undefined ? [] : [`^${boundary}`]),
          '--',
          `:(literal)${dir}/`,
        ],
        timeoutMs,
      ),
      this.fileIds(head, dir),
    ]);
    // Only object IDs, modes, a date git formats and the paths (each
    // checked): nothing a commit's author wrote. Read token by token (NUL
    // separated, which no path holds): the token after a change is always
    // its path, so a path shaped like a header or a change is never read
    // as one.
    const files = new Map<string, DeletedFile>();
    const tokens = raw.split('\0');
    let commit: string | undefined;
    let committedAt = '';
    for (let i = 0; i < tokens.length; i++) {
      const token = (tokens[i] ?? '').replace(/^\n/, '');
      const header = token.startsWith('\x1e')
        ? /^([0-9a-f]{40,64}) (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d))$/.exec(
            token.slice(1),
          )
        : null;
      if (header) {
        [, commit, committedAt = ''] = header;
        continue;
      }
      const change =
        /^:[0-7]{6} [0-7]{6} ([0-9a-f]{40,64}) [0-9a-f]{40,64} D$/.exec(token);
      if (!change) continue;
      const path = tokens[++i] ?? '';
      const blob = change[1] ?? '';
      if (commit === undefined) continue;
      // The newest deletion of a path comes first; one there again is not deleted.
      if (files.has(path) || present.has(path)) continue;
      if (!path.startsWith(`${dir}/`) || !isSafePath(path)) continue;
      files.set(path, { path, blob, commit, committedAt });
    }
    return { files: [...files.values()], truncated: boundary !== undefined };
  }

  /**
   * The newest commit of `head`'s first-parent line past its newest `max`,
   * or undefined when the line is no longer; cached per head and `max`.
   */
  private async windowEnd(
    head: string,
    max: number,
    timeoutMs: number,
  ): Promise<string | undefined> {
    const key = `${head}:${max}`;
    const cached = this.windows.get(key);
    if (cached !== undefined) return cached ?? undefined;
    const { stdout } = await this.git(
      [
        'rev-list',
        '--first-parent',
        `--max-count=${max + 1}`,
        '--end-of-options',
        head,
        '--',
      ],
      timeoutMs,
    );
    const window = stdout.split('\n').filter(Boolean);
    const end = window.length > max ? window[max] : undefined;
    this.windows.set(key, end ?? null);
    return end;
  }

  /** Runs `work` once fewer than `PATH_WALKS` path walks are running. */
  private async limited<T>(work: () => Promise<T>): Promise<T> {
    // A slot ending is handed to the longest waiter, so none is overtaken.
    if (this.pathWalks < PATH_WALKS) this.pathWalks++;
    else await new Promise<void>((resolve) => this.waitingWalks.push(resolve));
    try {
      return await work();
    } finally {
      const next = this.waitingWalks.shift();
      if (next) next();
      else this.pathWalks--;
    }
  }

  /** The commits, in the order given, with their files' blobs. */
  private async describe(
    commits: readonly string[],
    blobs: ReadonlyMap<string, string | undefined>,
    timeoutMs: number,
  ): Promise<PathVersion[]> {
    const { stdout } = await this.git(
      [
        'log',
        '--no-walk=unsorted',
        '-z',
        '--format=%H%x1f%P%x1f%cI%x1f%ae%x1f%(trailers:only,unfold)%x1f%B',
        '--end-of-options',
        ...commits,
        '--',
      ],
      timeoutMs,
    );
    return stdout
      .split('\0')
      .filter(Boolean)
      .flatMap((record): PathVersion[] => {
        const [
          commit = '',
          parents = '',
          date = '',
          email = '',
          trailers = '',
        ] = record.split('\x1f', 5);
        // The message is the rest, whatever it holds.
        const body = record.split('\x1f').slice(5).join('\x1f');
        const parentIds = parents.trim().split(' ').filter(Boolean);
        const parsed = parseTrailers(trailers);
        // Only the commits asked for: a field a raw commit object could
        // shift (an email holding the separator) never makes up another.
        if (!blobs.has(commit.trim())) return [];
        const blob = blobs.get(commit.trim());
        return [
          {
            commit: commit.trim(),
            parents: parentIds.length,
            ...(parentIds[0] !== undefined && { parent: parentIds[0] }),
            committedAt: date.trim(),
            authorEmail: email,
            message: withoutTrailers(body, parsed.length > 0).slice(
              0,
              MAX_MESSAGE,
            ),
            trailers: parsed
              .slice(0, MAX_TRAILERS)
              .map((t) => ({ key: t.key, value: t.value.slice(0, 1000) })),
            ...(blob !== undefined && { blob }),
          },
        ];
      });
  }

  /** The blob ID of the file at `path` at a commit, or undefined. */
  private async blobAt(
    commit: string,
    path: string,
    timeoutMs: number,
  ): Promise<string | undefined> {
    const { stdout } = await this.git(
      ['ls-tree', '-z', commit, '--', path],
      timeoutMs,
    );
    const m = /^[0-7]+ blob ([0-9a-f]+)\t(.+)$/s.exec(
      stdout.split('\0')[0] ?? '',
    );
    return m && m[2] === path ? m[1] : undefined;
  }

  /** A blob's content by its ID, or undefined when there is no such blob. */
  async readBlob(id: string): Promise<Buffer | undefined> {
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(id)) {
      throw new GitError(`not a blob ID: "${id}"`);
    }
    const key = `blob:${id}`;
    const cached = this.files.get(key);
    if (cached !== undefined) return cached ?? undefined;
    this.batch ??= new CatFileBatch(this.gitBinary, this.dir, this.env);
    const content = (await this.batch.read(id))?.content;
    // A blob missing now may be written later: only contents are kept.
    if (content) this.files.set(key, content);
    return content;
  }

  /** The branch `HEAD` names (e.g. `main`), or undefined when it names none. */
  async headBranch(): Promise<string | undefined> {
    try {
      const { stdout } = await this.git(['symbolic-ref', '-q', 'HEAD']);
      const ref = stdout.trim();
      return ref.startsWith('refs/heads/')
        ? ref.slice('refs/heads/'.length)
        : undefined;
    } catch {
      // Detached: HEAD is a commit, not a branch.
      return undefined;
    }
  }

  /** A file's content at a commit, or undefined if it does not exist there. */
  async readFile(commit: string, path: string): Promise<Buffer | undefined> {
    assertCommit(commit);
    if (!isSafePath(path)) throw new GitError(`invalid path "${path}"`);
    const key = `${commit}:${path}`;
    const cached = this.files.get(key);
    if (cached !== undefined) return cached ?? undefined;
    this.batch ??= new CatFileBatch(this.gitBinary, this.dir, this.env);
    const found = await this.batch.read(key);
    if (found) this.fileIdsByPath.set(key, found.id);
    this.files.set(key, found?.content ?? null);
    return found?.content;
  }

  /**
   * The blob ID of the file at `path` at a commit as far as it is known
   * without asking git (a read of it gave it): a string, `null` when the
   * file is known not to be there, `undefined` when it is not known. For
   * looking up what is cached by blob ID before reading the file again.
   */
  knownFileId(commit: string, path: string): string | null | undefined {
    return this.fileIdsByPath.get(`${commit}:${path}`);
  }

  /**
   * A file at a commit with its blob ID, or undefined if it does not
   * exist there. Its content is not kept (the caller keeps what it makes
   * of it, by the ID); the ID is (`knownFileId`).
   */
  async readFileWithId(
    commit: string,
    path: string,
  ): Promise<{ id: string; content: Buffer } | undefined> {
    assertCommit(commit);
    if (!isSafePath(path)) throw new GitError(`invalid path "${path}"`);
    const key = `${commit}:${path}`;
    if (this.fileIdsByPath.get(key) === null) return undefined;
    this.batch ??= new CatFileBatch(this.gitBinary, this.dir, this.env);
    const found = await this.batch.read(key);
    this.fileIdsByPath.set(key, found?.id ?? null);
    return found && { id: found.id, content: found.content };
  }

  /** Paths of all files below a directory at a commit, recursively. */
  async listFiles(commit: string, dir: string): Promise<string[]> {
    assertCommit(commit);
    if (!isSafePath(dir)) throw new GitError(`invalid path "${dir}"`);
    const key = `${commit}:${dir}`;
    const cached = this.listings.get(key);
    if (cached) return cached;
    const { stdout } = await this.git([
      'ls-tree',
      '-r',
      '-z',
      '--name-only',
      commit,
      '--',
      `${dir}/`,
    ]);
    const files = stdout.split('\0').filter(Boolean);
    this.listings.set(key, files);
    return files;
  }

  /**
   * The blob ID of every file below a directory at a commit, recursively,
   * by path: two commits hold the same file exactly when its IDs are equal.
   */
  async fileIds(
    commit: string,
    dir: string,
  ): Promise<ReadonlyMap<string, string>> {
    assertCommit(commit);
    if (!isSafePath(dir)) throw new GitError(`invalid path "${dir}"`);
    const key = `${commit}:${dir}`;
    const cached = this.blobIds.get(key);
    if (cached) return cached;
    // Callers asking for the same listing at once share one git process.
    // Kept once, by the listing itself: weighing a large folder is not free.
    let listing = this.listingBlobIds.get(key);
    if (!listing) {
      listing = this.listBlobIds(commit, dir)
        .then((ids) => {
          this.blobIds.set(key, ids);
          return ids;
        })
        .finally(() => this.listingBlobIds.delete(key));
      this.listingBlobIds.set(key, listing);
    }
    return listing;
  }

  private async listBlobIds(
    commit: string,
    dir: string,
  ): Promise<ReadonlyMap<string, string>> {
    // `<mode> SP <type> SP <object> TAB <path>`, NUL-terminated, unquoted.
    const { stdout } = await this.git([
      'ls-tree',
      '-r',
      '-z',
      commit,
      '--',
      `${dir}/`,
    ]);
    const ids = new Map<string, string>();
    for (const record of stdout.split('\0')) {
      const m = /^[0-7]+ blob ([0-9a-f]+)\t(.+)$/s.exec(record);
      if (m) ids.set(m[2] as string, m[1] as string);
    }
    return ids;
  }

  /**
   * The regular files below a directory at a commit, recursively, each with its blob ID and size
   * in bytes, by path (#396: a template's folder, weighed before it is read). Symbolic links and
   * submodules are left out: a link's target is never a file of the folder. Not kept: a
   * template is read per rendering of a commit, and the PDF is what is cached.
   */
  async regularFiles(
    commit: string,
    dir: string,
  ): Promise<ReadonlyMap<string, { id: string; size: number }>> {
    assertCommit(commit);
    if (!isSafePath(dir)) throw new GitError(`invalid path "${dir}"`);
    // `<mode> SP <type> SP <object> SP+ <size> TAB <path>`, NUL-terminated, unquoted.
    const { stdout } = await this.git([
      'ls-tree',
      '-r',
      '-l',
      '-z',
      commit,
      '--',
      `${dir}/`,
    ]);
    const files = new Map<string, { id: string; size: number }>();
    for (const record of stdout.split('\0')) {
      const m = /^10(?:0644|0755) blob ([0-9a-f]+) +(\d+)\t(.+)$/s.exec(record);
      if (m) {
        files.set(m[3] as string, { id: m[1] as string, size: Number(m[2]) });
      }
    }
    return files;
  }

  /**
   * The tags, newest first by when each was made (an annotated tag's
   * tagger date, a lightweight one's commit date; ties by name), each with
   * the commit it points to (peeled).
   */
  async tagsNewestFirst(): Promise<RefInfo[]> {
    const tags = await this.sharedListing('tags', () => this.readTags());
    return tags.map((tag) => ({ ...tag }));
  }

  private async readTags(): Promise<RefInfo[]> {
    const { stdout } = await this.git([
      'for-each-ref',
      '--sort=refname',
      '--sort=-creatordate',
      '--format=%(refname)%00%(objectname)%00%(*objectname)',
      'refs/tags',
    ]);
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [ref = '', object = '', peeled = ''] = line.split('\0');
        return {
          name: ref.slice('refs/tags/'.length),
          commit: peeled || object,
        };
      });
  }

  /**
   * The annotated tag named exactly `name` (without `refs/tags/`), pointing
   * to a commit; undefined for no such tag, a lightweight one, a tag of
   * anything but a commit, or a name that is not safe (`isSafeRef`).
   */
  async tag(name: string): Promise<TagInfo | undefined> {
    if (!isSafeRef(name)) return undefined;
    const ref = `refs/tags/${name}`;
    const { stdout } = await this.git([
      'for-each-ref',
      '--format=%(refname)%00%(objecttype)%00%(objectname)%00%(*objecttype)%00%(*objectname)%00%(taggerdate:unix)%00%(trailers:only,unfold)%00%(contents)%00',
      ref,
    ]);
    // A pattern also matches refs below it; none can exist beside a tag of
    // this name (a ref is never a file and a folder at once), but only the
    // exact name is read.
    const [refname, type, tag, peeledType, commit, date, trailers, contents] =
      stdout.split('\0');
    if (
      refname !== ref ||
      type !== 'tag' ||
      peeledType !== 'commit' ||
      tag === undefined ||
      commit === undefined ||
      !COMMIT.test(commit) ||
      !/^\d+$/.test(date ?? '')
    ) {
      return undefined;
    }
    const parsed = parseTrailers(trailers ?? '');
    const message = withoutTrailers(contents ?? '', parsed.length > 0).trim();
    return {
      name,
      tag,
      commit,
      taggedAt: new Date(Number(date) * 1000),
      message,
      trailers: parsed,
    };
  }

  /** Stops the background git process. Reads after this start a new one. */
  close(): void {
    this.batch?.close();
    this.batch = undefined;
  }

  /** Runs git on the repository; `timeoutMs` (0: none) kills it when exceeded. */
  private git(args: string[], timeoutMs = 0) {
    return run(this.gitBinary, ['-C', this.dir, ...args], {
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
      env: this.env,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
  }
}

/**
 * A graft file path that cannot exist on any platform: below a regular
 * file (the Node binary). Git skips it silently; the null device itself
 * would be opened and warned about on every command, and a path in a
 * shared temp folder could be created by someone else.
 */
const NO_GRAFTS = join(process.execPath, 'no-grafts');

/**
 * Environment for git run on `dir`: variables that would point git at
 * another repository, index or object store, or swap objects for others
 * (replace refs, grafts), are dropped or switched off, and the search for
 * a repository stops at `dir` (a folder that is not one fails instead of
 * reaching a repository above it), so `-C dir` alone decides which
 * repository is read or written, and an object ID always means its own
 * content.
 */
export function gitEnv(dir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CEILING_DIRECTORIES: dirname(realPath(resolve(dir))),
    GIT_NO_REPLACE_OBJECTS: '1',
    // Otherwise git reads `info/grafts` in the repository.
    GIT_GRAFT_FILE: NO_GRAFTS,
  };
  for (const key of [
    'GIT_REPLACE_REF_BASE',
    'GIT_SHALLOW_FILE',
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_NAMESPACE',
    'GIT_QUARANTINE_PATH',
  ]) {
    delete env[key];
  }
  return env;
}

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** `%(trailers:only,unfold)`: `Key: value` lines, in order. */
function parseTrailers(text: string): { key: string; value: string }[] {
  return text
    .split('\n')
    .map((line) => /^([A-Za-z0-9-]+):\s?(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ key: m[1] as string, value: m[2] as string }));
}

/**
 * A message (`%B`) without its trailers. Git reads them from its last
 * paragraph (never the subject), where other
 * lines may sit among them: only the trailer lines (`Key: value`, and
 * the lines continuing one) are dropped, and the paragraph with them
 * when nothing else is left of it; everything else is kept.
 */
export function withoutTrailers(body: string, hasTrailers: boolean): string {
  const text = body.replace(/\s+$/, '');
  if (!hasTrailers) return text;
  const lines = text.split('\n');
  // Git reads trailers from the last paragraph (in log output it ignores
  // `---` dividers).
  const end = lines.length;
  let start = end;
  while (start > 0 && (lines[start - 1] ?? '').trim() !== '') start--;
  // The first paragraph is the subject: git reads no trailers there.
  if (start === 0) return text;
  const kept: string[] = [];
  let inTrailer = false;
  for (const line of lines.slice(start, end)) {
    if (/^[A-Za-z0-9-]+\s*:/.test(line)) inTrailer = true;
    else if (!(inTrailer && /^\s/.test(line))) inTrailer = false;
    if (!inTrailer) kept.push(line);
  }
  const before = lines.slice(0, start);
  if (kept.length === 0) {
    while (before.length > 0 && (before.at(-1) ?? '').trim() === '') {
      before.pop();
    }
  }
  return [...before, ...kept].join('\n').replace(/\s+$/, '');
}

function assertCommit(commit: string): void {
  if (!COMMIT.test(commit)) throw new GitError(`not a commit ID: "${commit}"`);
}

/** An object as `git cat-file --batch` gives it. */
export interface BatchObject {
  readonly id: string;
  /** `blob`, `tree`, `commit` or `tag`. */
  readonly type: string;
  readonly content: Buffer;
}

/**
 * One long-running `git cat-file --batch` process: requests are written to
 * its stdin and answered in order on stdout, which avoids starting a
 * process per file.
 */
export class CatFileBatch {
  private proc?: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  /** Chunks not joined to `buffer` yet, and the bytes of both together. */
  private chunks: Buffer[] = [];
  private received = 0;
  /** The bytes `buffer` must hold for the next answer to be complete (0: unknown). */
  private needed = 0;
  private closed = false;
  private pending: {
    resolve: (found: BatchObject | undefined) => void;
    reject: (error: Error) => void;
  }[] = [];

  constructor(
    private readonly gitBinary: string,
    private readonly dir: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  /** The blob `spec` names (`<id>` or `<commit>:<path>`), undefined when it names none. */
  async read(spec: string): Promise<BatchObject | undefined> {
    const found = await this.readObject(spec);
    return found?.type === 'blob' ? found : undefined;
  }

  /**
   * The object `spec` names, of any type and not peeled, undefined when it
   * names none. The process is started on the first request.
   */
  readObject(spec: string): Promise<BatchObject | undefined> {
    if (/[\n\0]/.test(spec)) {
      return Promise.reject(new GitError('invalid object name'));
    }
    if (this.closed) return Promise.reject(new GitError('git process closed'));
    const proc = this.start();
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      proc.stdin.write(`${spec}\n`);
    });
  }

  /** Ends the process; for good: a read after it is refused, never a new process. */
  close(): void {
    this.closed = true;
    const proc = this.proc;
    this.fail(new GitError('git process closed'));
    proc?.kill();
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.proc) return this.proc;
    const proc = spawn(
      this.gitBinary,
      ['-C', this.dir, 'cat-file', '--batch'],
      { env: this.env },
    );
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    proc.stdout.on('data', (d: Buffer) => {
      if (this.proc !== proc) return;
      // A large object comes in many chunks: they are joined once it is all there.
      this.chunks.push(d);
      this.received += d.length;
      if (this.received < this.needed) return;
      this.buffer = Buffer.concat([this.buffer, ...this.chunks]);
      this.chunks = [];
      this.received = this.buffer.length;
      this.needed = 0;
      this.drain();
    });
    const onFailure = (error: Error) => {
      if (this.proc === proc) this.fail(error);
    };
    proc.on('error', onFailure);
    proc.stdin.on('error', onFailure);
    proc.on('close', (code) =>
      onFailure(
        new GitError(`git cat-file exited with ${code}: ${stderr.trim()}`),
      ),
    );
    this.proc = proc;
    return proc;
  }

  /** Rejects everything pending and forgets the process. */
  private fail(error: Error): void {
    const pending = this.pending;
    this.proc = undefined;
    this.pending = [];
    this.buffer = Buffer.alloc(0);
    this.chunks = [];
    this.received = 0;
    this.needed = 0;
    for (const p of pending) p.reject(error);
  }

  private drain(): void {
    while (this.pending.length > 0) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) return;
      const header = this.buffer.subarray(0, newline).toString();
      if (header.endsWith(' missing') || header.endsWith(' ambiguous')) {
        this.buffer = this.buffer.subarray(newline + 1);
        this.received = this.buffer.length;
        this.pending.shift()?.resolve(undefined);
        continue;
      }
      const match = /^([0-9a-f]+) (\S+) (\d+)$/.exec(header);
      if (!match) {
        const proc = this.proc;
        this.fail(new GitError(`unexpected git cat-file output: ${header}`));
        proc?.kill();
        return;
      }
      const end = newline + 1 + Number(match[3]);
      if (this.buffer.length < end + 1) {
        this.needed = end + 1;
        return;
      }
      const content = Buffer.from(this.buffer.subarray(newline + 1, end));
      this.buffer = this.buffer.subarray(end + 1);
      this.received = this.buffer.length;
      this.pending.shift()?.resolve({
        id: match[1] as string,
        type: match[2] as string,
        content,
      });
    }
  }
}
