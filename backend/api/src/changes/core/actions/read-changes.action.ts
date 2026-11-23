import { createHash, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import {
  type DomainError,
  InvalidContentError,
  NotConfiguredError,
  NotFoundError,
  TooManyRequestsError,
  UnavailableError,
} from '../../../base/core/errors.js';
import { Recent } from '../../../base/core/recent.js';
import { ChunkSetTooLargeError } from '../../../chunks/core/chunk-set-too-large.js';
import { SecretSealer } from '../../../base/core/secret-sealer.js';
import {
  type OutboxEvent,
  samePosition,
} from '../../../outbox/core/outbox-feed.js';
import type { WebhookEvent } from '../../../webhooks/core/webhook.js';
import { WebhookEventBuilder } from '../../../webhooks/core/webhook-events.js';
import {
  CHUNK_FORMAT,
  CursorExpiredError,
  CursorGoneError,
  type CursorContent,
  MAX_PIECES,
  openCursor,
  positionOf,
  sealCursor,
  toPosition,
} from '../change-cursor.js';
import { ChangeFeedSource } from '../change-feed-source.js';
import {
  type ChunkState,
  ChunkStates,
  type FeedChunk,
} from '../chunk-states.js';
import {
  FeedScopes,
  readerOf,
  readerScopes,
  scopeDigest,
} from '../feed-scopes.js';

/** The webhook events (#42) the feed carries, in their shapes. */
export const FEED_WEBHOOK_EVENTS: ReadonlySet<WebhookEvent> = new Set([
  'manual.released',
  'module.released',
  'release.withdrawn',
  'module.deprecated',
  'manual.deprecated',
]);

/** Every event type of the feed. */
export const FEED_EVENTS = [
  'manual.released',
  'module.released',
  'release.withdrawn',
  'module.deprecated',
  'manual.deprecated',
  'chunk.upserted',
  'chunk.removed',
] as const;
export type FeedEventType = (typeof FEED_EVENTS)[number];

/** Why a chunk is to be dropped: deprecated with no replacement, its release withdrawn, or gone (deleted, or no longer one the reader may read: never told which). */
export type RemovedReason = 'deprecated' | 'withdrawn' | 'gone';

/** One event of the feed. */
export interface FeedEvent {
  readonly type: FeedEventType;
  /** SHA-256 hex; the same event has the same key, and two events never share one. */
  readonly idempotencyKey: string;
  readonly occurredAt: Date;
  readonly data: Readonly<Record<string, unknown>>;
}

/** The most outbox rows one page looks at, whether or not they tell the reader anything. */
export const ROWS_PER_PAGE = 100;

/**
 * The most costly steps one page starts: a release's or a withdrawal's
 * row (its webhook events compare the release with the one before) and
 * a chunk transition (it compares whole chunk sets, made from the whole
 * repository when not kept), so a page after many releases goes on in
 * the next one rather than making dozens of them.
 */
export const TRANSITIONS_PER_PAGE = 4;

/** How many transitions' worked-out events, and rows' webhook events, are kept. */
export const PLANS_KEPT = 16;

/** The most deprecation rows one page looks at: each opens its commit to judge the reader. */
export const DEPRECATIONS_PER_PAGE = 25;

interface Input {
  readonly actor: Actor;
  /** The sealed cursor of the page before; none: start with the snapshot. */
  readonly cursor?: string | undefined;
  /** The most events to answer (1 or more). */
  readonly size: number;
}

export interface ChangesPage {
  readonly events: readonly FeedEvent[];
  /** Where the next page starts: always given, also once caught up (poll with it). */
  readonly cursor: string;
  /** Nothing more to tell right now: wait before asking again. */
  readonly upToDate: boolean;
}

type Pending = NonNullable<CursorContent['p']>;
type Transition = NonNullable<Pending['c']>;
type Piece = Transition['f'][number];

/** One chunk a transition tells: upserted (`target`) or removed (`reason`). */
interface Step {
  readonly id: string;
  readonly target?: FeedChunk;
  readonly reason?: RemovedReason;
}

/** A transition worked out once: what it tells, by chunk ID, and the state it ends in. */
interface Plan {
  readonly to: ChunkState;
  readonly steps: readonly Step[];
  /** The target cannot be read: nothing is told, and the reader stays where they were. */
  readonly skipped?: true;
  /** The target cannot be read: every chunk held is removed, and the reader holds none there. */
  readonly empty?: true;
}

/**
 * The change feed (#43): what was released, withdrawn and deprecated
 * since a cursor, scoped to what the reader may read, so a consumer that
 * was down catches up, and one that starts fresh gets a snapshot first.
 *
 * **Where it comes from:** the outbox rows of `release.published`,
 * `release.withdrawn`, `module.deprecated` and `manual.deprecated`
 * (`ChangeFeedSource`), in
 * `(tx, id)` order below the settled horizon: a row never appears before
 * one already told, so no event is skipped or told twice across pages,
 * whatever is released meanwhile. Each row is told as two parts:
 *
 * 1. the webhook events it makes (#42, `WebhookEventBuilder`, the same
 *    shapes and keys, as the reader may read them now), sorted by key;
 * 2. for a release or a withdrawal: the chunk transition (#52), from the
 *    chunks the reader held at the release that stood before the row to
 *    those at the release that stands after it (the newest release of
 *    `main` not withdrawn), by chunk ID: `chunk.upserted` for a chunk new
 *    or changed (text or metadata), `chunk.removed` for one gone.
 *
 * **The reader's scope** (the scopes of their `content.read` roles) is
 * judged on every page. When it differs from the one the cursor was
 * issued for, the reader's chunks are carried over at the same release:
 * `chunk.removed` for those they may no longer read, `chunk.upserted` for
 * those they may now. A chunk is named only when the reader may read it
 * now, or held it before (a removal), so no event names what they never
 * saw. A scope change in the middle of a transition restarts it from
 * every version the reader may hold (`MAX_PIECES`; a second change before
 * it ends is `cursor-expired`).
 *
 * **The cursor** is sealed under the instance secret key for this reader
 * (`SecretSealer`, `cursorContext`): opaque, unforgeable, and of no use to
 * anyone else. It holds positions, release IDs and the digest of the
 * scopes (kept in `FeedScopes`), never the scopes themselves, so it stays
 * short (`CursorContent`). One that cannot be opened is 400
 * `cursor-expired`: start again from the snapshot. One standing on
 * chunks that can no longer be read (a commit gone from the repository)
 * is 410 `cursor-gone`: resync. Without an instance
 * key the feed is 404 `not-configured`.
 */
@Injectable()
export class ReadChangesAction extends ActorAction<Input, ChangesPage> {
  readonly policy = 'content.read';
  readonly #log = new Logger('ChangeFeed');
  /** Digests known to be kept in `FeedScopes`. */
  readonly #saved = new Set<string>();
  /** Per transition (its pieces, target and cause): what it tells, so a page costs a search, not a sort. */
  readonly #plans = new Recent<Plan>(PLANS_KEPT);
  /** Per row and scope digest: its webhook events, so a row told across pages is worked out once. */
  readonly #rowEvents = new Recent<FeedEvent[]>(PLANS_KEPT);
  /** Readers with a page under way (`<kind>:<id>`): one at a time each. */
  readonly #reading = new Set<string>();
  /** Whether the last page found the feed held after a restore (logged once). */
  #held = false;

  constructor(
    private readonly source: ChangeFeedSource,
    private readonly scopes: FeedScopes,
    private readonly states: ChunkStates,
    private readonly events: WebhookEventBuilder,
    private readonly sealer: SecretSealer,
  ) {
    super();
  }

  protected async run(input: Input): Promise<ChangesPage> {
    if (!this.sealer.available) {
      throw new NotConfiguredError(
        'The change feed needs the instance secret key, which this server does not have.',
      );
    }
    // One page at a time per reader: pages of one reader follow each other
    // anyway, and a reader replaying many cursors at once would make
    // every one of them work out whole chunk sets.
    const who = `${input.actor.kind}:${input.actor.id}`;
    if (this.#reading.has(who)) {
      throw new TooManyRequestsError(
        'A page of the change feed is being read for you already: read one page at a time.',
        1,
      );
    }
    this.#reading.add(who);
    try {
      return await this.page(input);
    } finally {
      this.#reading.delete(who);
    }
  }

  private async page({ actor, cursor, size }: Input): Promise<ChangesPage> {
    await this.checkNotHeld();
    const now = readerScopes(actor);
    const digest = scopeDigest(now);
    const reader = readerOf(now);
    const read: Reading = { now, digest, reader };
    const c =
      cursor === undefined
        ? await this.fresh(digest)
        : openCursor(this.sealer, actor, cursor);
    if (cursor !== undefined) await this.checkStands(c);
    const out: FeedEvent[] = [];
    let rows = 0;
    // Going on with what the cursor stopped in costs one step.
    let work = c.p ? 1 : 0;
    let deprecations = 0;
    let upToDate = false;
    /** The row just read after `c.at`, so it is not read again to be told. */
    let next: OutboxEvent | undefined;
    while (out.length < size) {
      if (!c.p) {
        if (c.s.d !== digest) {
          if (work >= TRANSITIONS_PER_PAGE) break;
          work += 1;
          c.p = {
            row: null,
            e: true,
            c: {
              f: [pieceOf(c.s)],
              t: { r: c.s.r, d: digest },
              a: null,
              k: 'scope',
            },
          };
          continue;
        }
        if (rows >= ROWS_PER_PAGE) break;
        const [row] = await this.source.after(positionOf(c.at), 1);
        if (!row) {
          upToDate = true;
          break;
        }
        const costly = !DEPRECATION_ROWS.has(row.topic);
        if (costly && work >= TRANSITIONS_PER_PAGE) break;
        if (!costly && deprecations >= DEPRECATIONS_PER_PAGE) break;
        if (costly) work += 1;
        else deprecations += 1;
        rows += 1;
        next = row;
        c.p = await this.pendingFor(row, c.s, digest);
        continue;
      }
      const p = c.p;
      if (p.c && p.c.t.d !== digest) restart(p.c, digest);
      const row = !p.row
        ? undefined
        : next && samePosition(next.position, positionOf(p.row))
          ? next
          : await this.rowAt(c.at, p.row);
      if (row && p.e !== true) {
        const all = await this.#rowEvents.get(
          `${row.position.tx}:${row.position.id}|${digest}`,
          () => this.webhookEvents(row, reader),
        );
        const after = p.e;
        const rest = all.filter(
          (e) => after === null || e.idempotencyKey > after,
        );
        const taken = rest.slice(0, size - out.length);
        out.push(...taken);
        if (taken.length < rest.length) {
          p.e = taken.at(-1)?.idempotencyKey ?? after;
          break;
        }
        p.e = true;
      }
      if (p.c) {
        const told = await this.transition(p.c, row, read, size - out.length, [
          c.l,
          c.n,
        ]);
        out.push(...told.events);
        // Kept with the cursor, so a scope change before it ends knows the
        // reader was told nothing of the target (`restart`).
        if (told.empty) p.c.t.x = true;
        if (!told.done) {
          p.c.a = told.after;
          break;
        }
        // Past a release that cannot be read, the reader keeps the state
        // they hold, so the next release is compared with that one.
        if (!told.skipped) {
          c.s = { r: p.c.t.r, d: p.c.t.d, ...(told.empty && { x: true }) };
        }
        c.n += 1;
      }
      if (p.row) c.at = p.row;
      delete c.p;
    }
    if (!this.#saved.has(digest)) {
      await this.scopes.save(digest, now);
      // Only spares a write: forgetting them all now and then costs one each.
      if (this.#saved.size >= 1_000) this.#saved.clear();
      this.#saved.add(digest);
    }
    return {
      events: out,
      cursor: sealCursor(this.sealer, actor, c),
      upToDate: upToDate && c.p === undefined,
    };
  }

  /**
   * 503 `outbox-blocked` while the outbox holds the feed after a restore
   * onto another database server (#619): reading on would skip what was
   * released since. Logged once until it goes on.
   */
  private async checkNotHeld(): Promise<void> {
    if (!(await this.source.blocked())) {
      if (this.#held)
        this.#log.log('The change feed goes on: the outbox is no longer held.');
      this.#held = false;
      return;
    }
    if (!this.#held) {
      this.#log.error(
        'The change feed answers 503: the outbox positions lie ahead of this database (restored from another server?). Run the SQL in backend/api/README.md, "Outbox", "After a restore".',
      );
    }
    this.#held = true;
    throw new UnavailableError(
      'outbox-blocked',
      'The change feed is held: this server’s database was restored from another server, and its operator has not finished the restore yet. Nothing is lost: try again later with the same cursor.',
      60,
    );
  }

  /**
   * `cursor-gone` for a cursor whose positions no longer stand on their
   * rows (the restore recipe renumbered the outbox, #619): from there the
   * feed would step over what came since, so the reader resyncs.
   */
  private async checkStands(c: CursorContent): Promise<void> {
    const row = c.p?.row;
    const stands =
      (await this.source.holds(positionOf(c.at))) &&
      (row == null || (await this.source.holds(positionOf(row))));
    if (!stands) {
      throw new CursorGoneError(
        'This cursor is from before the server’s database was restored from another server, so where it stands means nothing now.',
      );
    }
  }

  /** A first read: from the newest settled row, starting with the snapshot of the release standing there. */
  private async fresh(digest: string): Promise<CursorContent> {
    const at = await this.source.horizon();
    const standing = (await this.source.standingAt(at)) ?? null;
    return {
      v: 1,
      cf: CHUNK_FORMAT,
      l: randomBytes(8).toString('hex'),
      n: 0,
      at: toPosition(at),
      s: { r: null, d: digest },
      ...(standing !== null && {
        p: {
          row: null,
          e: true,
          c: { f: [], t: { r: standing, d: digest }, a: null, k: 'snapshot' },
        },
      }),
    };
  }

  /** What telling `row` takes: its events, and the chunk transition when it moves the release that stands. */
  private async pendingFor(
    row: OutboxEvent,
    state: CursorContent['s'],
    digest: string,
  ): Promise<Pending> {
    const pending: Pending = { row: toPosition(row.position), e: null };
    if (
      row.topic === 'release.published' ||
      row.topic === 'release.withdrawn'
    ) {
      const standing = (await this.source.standingAt(row.position)) ?? null;
      if (standing !== state.r) {
        pending.c = {
          f: [pieceOf(state)],
          t: { r: standing, d: digest },
          a: null,
          k: row.topic === 'release.withdrawn' ? 'withdrawal' : 'release',
        };
      }
    }
    return pending;
  }

  /** The row at `expected`, the next one after `at`. */
  private async rowAt(
    at: CursorContent['at'],
    expected: readonly [string, number],
  ): Promise<OutboxEvent> {
    const [row] = await this.source.after(positionOf(at), 1);
    if (!row || !samePosition(row.position, positionOf(expected))) {
      // Rows below the horizon never change: this cursor is not one we issued.
      throw new CursorExpiredError();
    }
    return row;
  }

  /** The webhook events `row` makes for the reader, sorted by key. */
  private async webhookEvents(
    row: OutboxEvent,
    reader: Actor,
  ): Promise<FeedEvent[]> {
    let made;
    try {
      made = await this.events.of(row, reader, FEED_WEBHOOK_EVENTS);
    } catch (error) {
      // Content that cannot be read at the row's commit tells nothing, as
      // for a webhook subscriber; an outage is a failed read, tried again.
      if (
        error instanceof NotFoundError ||
        error instanceof InvalidContentError
      ) {
        this.#log.warn(
          `Outbox row ${row.position.id} tells nothing: ${error.code}.`,
        );
        return [];
      }
      throw error;
    }
    if (made === undefined) {
      this.#log.warn(
        `Outbox row ${row.position.id} is not what its topic writes.`,
      );
      return [];
    }
    const out: FeedEvent[] = [];
    for (const e of made) {
      if (!FEED_WEBHOOK_EVENTS.has(e.type)) continue;
      out.push({
        type: e.type as FeedEventType,
        idempotencyKey: e.idempotencyKey,
        occurredAt: row.createdAt,
        data: e.data,
      });
    }
    return out.sort((a, b) => compare(a.idempotencyKey, b.idempotencyKey));
  }

  /** Up to `limit` events of the transition after its chunk `a`; `done` once none is left. */
  private async transition(
    tr: Transition,
    row: OutboxEvent | undefined,
    read: Reading,
    limit: number,
    lineage: readonly [string, number],
  ): Promise<{
    events: FeedEvent[];
    after: string | null;
    done: boolean;
    skipped?: true;
    empty?: true;
  }> {
    const target = { r: tr.t.r, d: tr.t.d };
    const plan = await this.#plans.get(
      JSON.stringify([tr.f, target, tr.k]),
      () => this.plan(tr, read),
    );
    // Told part of a target that no longer reads in this scope: what was
    // told cannot be named. Judged here, not in the plan, which is kept for
    // every reader of the same pieces wherever they stand in it.
    if ((plan.empty || plan.skipped) && tr.a !== null && tr.t.x !== true) {
      throw new CursorGoneError();
    }
    const { steps, to } = plan;
    // The first step after `a`: steps are sorted by ID.
    let start = 0;
    if (tr.a !== null) {
      let high = steps.length;
      while (start < high) {
        const mid = (start + high) >>> 1;
        if (compare((steps[mid] as Step).id, tr.a) <= 0) start = mid + 1;
        else high = mid;
      }
    }
    // The lineage and its count of transitions make every transition's
    // keys its own, also a scope changed back and forth at one release.
    const key = JSON.stringify([
      ...lineage,
      row ? toPosition(row.position) : null,
      tr.f,
      target,
    ]);
    const occurredAt = row?.createdAt ?? new Date();
    const taken = steps.slice(start, start + Math.max(0, limit));
    const events = taken.map((step) =>
      step.target
        ? upserted(step.target, to, key, occurredAt)
        : removed(step.id, to, step.reason ?? 'gone', key, occurredAt),
    );
    return {
      events,
      after: taken.at(-1)?.id ?? tr.a,
      done: start + taken.length >= steps.length,
      ...(plan.skipped && { skipped: true as const }),
      ...(plan.empty && { empty: true as const }),
    };
  }

  /**
   * What a transition tells, worked out once: by chunk ID, `upserted` for
   * a chunk of the target in a version the reader may not hold, `removed`
   * for one they may hold that the target has not.
   *
   * A target that cannot be read (an invalid configuration at its commit,
   * chunks too large to cut together (#684), or a commit gone from the
   * repository, `targetOr`):
   *
   * - a release nothing of which was told yet is logged and skipped: it
   *   tells nothing and the reader keeps the state they hold (`skipped`),
   *   so the next release is compared with that one and no removal is lost;
   * - a release part of which was told before a scope change (#558), a
   *   withdrawal, a scope change and a snapshot remove every chunk held
   *   instead (what was told, or the old scope saw, is not to be kept, and
   *   the new state cannot be told), and the reader then holds nothing
   *   there (`empty`, the cursor's `x`);
   * - a release part of which was told in this same scope cannot be
   *   finished nor undone (what was told can no longer be named):
   *   `cursor-gone`.
   *
   * What the reader holds is always read (`heldOf`): one that cannot be
   * read is `cursor-gone`, so no chunk outlives what they may read.
   */
  private async plan(tr: Transition, read: Reading): Promise<Plan> {
    const target = await this.targetOr(tr.t.r, tr.t.d, read);
    if (target === undefined) {
      if (tr.k === 'release' && tr.f.every((piece) => piece.u === null)) {
        return {
          to: { release: null, chunks: new Map(), deprecated: new Set() },
          steps: [],
          skipped: true,
        };
      }
    }
    const to = target ?? {
      release: null,
      chunks: new Map<string, FeedChunk>(),
      deprecated: new Set<string>(),
    };
    // Every version of a chunk the reader may hold now.
    const held = new Map<string, Set<string>>();
    for (const piece of tr.f) {
      for (const [id, chunk] of await this.heldOf(piece, read)) {
        if (piece.u !== null && compare(id, piece.u) > 0) continue;
        const versions = held.get(id) ?? new Set<string>();
        versions.add(chunk.fingerprint);
        held.set(id, versions);
      }
    }
    const steps: Step[] = [];
    const ids = [...new Set([...to.chunks.keys(), ...held.keys()])].sort(
      compare,
    );
    for (const id of ids) {
      const chunk = to.chunks.get(id);
      const versions = held.get(id);
      if (chunk) {
        if (versions?.size === 1 && versions.has(chunk.fingerprint)) continue;
        steps.push({ id, target: chunk });
      } else if (versions) {
        steps.push({
          id,
          reason: to.deprecated.has(id)
            ? 'deprecated'
            : tr.k === 'withdrawal'
              ? 'withdrawn'
              : 'gone',
        });
      }
    }
    return { to, steps, ...(target === undefined && { empty: true as const }) };
  }

  /**
   * The state to go to, or undefined (logged) when its release's content cannot be read, its
   * chunks are too large to cut together (#684) or its commit is gone.
   */
  private async targetOr(
    release: string | null,
    digest: string,
    read: Reading,
  ): Promise<ChunkState | undefined> {
    const scopes = await this.scopesOf(digest, read);
    try {
      return await this.states.of(release, scopes);
    } catch (error) {
      if (unreadable(error)) {
        this.#log.warn(
          `The chunks of release ${String(release)} cannot be read: ${error.code}.`,
        );
        return undefined;
      }
      throw error;
    }
  }

  /**
   * The chunks the reader may hold of a piece: none of one they hold
   * nothing of (`x`); `cursor-gone` when its release's content cannot be
   * read or its commit is gone, as what they hold cannot be named.
   */
  private async heldOf(
    piece: Piece,
    read: Reading,
  ): Promise<ReadonlyMap<string, FeedChunk>> {
    if (piece.x === true) return new Map();
    const scopes = await this.scopesOf(piece.d, read);
    try {
      return (await this.states.of(piece.r, scopes)).chunks;
    } catch (error) {
      if (unreadable(error)) {
        this.#log.warn(
          `The chunks held at release ${String(piece.r)} cannot be read: ${error.code}.`,
        );
        throw new CursorGoneError();
      }
      throw error;
    }
  }

  /** The scopes behind a digest: the reader's own now, else those kept; `cursor-expired` for none. */
  private async scopesOf(
    digest: string,
    read: Reading,
  ): Promise<readonly string[]> {
    if (digest === read.digest) return read.now;
    const kept = await this.scopes.find(digest);
    if (!kept || scopeDigest(kept) !== digest) throw new CursorExpiredError();
    return kept;
  }
}

