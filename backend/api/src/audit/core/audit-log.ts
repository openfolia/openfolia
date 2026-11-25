import { z } from 'zod';
import type { Actor } from '../../access/core/actor.js';
import type { PageRequest, Paginated } from '../../base/core/paging.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import {
  AuditActor,
  type AuditEvent,
  type AuditKind,
  type AuditFilter,
  type CheckedAuditEvent,
  NewAuditEvent,
  READ_ACTIONS,
} from './audit-event.js';
import type { AuditPosition } from './audit-sink.js';

export type { CheckedAuditEvent } from './audit-event.js';

/** The most events one `prune` call may remove. */
export const MAX_PRUNE_ROWS = 10_000;

/**
 * Port: the append-only audit log. Events are only ever added; nothing
 * changes one, and only retention (`prune`) removes old ones, recording
 * that it did (the database refuses anything else).
 */
export abstract class AuditLog {
  /**
   * Records that `actor` did `event`, inside `tx`: the event commits with
   * the change it describes, or not at all. Throws (rolling the change
   * back) when the event is malformed: a bug in the calling action.
   */
  async record(
    tx: Transaction,
    actor: Actor,
    event: NewAuditEvent,
  ): Promise<void> {
    const who = AuditActor.safeParse({ kind: actor.kind, id: actor.id });
    const what = NewAuditEvent.safeParse(event);
    // A read is one of `READ_ACTIONS` and nothing else is (#877): read
    // retention removes reads after their own period, so a change must never be one.
    if (
      what.success &&
      (what.data.kind === 'read') !== READ_ACTIONS.includes(what.data.action)
    ) {
      throw new Error(
        `Invalid audit event: kind "read" goes with the actions ${READ_ACTIONS.join(', ')}, and only with them`,
      );
    }
    if (!who.success || !what.success) {
      const error = who.error ?? what.error;
      throw new Error(
        `Invalid audit event${error ? `:\n${z.prettifyError(error)}` : ''}`,
      );
    }
    await this.append(tx, {
      kind: what.data.kind ?? 'write',
      actor: who.data,
      action: what.data.action,
      subject: what.data.subject,
      comment: what.data.comment ?? null,
      data: what.data.data ?? {},
    });
  }

  /** Appends a checked event within `tx`. */
  protected abstract append(
    tx: Transaction,
    event: CheckedAuditEvent,
  ): Promise<void>;

  /** One page of the events matching `filter`, newest first. */
  abstract list(
    filter: AuditFilter,
    page: PageRequest,
  ): Promise<Paginated<AuditEvent>>;

  /**
   * Every event matching `filter`, newest first, in the order `list` pages
   * them, read in batches as the consumer takes them (an export: never
   * all at once in memory). The batches are separate reads, not one
   * snapshot: an event recorded meanwhile with a higher ID than the first
   * batch's is not included; one with a lower ID (its transaction began
   * earlier, IDs are not commit order) may be.
   */
  abstract stream(filter: AuditFilter): AsyncIterable<AuditEvent>;

  /**
   * Retention (#379): removes up to `maxRows` (1 to `MAX_PRUNE_ROWS`) of the
   * oldest events of `kind` (#877: changes and reads are kept apart, each
   * for its own period) recorded before `before`, none after `keptAfter` when it
   * is given (events the sink has not sent yet), and when it removed any,
   * records that (`audit-log.prune`, with `before`, how many and the first
   * and last ID, and `kind: "read"` for reads) in the same transaction.
   * `kind` is `write` when not given. Answers how many it removed.
   * `before` lies at least a day back: the database refuses a later one.
   */
  abstract prune(
    before: Date,
    maxRows: number,
    keptAfter?: AuditPosition,
    kind?: AuditKind,
  ): Promise<number>;
}
