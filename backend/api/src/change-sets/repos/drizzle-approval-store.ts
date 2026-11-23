import { Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import type { Approval, Requirement } from '../core/approval.js';
import { ApprovalStore } from '../core/approval-store.js';
import type { ChangeSetAuthor } from '../core/change-set.js';
import { changeSetApprovals } from './change-set-approvals.tables.js';

/** `ApprovalStore` over the `change_set_approvals` table. */
@Injectable()
export class DrizzleApprovalStore extends ApprovalStore {
  async add(tx: Transaction, approval: Omit<Approval, 'at'>): Promise<boolean> {
    const inserted = await drizzleOf(tx)
      .insert(changeSetApprovals)
      .values({
        changeSetId: approval.changeSetId,
        requirement: approval.requirement,
        approverKind: approval.approver.kind,
        approverId: approval.approver.id,
        head: approval.head,
        self: approval.self,
      })
      .onConflictDoNothing()
      .returning({ id: changeSetApprovals.id });
    return inserted.length > 0;
  }

  async listOf(tx: Transaction, changeSetId: string): Promise<Approval[]> {
    const rows = await drizzleOf(tx)
      .select()
      .from(changeSetApprovals)
      .where(eq(changeSetApprovals.changeSetId, changeSetId))
      .orderBy(asc(changeSetApprovals.id));
    return rows.map((row) => ({
      changeSetId: row.changeSetId,
      requirement: row.requirement as Requirement,
      approver: {
        kind: row.approverKind as ChangeSetAuthor['kind'],
        id: row.approverId,
      },
      head: row.head,
      self: row.self,
      at: row.approvedAt,
    }));
  }

  async removeAllOf(tx: Transaction, changeSetId: string): Promise<number> {
    const removed = await drizzleOf(tx)
      .delete(changeSetApprovals)
      .where(eq(changeSetApprovals.changeSetId, changeSetId))
      .returning({ id: changeSetApprovals.id });
    return removed.length;
  }
}
