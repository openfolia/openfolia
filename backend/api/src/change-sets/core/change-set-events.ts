import type { Transaction } from '../../base/core/unit-of-work.js';

/** A change set's workflow event, for the outbox. */
export interface ChangeSetEvent {
  /** `change-set.submit`, `change-set.return`, `change-set.approve`, … */
  readonly topic: string;
  /** Unique per topic: an event with a key in use is not written again. */
  readonly key: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Port: the outbox rows of change-set workflow transitions, written in the
 * transaction that makes the transition and records its audit event, for
 * later consumers (comments, the review screen, notifications) to read in
 * order.
 */
export abstract class ChangeSetEvents {
  /** Writes `event` inside `tx`; false (nothing written) when its key is in use. */
  abstract emit(tx: Transaction, event: ChangeSetEvent): Promise<boolean>;
}
