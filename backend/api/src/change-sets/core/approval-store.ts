import type { Transaction } from '../../base/core/unit-of-work.js';
import type { Approval } from './approval.js';

/**
 * Port: the approvals of change sets in review (Postgres). One per change
 * set, requirement and approver; they are operational state, removed when
 * the change set is returned to draft (the audit log keeps every one).
 */
export abstract class ApprovalStore {
  /**
   * Records `approval` inside `tx`. False, writing nothing, when the same
   * approver has met that requirement of the change set already.
   */
  abstract add(
    tx: Transaction,
    approval: Omit<Approval, 'at'>,
  ): Promise<boolean>;

  /** The change set's approvals, oldest first, read inside `tx`. */
  abstract listOf(tx: Transaction, changeSetId: string): Promise<Approval[]>;

  /** Removes every approval of the change set inside `tx`; returns how many. */
  abstract removeAllOf(tx: Transaction, changeSetId: string): Promise<number>;
}
