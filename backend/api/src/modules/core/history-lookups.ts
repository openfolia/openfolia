import { createHash } from 'node:crypto';
import { type Actor, UserId } from '../../access/core/actor.js';
import { readingKey } from '../../access/core/reading-scope.js';
import type { UserDirectory } from '../../access/core/user-directory.js';
import { InvalidContentError, NotFoundError } from '../../base/core/errors.js';
import { Recent } from '../../base/core/recent.js';
import type { OpenSnapshotAction } from '../../content/core/actions/open-snapshot.action.js';
import type { RefInfo } from '../../content/core/content.repository.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import type { ReadableRefs } from '../../content/core/readable-refs.js';
import { RELEASED_BRANCH } from '../../content/core/released.js';
import type { ModuleVersion } from './module-history.js';
import { RELEASES_CHECKED } from './actions/get-module-statuses.action.js';

/** How many histories (per commit, reader and subject) are kept. */
export const HISTORIES_KEPT = 1000;

/** A release tag holding a version. */
export interface VersionRelease {
  readonly tag: string;
  readonly commit: string;
}

/** A version on a page of a history, with what is looked up for it. */
export interface HistoryEntry extends ModuleVersion {
  /** The release tags holding exactly this file, as the reader sees it there; newest first. */
  readonly releases: readonly VersionRelease[];
  /** Whether `actor` is a user the directory knows. */
  readonly actorKnown: boolean;
  /** The approvers (`approvedBy`) the directory knows, by user ID. */
  readonly knownApprovers: readonly string[];
}

/**
 * What a history's page looks up for its versions, shared by the module
 * and the manual history (`GetModuleHistoryAction`,
 * `GetManualHistoryAction`): the release tags (the `RELEASES_CHECKED`
 * newest, each read as the actor reads released content) holding exactly
 * a version's file, by revision, and the users among its actors and
 * approvers the directory knows. Kept per release list, reading key and
 * subject (`HISTORIES_KEPT`).
 */
export class HistoryLookups {
  readonly #releases = new Recent<ReadonlyMap<string, VersionRelease[]>>(
    HISTORIES_KEPT,
  );

  constructor(
    private readonly refs: ReadableRefs,
    private readonly openSnapshot: OpenSnapshotAction,
    private readonly users: UserDirectory,
  ) {}

  /**
   * The page's versions with their releases and known users. `subject`
   * names what `revisionAt` reads (its parts, a cache key); `revisionAt` gives its
   * file's revision in a release as the actor sees it there (undefined:
   * none they see).
   */
  async entries(
    actor: Actor,
    items: readonly ModuleVersion[],
    subject: readonly string[],
    revisionAt: (content: ReadableContent) => Promise<string | undefined>,
  ): Promise<HistoryEntry[]> {
    const [releases, known] = await Promise.all([
      items.some((v) => v.fileRevision !== undefined)
        ? this.releasesOf(actor, subject, revisionAt)
        : new Map<string, VersionRelease[]>(),
      this.knownUsers(items),
    ]);
    return items.map((version) => ({
      ...version,
      releases:
        version.fileRevision === undefined
          ? []
          : (releases.get(version.fileRevision) ?? []),
      actorKnown: version.actor?.kind === 'user' && known.has(version.actor.id),
      knownApprovers: version.approvedBy
        .filter((a) => a.kind === 'user' && known.has(a.id))
        .map((a) => a.id),
    }));
  }

  /**
   * For a reader of released content only (#410): of `versions` (read at
   * `at`), those released content holds, as the reader sees it there, each
   * with the released commit to read it at (`readAt`): `main`'s head when
   * it holds exactly that version (by `revisionAt`), else `at` itself when
   * it is released (a tag older than those checked, or withdrawn, still
   * reads), else the newest release tag that does (as `entries` finds
   * them). A removal, a broken manifest (all of them alike, so none is
   * matched) and a version no released commit holds are left out: their
   * content is a draft (`readPermissionAt`), so they are no version to them.
   */
  async released<V extends ModuleVersion>(
    actor: Actor,
    at: ReadableContent,
    versions: readonly V[],
    subject: readonly string[],
    revisionAt: (content: ReadableContent) => Promise<string | undefined>,
  ): Promise<{ version: V; readAt: string }[]> {
    const held = versions.filter(
      (v) => v.fileRevision !== undefined && !v.unreadable,
    );
    if (held.length === 0) return [];
    const [main, atReleased] = await Promise.all([
      this.refs.branch(actor, RELEASED_BRANCH),
      this.refs.isReleased(at.commit),
    ]);
    const [releases, atMain, atRef] = await Promise.all([
      this.releasesOf(actor, subject, revisionAt),
      main?.released
        ? this.revisionIn(actor, main.commit, revisionAt)
        : undefined,
      atReleased ? revisionAt(at) : undefined,
    ]);
    const listed: { version: V; readAt: string }[] = [];
    for (const version of held) {
      const revision = version.fileRevision;
      const readAt =
        main && atMain === revision
          ? main.commit
          : atRef === revision
            ? at.commit
            : releases.get(revision as string)?.[0]?.commit;
      if (readAt !== undefined) listed.push({ version, readAt });
    }
    return listed;
  }

  /**
   * By file revision: the release tags (the `RELEASES_CHECKED` newest)
   * whose commit holds exactly that file as the actor sees it there.
   */
  private async releasesOf(
    actor: Actor,
    subject: readonly string[],
    revisionAt: (content: ReadableContent) => Promise<string | undefined>,
  ): Promise<ReadonlyMap<string, VersionRelease[]>> {
    const checked = (await this.refs.releases()).slice(0, RELEASES_CHECKED);
    const key = [
      fingerprint(checked),
      readingKey(actor, 'content.read'),
      ...subject,
    ]
      .map((part) => part.replaceAll('|', '||'))
      .join('|');
    return this.#releases.get(key, async () => {
      const revisions = await Promise.all(
        checked.map((release) =>
          this.revisionIn(actor, release.commit, revisionAt),
        ),
      );
      const found = new Map<string, VersionRelease[]>();
      checked.forEach((release, i) => {
        const revision = revisions[i];
        if (revision === undefined) return;
        const tags = found.get(revision) ?? [];
        tags.push({ tag: release.name, commit: release.commit });
        found.set(revision, tags);
      });
      return found;
    });
  }

  /** The file's revision at a released commit as the actor sees it there. */
  private async revisionIn(
    actor: Actor,
    commit: string,
    revisionAt: (content: ReadableContent) => Promise<string | undefined>,
  ): Promise<string | undefined> {
    try {
      const content = await this.openSnapshot.handle({ actor, ref: commit });
      if (content.commit !== commit) return undefined;
      return await revisionAt(content);
    } catch (error) {
      // A release they may not open, or whose configuration is broken,
      // holds nothing they see.
      if (error instanceof NotFoundError) return undefined;
      if (error instanceof InvalidContentError) return undefined;
      throw error;
    }
  }

  /** The user IDs among the page's actors and approvers the directory knows. */
  private async knownUsers(
    versions: readonly ModuleVersion[],
  ): Promise<ReadonlySet<string>> {
    const ids = new Set(
      versions
        .flatMap((v) => [...(v.actor ? [v.actor] : []), ...v.approvedBy])
        .filter((a) => a.kind === 'user' && UserId.safeParse(a.id).success)
        .map((a) => a.id),
    );
    const found = await Promise.all(
      [...ids].map(async (userId) =>
        (await this.users.findUser(userId)) ? userId : undefined,
      ),
    );
    return new Set(found.filter((userId) => userId !== undefined));
  }
}

