import {
  type AuditEvent,
  type AuditFilter,
  type AuditKind,
  matchesAuditFilter,
} from '../../src/audit/core/audit-event.js';
import {
  AuditLog,
  type CheckedAuditEvent,
  MAX_PRUNE_ROWS,
} from '../../src/audit/core/audit-log.js';
import {
  type AuditPosition,
  AuditSink,
  AuditSinkCursor,
  positionBefore,
  SINK_START,
  type SinkEntry,
  type SinkResult,
} from '../../src/audit/core/audit-sink.js';
import { paginate, type PageRequest } from '../../src/base/core/paging.js';
import type { Transaction } from '../../src/base/core/unit-of-work.js';
import { fakeOf } from './fake-unit-of-work.js';

/**
 * The audit log in memory, with `FakeUnitOfWork`: an event is kept only
 * when its transaction commits. `events` holds them oldest first.
 */
export class FakeAuditLog extends AuditLog {
  readonly events: AuditEvent[] = [];
  private lastId: number;

  /** Events already recorded, oldest first (e.g. for a list test). */
  constructor(events: readonly AuditEvent[] = []) {
    super();
    this.events.push(...events);
    this.lastId = Math.max(0, ...events.map((e) => Number(e.id)));
  }

  protected async append(
    tx: Transaction,
    event: CheckedAuditEvent,
  ): Promise<void> {
    const transaction = fakeOf(tx);
    // Assigned on insert, as an identity column is, after any given event.
    const id = String(++this.lastId);
    transaction.onCommit(() =>
      this.events.push({ ...event, id, at: transaction.startedAt }),
    );
  }

  async list(filter: AuditFilter, page: PageRequest) {
    return paginate(this.matching(filter), page);
  }

  async *stream(filter: AuditFilter): AsyncIterable<AuditEvent> {
    yield* this.matching(filter);
  }

  /**
   * `audit_events_prune` (or `audit_events_prune_reads` for `read`) as the
   * database runs it; every event's position is `{ tx: '1', id }`.
   */
  async prune(
    before: Date,
    maxRows: number,
    keptAfter?: AuditPosition,
    kind: AuditKind = 'write',
  ): Promise<number> {
    if (before.getTime() > Date.now() - 23 * 60 * 60 * 1000) {
      throw new Error(
        'audit_events_prune: before must lie at least 23 hours back',
      );
    }
    if (maxRows < 1 || maxRows > MAX_PRUNE_ROWS) {
      throw new Error('audit_events_prune: max_rows must be from 1 to 10000');
    }
    const doomed = this.events
      .filter(
        (e) =>
          e.kind === kind &&
          e.at.getTime() < before.getTime() &&
          (!keptAfter || !positionBefore(keptAfter, fakePosition(e))),
      )
      .sort(
        (a, b) =>
          a.at.getTime() - b.at.getTime() || Number(a.id) - Number(b.id),
      )
      .slice(0, maxRows);
    if (doomed.length === 0) return 0;
    const gone = new Set(doomed.map((e) => e.id));
    const kept = this.events.filter((e) => !gone.has(e.id));
    this.events.splice(0, this.events.length, ...kept);
    const ids = doomed.map((e) => Number(e.id));
    this.events.push({
      id: String(++this.lastId),
      at: new Date(),
      kind: 'write',
      actor: { kind: 'service', id: 'audit-retention' },
      action: 'audit-log.prune',
      subject: { type: 'audit-log', id: 'audit-events' },
      comment: null,
      data: {
        before: before.toISOString(),
        removed: doomed.length,
        firstId: String(Math.min(...ids)),
        lastId: String(Math.max(...ids)),
        ...(kind === 'read' && { kind }),
      },
    });
    return doomed.length;
  }

  /** The events `filter` selects, newest first. */
  private matching(filter: AuditFilter): AuditEvent[] {
    return this.events.filter((e) => matchesAuditFilter(e, filter)).reverse();
  }
}

/** A fake event's sink position: one transaction, in ID order. */
export function fakePosition(event: AuditEvent): AuditPosition {
  return { tx: '1', id: event.id };
}

/** The sink's cursor over a `FakeAuditLog`'s events, with the lease. */
export class FakeAuditSinkCursor extends AuditSinkCursor {
  cursor: AuditPosition = SINK_START;
  holder: string | undefined;
  leaseUntil = 0;
  now: () => number = Date.now;

  constructor(private readonly log: FakeAuditLog) {
    super();
  }

  /** Set to answer `ahead` (a cursor restored from another server). */
  ahead = false;

  async claim(holder: string, leaseMs: number) {
    if (
      this.holder !== undefined &&
      this.holder !== holder &&
      this.leaseUntil >= this.now()
    ) {
      return undefined;
    }
    this.holder = holder;
    this.leaseUntil = this.now() + leaseMs;
    return this.ahead ? ('ahead' as const) : this.cursor;
  }

  async read(after: AuditPosition, limit: number): Promise<SinkEntry[]> {
    return this.log.events
      .map((event) => ({ position: fakePosition(event), event }))
      .filter((e) => positionBefore(after, e.position))
      .sort((a, b) => Number(a.event.id) - Number(b.event.id))
      .slice(0, limit);
  }

  async advance(holder: string, from: AuditPosition, to: AuditPosition) {
    if (this.holder !== holder) return false;
    if (from.tx !== this.cursor.tx || from.id !== this.cursor.id) return false;
    this.cursor = to;
    return true;
  }

  async release(holder: string) {
    if (this.holder === holder) this.holder = undefined;
  }

  async position() {
    return this.cursor;
  }
}

/** A sink that keeps what it is sent, answering `results` in turn (then success). */
export class FakeAuditSink extends AuditSink {
  readonly batches: AuditEvent[][] = [];
  readonly results: SinkResult[] = [];

  async send(events: readonly AuditEvent[]): Promise<SinkResult> {
    const result = this.results.shift() ?? { ok: true };
    if (result.ok) this.batches.push([...events]);
    return result;
  }

  /** Every event delivered, in order. */
  get delivered(): AuditEvent[] {
    return this.batches.flat();
  }
}
