import type { ApiError } from '../api';

/** Who holds a lock: a user or a service account. */
export interface LockHolder {
  readonly kind: string;
  readonly id: string;
}

/**
 * The lock another change set holds on a module, as a `409 locked` tells it (screen 12). Every
 * field is null when the API does not say it: it names the holder only to someone who may know
 * of the lock (one `GET /locks` would list to them).
 */
export interface HeldLock {
  /** The lock's ID: what a take-over breaks. */
  readonly id: string | null;
  readonly holder: LockHolder | null;
  /** When it was taken (ISO 8601). */
  readonly since: string | null;
  /** The change set holding it. */
  readonly changeSetId: string | null;
  /** That change set's title (#472); null when the API does not say it. */
  readonly changeSetTitle: string | null;
  /** That change set's state (`draft`, `in-review`, …). */
  readonly changeSetState: string | null;
  /**
   * Whether that change set has changes to the module (a working copy, or commits): only then
   * is "Release it there" withheld. Null when the API does not say it.
   */
  readonly hasChanges: boolean | null;
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/** The lock a `409 locked` refusal names, as far as it names it. */
export function heldLockOf(failure: ApiError): HeldLock {
  const meta = failure.errors[0]?.meta ?? {};
  const holder = meta['holder'] as { kind?: unknown; id?: unknown } | undefined;
  const holderId = text(holder?.id);
  return {
    id: text(meta['lockId']),
    holder: holderId
      ? { kind: text(holder?.kind) ?? 'user', id: holderId }
      : null,
    since: text(meta['since']),
    changeSetId: text(meta['changeSetId']),
    changeSetTitle: text(meta['changeSetTitle']),
    changeSetState: text(meta['changeSetState']),
    hasChanges:
      typeof meta['hasChanges'] === 'boolean' ? meta['hasChanges'] : null,
  };
}

/** The lock is the reader's own, held by another of their change sets (#472). */
export function isOwnLock(lock: HeldLock, me: { id: string }): boolean {
  return (
    lock.holder?.kind === 'user' &&
    lock.holder.id === me.id &&
    lock.changeSetId !== null
  );
}

/** A lock taken more than a day ago: waiting for its holder to be done is no plan (#472). */
export function heldLong(lock: HeldLock, now = Date.now()): boolean {
  const since = lock.since ? Date.parse(lock.since) : Number.NaN;
  return Number.isFinite(since) && now - since > 24 * 60 * 60 * 1000;
}

/** Lock-break comments: as the API takes them (a change set's description, at most 10,000). */
export const TAKE_OVER_COMMENT_MAX = 10_000;