/** A short key for a list of releases: their names and commits, in order. */
function fingerprint(releases: readonly RefInfo[]): string {
  const hash = createHash('sha256');
  for (const { name, commit } of releases) hash.update(`${name}\0${commit}\0`);
  return hash.digest('hex');
}

/**
 * The released commits a reader of `content.read` reads, newest first:
 * `main`'s head, then the `RELEASES_CHECKED` newest release tags (but
 * withdrawn ones, as `ReadableRefs.releases`), each opened as the actor
 * reads it; one they may not open, or whose configuration is broken, is
 * left out. For finding where released content holds something a draft
 * commit showed (#410).
 */
export async function openReleased(
  refs: ReadableRefs,
  openSnapshot: OpenSnapshotAction,
  actor: Actor,
): Promise<ReadableContent[]> {
  const [main, releases] = await Promise.all([
    refs.branch(actor, RELEASED_BRANCH),
    refs.releases(),
  ]);
  const commits = [
    ...(main?.released ? [main.commit] : []),
    ...releases.slice(0, RELEASES_CHECKED).map((release) => release.commit),
  ].filter((commit, i, all) => all.indexOf(commit) === i);
  const opened = await Promise.all(
    commits.map(async (commit) => {
      try {
        const content = await openSnapshot.handle({ actor, ref: commit });
        return content.commit === commit ? content : undefined;
      } catch (error) {
        if (error instanceof NotFoundError) return undefined;
        if (error instanceof InvalidContentError) return undefined;
        throw error;
      }
    }),
  );
  return opened.filter((content) => content !== undefined);
}

/** How many files are looked for in released content at once (`heldInReleased`). */
const RELEASED_AT_ONCE = 16;

/**
 * Each of `files` as `read` finds it in the newest of `released` (from
 * `openReleased`) that holds it, undefined where none does; in the order
 * of `files`. Looked for in batches of `RELEASED_AT_ONCE`, each stopping at
 * the first release holding it. For a deleted manual's last manifest
 * (#410) and a deleted module's last files (#418), read by a reader of
 * released content only.
 */
export async function heldInReleased<F, R>(
  released: readonly ReadableContent[],
  files: readonly F[],
  read: (content: ReadableContent, file: F) => Promise<R | undefined>,
): Promise<(R | undefined)[]> {
  const found: (R | undefined)[] = [];
  for (let i = 0; i < files.length; i += RELEASED_AT_ONCE) {
    const batch = files.slice(i, i + RELEASED_AT_ONCE);
    found.push(
      ...(await Promise.all(
        batch.map(async (file) => {
          for (const content of released) {
            const held = await read(content, file);
            if (held !== undefined) return held;
          }
          return undefined;
        }),
      )),
    );
  }
  return found;
}
