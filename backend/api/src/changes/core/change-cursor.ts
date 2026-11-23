import { z } from 'zod';
import type { Actor } from '../../access/core/actor.js';
import { GoneError, InvalidParameterError } from '../../base/core/errors.js';
import type { SecretSealer } from '../../base/core/secret-sealer.js';
import type { OutboxPosition } from '../../outbox/core/outbox-feed.js';

/**
 * A cursor the feed cannot continue from: sealed under another instance
 * key (#489, a rotation), for another reader, changed, or naming scopes
 * no longer kept. 400 `cursor-expired`: start again without a cursor,
 * from the snapshot. Never says which.
 */
export class CursorExpiredError extends InvalidParameterError {
  override readonly code = 'cursor-expired';

  constructor() {
    super(
      'page[cursor]',
      'This cursor can no longer be read (the server’s secret key changed, it was issued to someone else, or it was changed). Start again without `page[cursor]`: the feed answers a snapshot of everything you may read first, then the changes.',
    );
  }
}

/**
 * A cursor standing on content that can no longer be read (#558): the
 * commit of a release whose chunks the reader holds is gone from the
 * repository (a history rewrite, a garbage collection), or no longer
 * reads, so what they hold cannot be named to be removed. 410
 * `cursor-gone`: resync, from the start or from a release tag (README,
 * "Change feed").
 */
export class CursorGoneError extends GoneError {
  override readonly code = 'cursor-gone';

  constructor(
    why = 'This cursor stands on content that is gone from the repository or can no longer be read, so what you hold cannot be told apart.',
  ) {
    super(
      `${why} Resync: drop what you stored and start again without \`page[cursor]\` (the feed answers a snapshot first), or rebuild from a release tag with \`GET /chunks?ref=<tag>\` and then start again without \`page[cursor]\`.`,
      'page[cursor]',
    );
  }
}

const Position = z.tuple([
  z.string().regex(/^\d{1,20}$/),
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
]);
const ReleaseRef = z.string().min(1).max(100).nullable();
const Digest = z.string().regex(/^[0-9a-f]{64}$/);
const ChunkRef = z.string().min(1).max(300);

/**
 * Set on a state the reader holds nothing of (#558): one that could not be
 * read when they moved to it (a snapshot, a withdrawal or a scope change
 * to it, or a release given up part-way), so it is never read again. A
 * state without it that cannot be read is `cursor-gone`. Left out of
 * cursors from before it, as it is left out when false.
 */
const Empty = z.literal(true).optional();

/** A state: the release whose chunks a reader holds, the scopes they hold them in, and whether they hold none (`x`). */
const State = z.strictObject({ r: ReleaseRef, d: Digest, x: Empty });

/** The chunks a transition starts from: those of a state, only up to `u` (by ID) when set; none for `x`. */
const Piece = z.strictObject({
  r: ReleaseRef,
  d: Digest,
  u: ChunkRef.nullable(),
  x: Empty,
});

/**
 * The cursor's content (sealed, so a reader never sees or changes it):
 *
 * - `at`: the last outbox row fully told;
 * - `s`: the state the reader holds once everything up to `at` is applied;
 * - `p`, while a row (or a scope change) is told across pages: the row
 *   (`row`, the next after `at`; null for a snapshot or a scope change),
 *   its events told up to the key `e` (null: none yet; true: all), and the
 *   chunk transition `c` from the pieces `f` to the state `t`, told up to
 *   the chunk ID `a`, for the cause `k`.
 */
export const CursorContent = z.strictObject({
  v: z.literal(1),
  /** How chunks were cut and compared (`CHUNK_FORMAT`): another one cannot be gone on from. */
  cf: z.number().int(),
  /** The lineage: made at a fresh start, so two of them never share an event key. */
  l: z.string().regex(/^[0-9a-f]{16}$/),
  /** Transitions told in this lineage: part of each one's event keys. */
  n: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  at: Position,
  s: State,
  p: z
    .strictObject({
      row: Position.nullable(),
      e: z
        .union([z.literal(true), z.string().regex(/^[0-9a-f]{64}$/)])
        .nullable(),
      c: z
        .strictObject({
          f: z.array(Piece).max(2),
          t: State,
          a: ChunkRef.nullable(),
          k: z.enum(['release', 'withdrawal', 'scope', 'snapshot']),
        })
        .optional(),
    })
    .optional(),
});
export type CursorContent = z.infer<typeof CursorContent>;

/**
 * How chunks are cut and compared (the content model's `toChunks`, the
 * feed's fingerprint). Raise it when an upgrade changes either: the
 * states a cursor names are worked out again with today's code, so a
 * cursor from before is `cursor-expired` and its reader starts again from
 * the snapshot instead of drifting.
 */
export const CHUNK_FORMAT = 1;

/** The most pieces a transition starts from: its state, and one scope change while it was told. */
export const MAX_PIECES = 2;

/** What a cursor is sealed for: the feed, and the reader it was issued to. */
export function cursorContext(actor: Actor): string {
  return `change-feed-cursor:v1:${actor.kind}:${actor.id}`;
}

export function sealCursor(
  sealer: SecretSealer,
  actor: Actor,
  content: CursorContent,
): string {
  return sealer.seal(JSON.stringify(content), cursorContext(actor));
}

/** The cursor's content; `CursorExpiredError` for any that does not open as this reader's. */
export function openCursor(
  sealer: SecretSealer,
  actor: Actor,
  cursor: string,
): CursorContent {
  let text: string;
  try {
    text = sealer.open(cursor, cursorContext(actor));
  } catch {
    throw new CursorExpiredError();
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CursorExpiredError();
  }
  const parsed = CursorContent.safeParse(json);
  if (!parsed.success || parsed.data.cf !== CHUNK_FORMAT) {
    throw new CursorExpiredError();
  }
  return parsed.data;
}

export const positionOf = ([tx, id]: readonly [
  string,
  number,
]): OutboxPosition => ({
  tx,
  id,
});

export const toPosition = (p: OutboxPosition): [string, number] => [p.tx, p.id];
