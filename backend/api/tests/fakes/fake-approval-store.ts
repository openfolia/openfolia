import type { Transaction } from '../../src/base/core/unit-of-work.js';
import type { Approval } from '../../src/change-sets/core/approval.js';
import { ApprovalStore } from '../../src/change-sets/core/approval-store.js';
import { fakeOf } from './fake-unit-of-work.js';

/**
 * Approvals in memory, with `FakeUnitOfWork`: writes are kept only when
 * their transaction commits. `approvals` holds them oldest first.
 */
export class FakeApprovalStore extends ApprovalStore {
  approvals: Approval[] = [];

  async add(tx: Transaction, approval: Omit<Approval, 'at'>) {
    const transaction = fakeOf(tx);
    const same = (a: Omit<Approval, 'at'>) =>
      a.changeSetId === approval.changeSetId &&
      a.requirement === approval.requirement &&
      a.approver.kind === approval.approver.kind &&
      a.approver.id === approval.approver.id;
    if (this.approvals.some(same)) return false;
    const made = { ...approval, at: transaction.startedAt };
    transaction.onCommit(() => this.approvals.push(made));
    // Visible to the rest of the transaction, as a database row would be.
    this.pending.push({ tx, approval: made });
    return true;
  }

  private pending: { tx: Transaction; approval: Approval }[] = [];

  async listOf(tx: Transaction, changeSetId: string) {
    fakeOf(tx);
    return [
      ...this.approvals,
      ...this.pending.filter((p) => p.tx === tx).map((p) => p.approval),
    ].filter((a) => a.changeSetId === changeSetId);
  }

  async removeAllOf(tx: Transaction, changeSetId: string) {
    const transaction = fakeOf(tx);
    const count = this.approvals.filter(
      (a) => a.changeSetId === changeSetId,
    ).length;
    transaction.onCommit(() => {
      this.approvals = this.approvals.filter(
        (a) => a.changeSetId !== changeSetId,
      );
    });
    return count;
  }
}
