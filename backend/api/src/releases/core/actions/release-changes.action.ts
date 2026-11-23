import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import {
  NotFoundError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import {
  paginate,
  type PageRequest,
  type Paginated,
} from '../../../base/core/paging.js';
import { Recent } from '../../../base/core/recent.js';
import { ChangeSetBranches } from '../../../change-sets/core/change-set-branches.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import type { Release, ReleaseFilter } from '../release.js';
import {
  changedManuals,
  changesFor,
  RELEASE_READER,
  type ReleaseChange,
  type ReleaseDiff,
  releaseDiff,
  fromStoredDiff,
  storedDiff,
  TOO_MANY_CHANGES,
} from '../release-changes.js';
import { ReleaseDiffStore } from '../release-diff-store.js';
import { MAX_REVIEWED_PATHS } from '../../../change-sets/core/review-scope.js';
import { MaintenanceLineStore } from '../maintenance-line-store.js';
import { ReleaseStore } from '../release-store.js';

/**
 * How many release diffs (per pair of releases, as `RELEASE_READER` sees
 * them) are kept: more than `CHANGELOG_SCANNED`, so a filtered changelog
 * works each out once, whoever asks.
 */
export const DIFFS_KEPT = 1_024;

/**
 * The most releases `GET /changelog` looks through when it filters by
 * manual or language (the newest matching the other filters).
 */
export const CHANGELOG_SCANNED = 200;

/** How many releases' changes are worked out at once. */
const AT_ONCE = 4;

/** Commits one actor has opened in one request, by commit ID. */
type Opened = Map<string, Promise<ReadableContent>>;

/** What a release is diffed by. */
export type DiffedRelease = Pick<
  Release,
  'id' | 'product' | 'commit' | 'publishedAt'
>;

/** A release's changes and the release they are counted from. */
export interface ReleaseChangeSet {
  readonly changes: readonly ReleaseChange[];
  /** The product's previous release; null for its first. */
  readonly previous: Release | null;
}

/**
 * What releases change (#138). The diff of a pair of releases is worked
 * out from Git once, as `RELEASE_READER` (everything) sees it
 * (`releaseDiff`), and kept: in the database (`ReleaseDiffStore`, #478),
 * so a restart does not work it out again, and in memory (`DIFFS_KEPT`; a
 * pair of commits never changes). What one reader sees of it is filtered
 * from that (`changesFor`), reading no module again. Checks no policy: the
 * actions below (and `CreateReleaseAction`) do.
 */
@Injectable()
export class ReleaseChangeReader {
  readonly #diffs = new Recent<ReleaseDiff | typeof TOO_MANY_CHANGES>(
    DIFFS_KEPT,
  );
  /** Per diff and what the reader sees on both sides: their part of it. */
  readonly #seen = new Recent<readonly ReleaseChange[]>(DIFFS_KEPT);

  constructor(
    private readonly store: ReleaseStore,
    private readonly openSnapshot: OpenSnapshotAction,
    private readonly branches: ChangeSetBranches,
    private readonly lines: MaintenanceLineStore,
    private readonly kept: ReleaseDiffStore,
  ) {}

  /**
   * The changes of `release` against the product's previous release that
   * is not withdrawn (`previousOf`), as `actor` reads both tags' commits
   * (released content: `content.read`). `opened`: the commits `actor`
   * has opened so far in one request, shared by the releases it reads (a
   * release's commit is the next one's previous), so each is opened once.
   */
  async of(
    actor: Actor,
    release: DiffedRelease,
    opened: Opened = new Map(),
  ): Promise<ReleaseChangeSet> {
    const previous = (await this.previousOf(release)) ?? null;
    const changes = await this.between(
      actor,
      release.commit,
      previous?.commit,
      opened,
    );
    return { changes, previous };
  }

  /**
   * The changes of `release` against `base`, any earlier release (#497: planning compares a
   * release with the nearest one already planned, before or after it), as `actor` reads both
   * commits. Kept as every pair is.
   */
  against(
    actor: Actor,
    release: Pick<Release, 'commit'>,
    base: Pick<Release, 'commit'>,
  ): Promise<readonly ReleaseChange[]> {
    return this.between(actor, release.commit, base.commit, new Map());
  }

  /**
   * The release `release`'s changes are counted from (#60): for one cut
   * from a maintenance line, the line's newest release before it that is
   * not withdrawn, else the line's base release (or, withdrawn, what that
   * one counts from); for one of `main`, `main`'s newest before it, never
   * a line's. Undefined for a product's first.
   */
  async previousOf(
    release: Pick<Release, 'id' | 'product' | 'publishedAt'>,
  ): Promise<Release | undefined> {
    const line = await this.lines.lineOfRelease(release.id);
    if (!line) return this.store.previous(release, { line: null });
    const onLine = await this.store.previous(release, { line: line.id });
    if (onLine) return onLine;
    const base = await this.store.find(line.baseRelease);
    if (!base) return undefined;
    // Each step goes to an older release, so this ends.
    return base.withdrawal ? this.previousOf(base) : base;
  }

  /**
   * Every manual, in each language, as `actor` reads the release's commit,
   * as `added`: what a product's first release lists.
   */
  everyManual(
    actor: Actor,
    release: DiffedRelease,
  ): Promise<readonly ReleaseChange[]> {
    return this.between(actor, release.commit, undefined, new Map());
  }

  private async between(
    actor: Actor,
    commit: string,
    previous: string | undefined,
    opened: Opened,
  ): Promise<readonly ReleaseChange[]> {
    const open = (at: string) => {
      let found = opened.get(at);
      if (!found) {
        found = this.open(actor, at);
        opened.set(at, found);
      }
      return found;
    };
    const [head, base] = await Promise.all([
      open(commit),
      previous === undefined ? undefined : open(previous),
    ]);
    const pair = `${previous ?? ''}|${commit}`;
    const diff = await this.#diffs.get(pair, () =>
      this.diffOf(commit, previous),
    );
    if (diff === TOO_MANY_CHANGES) {
      throw new UnprocessableError(
        TOO_MANY_CHANGES,
        `More than ${MAX_REVIEWED_PATHS} files changed between the two releases.`,
        { max: MAX_REVIEWED_PATHS },
      );
    }
    const key = [pair, head.readingKey, base?.readingKey ?? '']
      .map((part) => part.replaceAll('|', '||'))
      .join('|');
    // One who sees everything on both sides sees all of the diff.
    const everything =
      head.seesEverything() && (base === undefined || base.seesEverything());
    return this.#seen.get(key, () => changesFor(diff, head, base, everything));
  }

  /**
   * The diff of `commit` against `previous`: the kept one
   * (`ReleaseDiffStore`), else worked out from Git as `RELEASE_READER`
   * reads both and kept. Both are opened only then.
   */
  private async diffOf(
    commit: string,
    previous: string | undefined,
  ): Promise<ReleaseDiff | typeof TOO_MANY_CHANGES> {
    const kept = await this.kept.find(previous, commit);
    if (kept !== undefined) return fromStoredDiff(kept);
    const [fullHead, fullBase] = await Promise.all([
      this.open(RELEASE_READER, commit),
      previous === undefined ? undefined : this.open(RELEASE_READER, previous),
    ]);
    const diff = await releaseDiff(this.branches, fullHead, fullBase);
    await this.kept.keep(previous, commit, storedDiff(diff));
    return diff;
  }

  private async open(actor: Actor, commit: string): Promise<ReadableContent> {
    const content = await this.openSnapshot.handle({ actor, ref: commit });
    // A commit ID never names a branch or tag of the same name here.
    if (content.commit !== commit) {
      throw new NotFoundError(`No commit "${commit}".`);
    }
    return content;
  }
}

