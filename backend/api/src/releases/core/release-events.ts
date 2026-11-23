import type { Transaction } from '../../base/core/unit-of-work.js';

/** A release's event, for the outbox (#138). */
export interface ReleaseEvent {
  /**
   * `release.published` or `release.withdrawn` (keyed by the release's
   * ID: each written once per release), `release.output-failed` (#249,
   * keyed by the output and its retry count: once per failure), or
   * `release.output-recovered` (#551, keyed by the output: once), when an
   * output that was told failed becomes `done` after all (a late file, a
   * retry, its group's file).
   */
  readonly topic:
    | 'release.published'
    | 'release.withdrawn'
    | 'release.output-failed'
    | 'release.output-recovered';
  readonly key: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Port: the outbox rows of releases, written in the transaction that
 * publishes or withdraws the release and records its audit event, for
 * notifications (#252) and webhooks (#42) to read in order.
 */
export abstract class ReleaseEvents {
  /** Writes `event` inside `tx`; false (nothing written) when its key is in use. */
  abstract emit(tx: Transaction, event: ReleaseEvent): Promise<boolean>;
}
