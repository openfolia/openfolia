import type {
  OutboxEvent,
  OutboxPosition,
} from '../../outbox/core/outbox-feed.js';

/** The outbox topics the change feed reads (#43). */
export const FEED_TOPICS = [
  'release.published',
  'release.withdrawn',
  'module.deprecated',
  'manual.deprecated',
] as const;

/**
 * Port: the outbox rows the change feed is made of (`FEED_TOPICS`), read
 * in `(tx, id)` order and only below the settled horizon, as
 * `OutboxFeed` reads them: every transaction before the horizon has
 * ended, so no row can later appear before one already read, and a
 * position moving through them never steps over a row. Stateless: the
 * reader's position is in their cursor, not in the database.
 */
export abstract class ChangeFeedSource {
  /**
   * Whether the feed is held after a restore onto another database server
   * (#619): the outbox's latch for the change feed (`OutboxFeed`'s
   * `BLOCKED`), checked and, when found, set on every call.
   */
  abstract blocked(): Promise<boolean>;

  /**
   * Whether the row `position` names still stands there (`START` always
   * does): false once the restore recipe renumbered it, so a reader's
   * position from before that means nothing now.
   */
  abstract holds(position: OutboxPosition): Promise<boolean>;

  /** The newest settled row's position; `START` for none. */
  abstract horizon(): Promise<OutboxPosition>;

  /** Up to `limit` settled rows after `position`, in order. */
  abstract after(
    position: OutboxPosition,
    limit: number,
  ): Promise<OutboxEvent[]>;

  /**
   * The release whose content stands at `position`: the newest release
   * of `main` (not of a maintenance line) published at or before it that
   * was not withdrawn at or before it, as the rows tell it; undefined for
   * none. The same position always gives the same answer.
   */
  abstract standingAt(position: OutboxPosition): Promise<string | undefined>;
}

/** Whether `a` comes after `b` in the outbox's order. */
export function isAfter(a: OutboxPosition, b: OutboxPosition): boolean {
  const ta = BigInt(a.tx);
  const tb = BigInt(b.tx);
  return ta > tb || (ta === tb && a.id > b.id);
}