/** One page of a release's changes, and the release they are counted from. */
export interface ReleaseChangesPage extends Paginated<ReleaseChange> {
  readonly previous: Release | null;
}

/**
 * `GET /releases/:id/changes`: one `ReleaseChange` per manual and
 * language that changed since the product's
 * previous release (not withdrawn), as the reader sees both (a manual or
 * module outside their scope is neither listed nor counted); every manual
 * is `added` for a product's first release. Paged after filtering.
 */
@Injectable()
export class ListReleaseChangesAction extends ActorAction<
  { actor: Actor; id: string; page: PageRequest },
  ReleaseChangesPage
> {
  readonly policy = 'content.read';

  constructor(
    private readonly store: ReleaseStore,
    private readonly reader: ReleaseChangeReader,
  ) {
    super();
  }

  protected async run({
    actor,
    id,
    page,
  }: {
    actor: Actor;
    id: string;
    page: PageRequest;
  }): Promise<ReleaseChangesPage> {
    const release = await this.store.find(id);
    if (!release) throw new NotFoundError(`No release "${id}".`);
    const { changes, previous } = await this.reader.of(actor, release);
    return { ...paginate(changes, page), previous };
  }
}

/** Which releases the changelog lists; every field optional. */
export interface ChangelogFilter extends ReleaseFilter {
  /** Only releases that changed this manual (as the reader sees it). */
  readonly manual?: string;
  /** Only releases that changed a manual in this language. */
  readonly lang?: string;
}

