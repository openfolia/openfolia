import { Injectable } from '@nestjs/common';
import { UnavailableError } from '../../base/core/errors.js';
import {
  ContentRepository,
  type ModuleFile,
} from '../../content/core/content.repository.js';

/** What the index holds of some commits, read in one snapshot. */
export interface IndexedReferences {
  /** Those of the commits asked for that are indexed. */
  readonly indexed: ReadonlySet<string>;
}

/**
 * Port: the kept index of where files are used (#476), per commit the file
 * hashes its module files mention. Derived from Git alone (Postgres:
 * `DrizzleAssetReferenceStore`); a commit's hashes never change.
 */
export abstract class AssetReferenceStore {
  /**
   * Of `commits`, those indexed, and every hash any of them mentions, each
   * once: read in one snapshot, so a commit read as indexed has all its
   * hashes in the answer.
   */
  abstract referencedAt(
    commits: readonly string[],
  ): Promise<IndexedReferences & { readonly hashes: ReadonlySet<string> }>;

  /**
   * Of `commits`, those indexed, and per hash of `hashes` mentioned there
   * the indexed commits among `commits` mentioning it: in one snapshot.
   */
  abstract mentioning(
    hashes: readonly string[],
    commits: readonly string[],
  ): Promise<
    IndexedReferences & {
      readonly commits: ReadonlyMap<string, readonly string[]>;
    }
  >;

  /**
   * Keeps `hashes` as what `commit` mentions (a commit kept already stays
   * as it is: a commit never changes), and drops the kept commits not in
   * `keep` that were built more than `PRUNE_AFTER_MS` ago.
   */
  abstract put(
    commit: string,
    hashes: readonly string[],
    keep: readonly string[],
  ): Promise<void>;

  /** Drops the whole index (`index-rebuild`). */
  abstract clear(): Promise<void>;
}

/**
 * How long a commit no ref points to any more stays indexed: long past
 * any request that read the refs while one did (and a request finding one
 * gone builds it again, so dropping one is never wrong, only work).
 */
export const PRUNE_AFTER_MS = 60 * 60 * 1000;

/** How many module file revisions' hashes are kept in memory. */
const REVISIONS_KEPT = 100_000;

/** How many module files are read at once. */
const READ_AT_ONCE = 8;

/** How many commits are built at once. */
const BUILD_AT_ONCE = 4;

/** How often a read finds a commit it asked for missing before it gives up. */
const ATTEMPTS = 3;

const REFERENCE = /sha256:([0-9a-f]{64})/g;

const NONE: readonly string[] = Object.freeze([]);

/**
 * Where files are used (#476): per commit, every `sha256:<hash>` its module
 * files, page designs and manifests (#394) mention, read as text rather than parsed (so a file that cannot be
 * parsed still keeps what it mentions), kept in Postgres
 * (`AssetReferenceStore`) so a request reads it instead of every module file
 * of every ref. A commit is indexed when it is first asked for (after a save
 * point, a merge, a release, an import's commit or a push alike), from the
 * module files that changed: each file revision's hashes are kept in memory
 * by its Git blob ID, so a new commit reads only the files no indexed commit
 * of this process had. Rebuildable: `rebuild()` drops it and indexes every
 * branch and tag again, with the same result.
 */
@Injectable()
export class AssetReferenceIndex {
  /** Hashes per module file revision (its blob ID), least recently used first. */
  readonly #revisions = new Map<string, readonly string[]>();
  /** Commits being built, shared by their callers. */
  readonly #building = new Map<string, Promise<void>>();
  /** The last answer of `referencedAt`, by its commits: an indexed commit never changes. */
  #last?: { key: string; hashes: ReadonlySet<string> };

  constructor(
    private readonly content: ContentRepository,
    private readonly store: AssetReferenceStore,
  ) {}

  /** Every hash a module file at any of `commits` mentions; builds what is missing. */
  async referencedAt(commits: readonly string[]): Promise<ReadonlySet<string>> {
    const wanted = [...new Set(commits)].sort();
    const key = wanted.join(',');
    if (this.#last?.key === key) return this.#last.hashes;
    const { hashes } = await this.#complete(wanted, () =>
      this.store.referencedAt(wanted),
    );
    this.#last = { key, hashes };
    return hashes;
  }

