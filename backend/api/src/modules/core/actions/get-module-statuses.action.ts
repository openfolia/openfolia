import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Deprecation } from '@openfolia/content-model';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { allows, ANYWHERE } from '../../../access/core/allows.js';
import { readingKey } from '../../../access/core/reading-scope.js';
import {
  InvalidContentError,
  NotFoundError,
} from '../../../base/core/errors.js';
import { Recent } from '../../../base/core/recent.js';
import {
  ChangeSetTouches,
  moduleKey,
  type ModuleKey,
  type TouchingChangeSet,
} from '../../../change-sets/core/change-set-touches.js';
import { readsChangeSets } from '../../../change-sets/core/own-work.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import type { RefInfo } from '../../../content/core/content.repository.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import { ReadableRefs } from '../../../content/core/readable-refs.js';
import { RELEASED_BRANCH } from '../../../content/core/released.js';

/**
 * Whether module statuses name change sets for `actor`: a holder of
 * `content.read.draft` (who reads every change set) or `content.edit` (who
 * may author some, and always sees their own). A consumer of released
 * content (`content.read` alone, as the delivery API's token) learns
 * nothing of drafts, not even that there are none.
 */
export function followsChangeSets(actor: Actor): boolean {
  return readsChangeSets(actor) || allows(actor, 'content.edit', ANYWHERE);
}

/** The most release tags (the newest) looked through for a module. */
export const RELEASES_CHECKED = 50;

/** How many modules' latest releases (per reader and set of releases) are kept. */
export const RELEASES_KEPT = 10_000;

/** Where a module stands, derived from Git; never stored. */
export interface ModuleStatus {
  /**
   * The newest release tag holding the module as the reader may see it
   * there, and whether its file there is the one read (`same`).
   */
  readonly release: {
    readonly tag: string;
    readonly commit: string;
    readonly same: boolean;
  } | null;
  /** The module on `main`, as the reader may see it there, and whether it is the one read. */
  readonly main: { readonly commit: string; readonly same: boolean } | null;
  /**
   * The open change sets changing it that the reader may read, newest
   * first; left out for a reader who neither reads drafts nor edits (a
   * consumer of released content: `followsChangeSets`).
   */
  readonly changeSets?: readonly TouchingChangeSet[];
  /**
   * The module's deprecation where it was read (#266): its source-language
   * file's as the reader sees it, else the file's own; null when none.
   */
  readonly deprecated: Deprecation | null;
}

interface Input {
  readonly actor: Actor;
  /** Where the modules were read. */
  readonly snapshot: ReadableContent;
  readonly modules: readonly ModuleKey[];
}

/**
 * The status of each of `modules` (read in `snapshot`), by `moduleKey`:
 * the newest release tag holding it (`ReadableRefs.releases`: every tag is
 * a release, newest first; at most the `RELEASES_CHECKED` newest are
 * looked through), whether it is on `main`, each compared with the file
 * read, and the open change sets changing it (`ChangeSetTouches`). Each
 * release and `main` is opened as the actor reads it (`OpenSnapshotAction`,
 * released content), so a version outside their scope there is not there,
 * exactly like a missing one, and an older release holding one they see
 * counts instead.
 */
@Injectable()
export class GetModuleStatusesAction extends ActorAction<
  Input,
  Map<string, ModuleStatus>