/** A release in the changelog, with how many manuals it changed. */
export interface ChangelogEntry {
  readonly release: Release;
  /**
   * The manuals it changed as the reader sees them; null when more files
   * changed than are compared (`too-many-changes`).
   */
  readonly changedManuals: number | null;
}

/** One page of the changelog. */
export interface ChangelogPage extends Paginated<ChangelogEntry> {
  /** More releases matched than `CHANGELOG_SCANNED`: only the newest were looked through. */
  readonly truncated: boolean;
}

/**
 * `GET /changelog` (#138): releases newest first, withdrawn ones too
 * (marked), each with its notes and the number of manuals it changed as
 * the reader sees them. Filtering by manual or language keeps the releases
 * that changed it as the reader sees them, filtered before paging (so
 * neither the list nor the total tells of a manual outside their scope);
 * that is worked out from Git, so only the `CHANGELOG_SCANNED` newest
 * releases are looked through then.
 */
@Injectable()
export class ListChangelogAction extends ActorAction<
  { actor: Actor; filter: ChangelogFilter; page: PageRequest },
  ChangelogPage
> {
  readonly policy = 'content.read';

  constructor(
    private readonly store: ReleaseStore,
    private readonly reader: ReleaseChangeReader,
  ) {
    super();
  }

  protected async run({
    actor,
    filter,
    page,
  }: {
    actor: Actor;
    filter: ChangelogFilter;
    page: PageRequest;
  }): Promise<ChangelogPage> {
    const { manual, lang, ...releases } = filter;
    const opened: Opened = new Map();
    if (manual === undefined && lang === undefined) {
      const found = await this.store.list(releases, page);
      const items = await inBatches(found.items, async (release) => {
        const changes = await this.changesOf(actor, release, opened);
        return {
          release,
          changedManuals: changes ? changedManuals(changes).length : null,
        };
      });
      return { total: found.total, items, truncated: false };
    }
    const scanned = await this.store.list(releases, {
      number: 1,
      size: CHANGELOG_SCANNED,
    });
    const entries = await inBatches(scanned.items, async (release) => {
      const changes = await this.changesOf(actor, release, opened);
      const matching = changes?.some(
        (c) =>
          (manual === undefined || c.manualId === manual) &&
          (lang === undefined || c.lang === lang),
      );
      // Too large to compare: listed (it may have changed it), uncounted.
      if (!changes) return { release, changedManuals: null };
      return matching
        ? { release, changedManuals: changedManuals(changes).length }
        : undefined;
    });
    const matching = entries.filter((e) => e !== undefined);
    return {
      ...paginate(matching, page),
      truncated: scanned.total > CHANGELOG_SCANNED,
    };
  }

  /** The release's changes; undefined when too many files changed to compare. */
  private async changesOf(
    actor: Actor,
    release: Release,
    opened: Opened,
  ): Promise<readonly ReleaseChange[] | undefined> {
    try {
      return (await this.reader.of(actor, release, opened)).changes;
    } catch (error) {
      if (
        error instanceof UnprocessableError &&
        error.code === 'too-many-changes'
      ) {
        return undefined;
      }
      throw error;
    }
  }
}

/** `map` over `items`, `AT_ONCE` at a time, in order. */
async function inBatches<T, R>(
  items: readonly T[],
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += AT_ONCE) {
    out.push(...(await Promise.all(items.slice(i, i + AT_ONCE).map(map))));
  }
  return out;
}