  /** Per hash of `hashes` mentioned at any of `commits`, those commits; builds what is missing. */
  async mentioning(
    hashes: readonly string[],
    commits: readonly string[],
  ): Promise<ReadonlyMap<string, readonly string[]>> {
    const wanted = [...new Set(commits)];
    if (hashes.length === 0 || wanted.length === 0) return new Map();
    return (
      await this.#complete(wanted, () =>
        this.store.mentioning([...new Set(hashes)], wanted),
      )
    ).commits;
  }

  /** Drops the index and indexes the commit of every branch and tag again; those commits. */
  async rebuild(): Promise<string[]> {
    await this.store.clear();
    this.#last = undefined;
    const refs = await this.content.refs();
    const commits = [
      ...new Set([...refs.branches, ...refs.tags].map((ref) => ref.commit)),
    ];
    await this.#buildAll(commits, commits);
    return commits;
  }

  /** `read()`, after building whatever of `commits` it found missing. */
  async #complete<T extends IndexedReferences>(
    commits: readonly string[],
    read: () => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const found = await read();
      const missing = commits.filter((commit) => !found.indexed.has(commit));
      if (missing.length === 0) return found;
      if (attempt === ATTEMPTS) {
        // Dropped again as soon as built: no answer to rely on.
        throw unreadable();
      }
      await this.#buildAll(missing, commits);
    }
  }

  async #buildAll(
    commits: readonly string[],
    keep: readonly string[],
  ): Promise<void> {
    let next = 0;
    let failed = false;
    const worker = async () => {
      // After a failure the answer is that failure: nothing more is built.
      while (next < commits.length && !failed) {
        try {
          await this.#build(commits[next++] as string, keep);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(BUILD_AT_ONCE, commits.length) }, worker),
    );
  }

  /** Indexes `commit` (callers asking at once share one build). */
  #build(commit: string, keep: readonly string[]): Promise<void> {
    let building = this.#building.get(commit);
    if (!building) {
      building = this.#collect(commit)
        .then((hashes) => this.store.put(commit, hashes, keep))
        .finally(() => this.#building.delete(commit));
      this.#building.set(commit, building);
    }
    return building;
  }

  /** Every hash the module files, page designs and manuals at `commit` mention, each once, sorted. */
  async #collect(commit: string): Promise<string[]> {
    const snapshot = await this.content.at(commit);
    if (!snapshot) {
      // A ref just listed names it: gone meanwhile is no answer to rely on.
      throw unreadable();
    }
    const files = await snapshot.modules();
    const found = new Set<string>();
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const file = files[next++] as ModuleFile;
        const revision = await snapshot.moduleRevision(file.id, file.lang);
        let hashes = revision === undefined ? undefined : this.#known(revision);
        if (hashes === undefined) {
          const bytes = await snapshot.file(
            `modules/${file.lang}/${file.id}.adoc`,
          );
          // Listed but not readable: never kept as mentioning nothing.
          if (!bytes) throw unreadable();
          hashes = mentioned(Buffer.from(bytes).toString('utf8'));
          if (revision !== undefined) this.#remember(revision, hashes);
        }
        for (const hash of hashes) found.add(hash);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(READ_AT_ONCE, files.length) }, worker),
    );
    // The page designs (#390) and the manuals (#394, a cover image): few, read whole; a logo,
    // a font or a cover image is as used as an image.
    const whole = [
      ...(await snapshot.pageDesigns()).map((id) => `design/${id}.yaml`),
      ...(await snapshot.manifests()).map((id) => `manuals/${id}.yaml`),
    ];
    for (const path of whole) {
      const bytes = await snapshot.file(path);
      if (!bytes) throw unreadable();
      for (const hash of mentioned(Buffer.from(bytes).toString('utf8'))) {
        found.add(hash);
      }
    }
    return [...found].sort();
  }

  #known(revision: string): readonly string[] | undefined {
    const hashes = this.#revisions.get(revision);
    if (hashes !== undefined) {
      // Most recently used last.
      this.#revisions.delete(revision);
      this.#revisions.set(revision, hashes);
    }
    return hashes;
  }

  #remember(revision: string, hashes: readonly string[]): void {
    this.#revisions.set(revision, hashes);
    if (this.#revisions.size > REVISIONS_KEPT) {
      const oldest = this.#revisions.keys().next().value;
      if (oldest !== undefined) this.#revisions.delete(oldest);
    }
  }
}

function unreadable(): UnavailableError {
  return new UnavailableError(
    'content-unavailable',
    'The content changed while its references were read; try again.',
    1,
  );
}

/** The hashes a module file's text mentions, each once. */
function mentioned(text: string): readonly string[] {
  const hashes = new Set<string>();
  for (const [, hash] of text.matchAll(REFERENCE)) {
    if (hash) hashes.add(hash);
  }
  return hashes.size === 0 ? NONE : Object.freeze([...hashes]);
}
