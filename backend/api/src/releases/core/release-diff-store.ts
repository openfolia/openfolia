import type { StoredReleaseDiff } from './release-changes.js';

/**
 * Release diffs kept across restarts (#478): what `releaseDiff` worked out
 * for a pair of commits (as `RELEASE_READER` sees them), by the two commit
 * IDs. A pair of commits never changes, so a kept diff is never out of
 * date; it is rebuildable state, derived from Git alone, and any row may be
 * dropped (it is worked out again on the next read). Who may see what of
 * it is decided when it is read (`changesFor`), never stored.
 */
export abstract class ReleaseDiffStore {
  /**
   * The diff kept for `head` against `base` (undefined: a product's first
   * release), in the current format (`RELEASE_DIFF_FORMAT`); undefined
   * when none is.
   */
  abstract find(
    base: string | undefined,
    head: string,
  ): Promise<StoredReleaseDiff | undefined>;

  /**
   * Keeps the diff of `head` against `base`. Never throws: a diff that
   * could not be kept is worked out again next time, so a failing write
   * must not fail the read that made it.
   */
  abstract keep(
    base: string | undefined,
    head: string,
    diff: StoredReleaseDiff,
  ): Promise<void>;
}