> {
  readonly policy = 'content.read';
  /** Per set of releases, reading key and module: its newest release. */
  readonly #releases = new Recent<Found | undefined>(RELEASES_KEPT);

  constructor(
    private readonly refs: ReadableRefs,
    private readonly openSnapshot: OpenSnapshotAction,
    private readonly touches: ChangeSetTouches,
  ) {
    super();
  }

  protected async run({
    actor,
    snapshot,
    modules,
  }: Input): Promise<Map<string, ModuleStatus>> {
    const statuses = new Map<string, ModuleStatus>();
    if (modules.length === 0) return statuses;
    const [releases, main, touching, source] = await Promise.all([
      this.refs.releases(),
      this.refs.branch(actor, RELEASED_BRANCH),
      followsChangeSets(actor) ? this.touches.of(actor, modules) : undefined,
      snapshot.config().then(
        (config) => config.languages.source,
        (error: unknown) => {
          if (error instanceof InvalidContentError) return undefined;
          throw error;
        },
      ),
    ]);
    const checked = releases.slice(0, RELEASES_CHECKED);
    const opened = new Map<string, Promise<ReadableContent | undefined>>();
    const open = (commit: string) => {
      let found = opened.get(commit);
      if (!found) {
        found = this.open(actor, commit);
        opened.set(commit, found);
      }
      return found;
    };
    // Releases are released content: read with `content.read`.
    const releasesKey = [
      fingerprint(checked),
      readingKey(actor, 'content.read'),
    ].join('|');
    await Promise.all(
      modules.map(async (m) => {
        const [own, release, onMain, deprecated] = await Promise.all([
          snapshot.moduleRevision(m.id, m.lang),
          this.#releases.get(`${releasesKey}|${moduleKey(m)}`, () =>
            newestHolding(checked, open, m),
          ),
          main ? revisionIn(open(main.commit), m) : undefined,
          deprecationIn(snapshot, m, source),
        ]);
        statuses.set(moduleKey(m), {
          release: release
            ? {
                tag: release.tag,
                commit: release.commit,
                same: release.revision === own,
              }
            : null,
          main:
            main && onMain !== undefined
              ? { commit: main.commit, same: onMain === own }
              : null,
          ...(touching && {
            changeSets: touching.get(moduleKey(m)) ?? [],
          }),
          deprecated,
        });
      }),
    );
    return statuses;
  }

  /** The commit as the actor may read it; undefined when they may not. */
  private async open(
    actor: Actor,
    commit: string,
  ): Promise<ReadableContent | undefined> {
    try {
      const opened = await this.openSnapshot.handle({ actor, ref: commit });
      return opened.commit === commit ? opened : undefined;
    } catch (error) {
      if (error instanceof NotFoundError) return undefined;
      throw error;
    }
  }
}

/**
 * A module's deprecation in `snapshot` (#266): its source-language file's,
 * as the reader sees it there, else (none they see, or it cannot be read)
 * the file's own in `lang`.
 */
export async function deprecationIn(
  snapshot: Pick<ReadableContent, 'module'>,
  { id, lang }: ModuleKey,
  source: string | undefined,
): Promise<Deprecation | null> {
  const read = async (l: string) => {
    try {
      return await snapshot.module(id, l);
    } catch (error) {
      if (error instanceof InvalidContentError) return undefined;
      throw error;
    }
  };
  const file =
    (source !== undefined && source !== lang
      ? await read(source)
      : undefined) ?? (await read(lang));
  return file?.meta.deprecated ?? null;
}

interface Found {
  readonly tag: string;
  readonly commit: string;
  readonly revision: string;
}

/** The newest of `releases` holding the module as the actor sees it. */
async function newestHolding(
  releases: readonly RefInfo[],
  open: (commit: string) => Promise<ReadableContent | undefined>,
  m: ModuleKey,
): Promise<Found | undefined> {
  for (const release of releases) {
    const revision = await revisionIn(open(release.commit), m);
    if (revision !== undefined) {
      return { tag: release.name, commit: release.commit, revision };
    }
  }
  return undefined;
}

/**
 * The module's revision in `content` as the actor sees it there; a commit
 * whose configuration cannot be read holds nothing they see.
 */
async function revisionIn(
  content: Promise<ReadableContent | undefined>,
  { id, lang }: ModuleKey,
): Promise<string | undefined> {
  try {
    return await (await content)?.moduleRevision(id, lang);
  } catch (error) {
    if (error instanceof InvalidContentError) return undefined;
    throw error;
  }
}

/** A short key for a list of releases: their names and commits, in order. */
function fingerprint(releases: readonly RefInfo[]): string {
  const hash = createHash('sha256');
  for (const { name, commit } of releases) hash.update(`${name}\0${commit}\0`);
  return hash.digest('hex');
}