interface Reading {
  readonly now: readonly string[];
  readonly digest: string;
  readonly reader: Actor;
}

/**
 * The reader's scope changed while a transition was told: it starts
 * again towards their new scope, from every version they may hold (what
 * it started from, and what it told so far of where it was going).
 */
function restart(tr: Transition, digest: string): void {
  if (tr.a !== null) {
    if (tr.f.length >= MAX_PIECES) throw new CursorExpiredError();
    // Of a target that could not be read only removals were told: nothing held.
    tr.f.push({ r: tr.t.r, d: tr.t.d, u: tr.a, ...(tr.t.x && { x: true }) });
  }
  tr.t = { r: tr.t.r, d: digest };
  tr.a = null;
}

/** A transition's piece starting from a whole state. */
function pieceOf(state: CursorContent['s']): Piece {
  return { r: state.r, d: state.d, u: null, ...(state.x && { x: true }) };
}

/** The outbox topics that only make webhook events (`DEPRECATIONS_PER_PAGE`): no chunk transition. */
const DEPRECATION_ROWS: ReadonlySet<string> = new Set([
  'module.deprecated',
  'manual.deprecated',
]);

function upserted(
  chunk: FeedChunk,
  to: ChunkState,
  transition: string,
  occurredAt: Date,
): FeedEvent {
  return {
    type: 'chunk.upserted',
    idempotencyKey: keyOf(
      'chunk.upserted',
      transition,
      chunk.id,
      chunk.fingerprint,
    ),
    occurredAt,
    data: {
      chunkId: chunk.id,
      moduleId: chunk.moduleId,
      lang: chunk.lang,
      blockId: chunk.blockId ?? null,
      contentHash: chunk.contentHash,
      release: to.release,
    },
  };
}

function removed(
  id: string,
  to: ChunkState,
  reason: RemovedReason,
  transition: string,
  occurredAt: Date,
): FeedEvent {
  const [lang = '', moduleId = '', blockId] = id.split('/');
  return {
    type: 'chunk.removed',
    idempotencyKey: keyOf('chunk.removed', transition, id, ''),
    occurredAt,
    data: {
      chunkId: id,
      moduleId,
      lang,
      blockId: blockId ?? null,
      reason,
      release: to.release,
    },
  };
}

function keyOf(type: string, ...parts: string[]): string {
  const hash = createHash('sha256')
    .update('change-feed')
    .update('\n')
    .update(type);
  for (const part of parts) hash.update('\n').update(part);
  return hash.digest('hex');
}

/** By UTF-16 code units, as chunk IDs are ordered everywhere. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Whether the chunks of a state cannot be read: an invalid file, a commit gone, or chunks too
 * large to cut together (#684, `chunk-set-too-large`), which stay so for its commit.
 */
function unreadable(error: unknown): error is DomainError {
  return (
    error instanceof InvalidContentError ||
    error instanceof NotFoundError ||
    error instanceof ChunkSetTooLargeError
  );
}
