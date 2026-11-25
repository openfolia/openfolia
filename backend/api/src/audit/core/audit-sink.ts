import type { AuditEvent } from './audit-event.js';

/**
 * Where the sink stands in the audit log: after the event `id` recorded by
 * the transaction `tx` (its top-level transaction ID), both as decimal
 * text. Events are sent in `(tx, id)` order: increasing `id` within one
 * transaction, the transactions in the order they got their ID (their
 * first write), and only those
 * of transactions older than every one still running, so no event can
 * later appear before the last one sent (the outbox's rule, `OutboxFeed`).
 */
export interface AuditPosition {
  readonly tx: string;
  readonly id: string;
}

/** The position of a sink that has sent nothing yet. */
export const SINK_START: AuditPosition = Object.freeze({ tx: '0', id: '0' });

/** One event as the sink reads it: where it lies, and what it is. */
export interface SinkEntry {
  readonly position: AuditPosition;
  readonly event: AuditEvent;
}

/**
 * The name the sink's deliveries go out under: the syslog APP-NAME and the
 * HTTPS `User-Agent`'s product. The HTTPS signature's header is the
 * webhooks' (`SIGNATURE_HEADER`). One place each, for a rename.
 */
export const SINK_APP_NAME = 'openfolia';

/** The most events one delivery carries, in order. */
export const SINK_BATCH = 100;

/** About the most bytes of events (as JSON) one delivery carries; a single larger event still goes alone. */
export const SINK_BATCH_BYTES = 1024 * 1024;

/** Why a delivery failed. Never holds the URL, a header or the body. */
export type SinkError = 'timeout' | 'connection' | 'http-status';

export type SinkResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: SinkError;
      /** The answer's status, for `http-status`. */
      readonly statusCode?: number;
    };

/**
 * Port: the place the audit log is copied to as it grows (#379), an
 * HTTPS endpoint or a syslog server over TLS, set by the operator
 * (`CCMS_AUDIT_SINK_URL`). `send` delivers a batch of events in the order
 * given, all or nothing as far as the caller knows: on any failure the
 * same batch is sent again, so a receiver may see an event more than
 * once and dedupes by its `id` together with its `at` (after a restore an
 * `id` can come again, with another `at`).
 */
export abstract class AuditSink {
  abstract send(events: readonly AuditEvent[]): Promise<SinkResult>;
}

/**
 * Port: the sink's cursor in the audit log (`audit_sink`), held under a
 * lease so that of several servers one sends at a time.
 */
export abstract class AuditSinkCursor {
  /**
   * Takes (or renews) the lease for `holder` for `leaseMs` and answers the
   * cursor; undefined while another holder's lease runs; `ahead` when the
   * cursor, or an event, lies past every transaction of this database
   * (restored from another server's backup), where reading on would skip
   * events for good. That state is kept (`blocked`) until the operator's
   * recipe clears it. Runs as a statement of its own, outside any
   * transaction that has written.
   */
  abstract claim(
    holder: string,
    leaseMs: number,
  ): Promise<AuditPosition | undefined | 'ahead'>;

  /** Up to `limit` events after `after`, in order, only settled ones. */
  abstract read(after: AuditPosition, limit: number): Promise<SinkEntry[]>;

  /**
   * Moves the cursor from `from` to `to` while `holder` holds the lease;
   * false (nothing moved) when it does not, or the cursor is elsewhere.
   */
  abstract advance(
    holder: string,
    from: AuditPosition,
    to: AuditPosition,
  ): Promise<boolean>;

  /** Gives the lease up, when `holder` has it (a server shutting down), so another can send at once. */
  abstract release(holder: string): Promise<void>;

  /** The cursor as it stands (`SINK_START` before the first delivery). */
  abstract position(): Promise<AuditPosition>;
}

/** The operator's audit settings, as the actions need them. */
export abstract class AuditSettings {
  /** Whether a sink is set (`CCMS_AUDIT_SINK_URL`). */
  abstract readonly sinkEnabled: boolean;
  /** How many days events are kept (`CCMS_AUDIT_KEEP_DAYS`); undefined: for ever. */
  abstract readonly keepDays: number | undefined;
  /** How many days read events are kept (`CCMS_AUDIT_READ_KEEP_DAYS`, #877). */
  abstract readonly readKeepDays: number;
}

/** Whether `a` lies before `b` in the sink's order. */
export function positionBefore(a: AuditPosition, b: AuditPosition): boolean {
  const tx = BigInt(a.tx) - BigInt(b.tx);
  return tx < 0n || (tx === 0n && BigInt(a.id) < BigInt(b.id));
}
