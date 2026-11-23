import { Injectable } from '@nestjs/common';
import type { UnguardedAction } from '../../../access/core/policy.js';
import { auditEventJson } from '../audit-export.js';
import {
  AuditSink,
  AuditSinkCursor,
  SINK_BATCH,
  SINK_BATCH_BYTES,
  type SinkEntry,
  type SinkResult,
} from '../audit-sink.js';

/** What one pass did. */
export interface SinkReport {
  /** Events delivered (and the cursor moved past them). */
  readonly sent: number;
  /**
   * Why the pass stopped early: another server holds the lease, the cursor
   * lies ahead of the database (restored from a backup), or a delivery failed.
   */
  readonly stopped?:
    | { readonly reason: 'leased' }
    | { readonly reason: 'cursor-ahead' }
    | {
        readonly reason: 'failed';
        readonly result: Extract<SinkResult, { ok: false }>;
      };
}

/**
 * Delivers the audit log to the sink (#379): takes the cursor's lease,
 * then reads `SINK_BATCH` events after the cursor, sends them in order and
 * moves the cursor past them, until none are left or `deadline` passes.
 * A failed delivery keeps the cursor where it is, so the same batch goes
 * again next pass (at least once, never out of order). A cursor moved by
 * someone else meanwhile (a lease that ran out) ends the pass; the batch
 * was then sent twice, which a receiver dedupes by ID and time. Runs for nobody.
 */
@Injectable()
export class SendToAuditSinkAction implements UnguardedAction {
  readonly policy = 'internal';
  now: () => number = Date.now;

  constructor(
    private readonly sink: AuditSink,
    private readonly cursor: AuditSinkCursor,
  ) {}

  async handle({
    holder,
    leaseMs,
    deadline,
  }: {
    holder: string;
    leaseMs: number;
    deadline: number;
  }): Promise<SinkReport> {
    let sent = 0;
    while (this.now() < deadline) {
      const from = await this.cursor.claim(holder, leaseMs);
      if (from === undefined) return { sent, stopped: { reason: 'leased' } };
      if (from === 'ahead')
        return { sent, stopped: { reason: 'cursor-ahead' } };
      const read = await this.cursor.read(from, SINK_BATCH);
      const entries = withinBytes(read);
      const last = entries.at(-1);
      if (!last) break;
      const result = await this.sink.send(entries.map((e) => e.event));
      if (!result.ok) return { sent, stopped: { reason: 'failed', result } };
      if (!(await this.cursor.advance(holder, from, last.position))) {
        return { sent, stopped: { reason: 'leased' } };
      }
      sent += entries.length;
      // Nothing more to read: the whole of a short read went.
      if (read.length < SINK_BATCH && entries.length === read.length) break;
    }
    return { sent };
  }
}

/** The first entries whose JSON stays within `SINK_BATCH_BYTES`, at least one. */
function withinBytes(entries: SinkEntry[]): SinkEntry[] {
  let bytes = 0;
  for (const [i, entry] of entries.entries()) {
    bytes += Buffer.byteLength(JSON.stringify(auditEventJson(entry.event)));
    if (i > 0 && bytes > SINK_BATCH_BYTES) return entries.slice(0, i);
  }
  return entries;
}
