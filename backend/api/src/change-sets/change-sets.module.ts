import { AssetsModule } from '../assets/assets.module.js';
import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { ContentModule } from '../content/content.module.js';
import { AuthoredBranchesModule } from './authored-branches.module.js';
import { ChangeSetReconciler } from './api/change-set-reconciler.js';
import { ChangeSetsController } from './api/change-sets.controller.js';
import { LocksController } from './api/locks.controller.js';
import { WorkingCopiesController } from './api/working-copies.controller.js';
import { AbandonChangeSetAction } from './core/actions/abandon-change-set.action.js';
import { EditChangeSetAction } from './core/actions/edit-change-set.action.js';
import { RevertChangesAction } from './core/actions/revert-changes.action.js';
import { AcquireLockAction } from './core/actions/acquire-lock.action.js';
import { BreakLocksAction } from './core/actions/break-locks.action.js';
import { BreakLockAction } from './core/actions/break-lock.action.js';
import { CommitWorkingCopiesAction } from './core/actions/commit-working-copies.action.js';
import { ChangeSetBehind } from './core/change-set-behind.js';
import { RefreshChangeSetAction } from './core/actions/refresh-change-set.action.js';
import { ReconcileChangeSetCommitsAction } from './core/actions/reconcile-change-set-commits.action.js';
import { FindMissingChangeSetBranchesAction } from './core/actions/find-missing-change-set-branches.action.js';
import { ChangeSetCommits } from './core/change-set-commits.js';
import { ChangeSetBranchPresence } from './core/change-set-branch-presence.js';
import { ChangeSetTouches } from './core/change-set-touches.js';
import { LockHolding } from './core/lock-holding.js';
import { ListChangeSetChangesAction } from './core/actions/list-change-set-changes.action.js';
import { CommitIntents } from './core/commit-intents.js';
import { DrizzleCommitIntents } from './repos/drizzle-commit-intents.js';
import { CommitRecorder } from './core/commit-recorder.js';
import { DrizzleChangeSetCommits } from './repos/drizzle-change-set-commits.js';
import { CommitsController } from './api/commits.controller.js';
import { DiscardWorkingCopyAction } from './core/actions/discard-working-copy.action.js';
import { GetWorkingCopyAction } from './core/actions/get-working-copy.action.js';
import { SaveWorkingCopyAction } from './core/actions/save-working-copy.action.js';
import { CreateChangeSetAction } from './core/actions/create-change-set.action.js';
import { GetChangeSetAction } from './core/actions/get-change-set.action.js';
import { ListChangeSetsAction } from './core/actions/list-change-sets.action.js';
import {
  GetLockAction,
  ListLocksAction,
} from './core/actions/list-locks.action.js';
import { ReconcileChangeSetBranchesAction } from './core/actions/reconcile-change-set-branches.action.js';
import { ReleaseLockAction } from './core/actions/release-lock.action.js';
import { ChangeSetBranches } from './core/change-set-branches.js';
import { LockStore } from './core/lock-store.js';
import { DrizzleLockStore } from './repos/drizzle-lock-store.js';
import { GitChangeSetBranches } from './repos/git-change-set-branches.js';
import { ChangeSetWorkflowController } from './api/change-set-workflow.controller.js';
import { ApproveChangeSetAction } from './core/actions/approve-change-set.action.js';
import { GetChangeSetReviewAction } from './core/actions/get-change-set-review.action.js';
import { MergeChangeSetAction } from './core/actions/merge-change-set.action.js';
import { CarryForwardChangeSetAction } from './core/actions/carry-forward-change-set.action.js';
import { CarryChange } from './core/carry-change.js';
import { RebaseChangeSetAction } from './core/actions/rebase-change-set.action.js';
import { ChangeSetSupersessions } from './core/supersessions.js';
import { DrizzleChangeSetSupersessions } from './repos/drizzle-supersessions.js';
import { CarryForwards } from './core/carry-forwards.js';
import { DrizzleCarryForwards } from './repos/drizzle-carry-forwards.js';
import { ListRefreshConflictsAction } from './core/actions/list-refresh-conflicts.action.js';
import { DeprecationWebhookHandler } from './core/deprecation-webhook-handler.js';
import { RefreshConflictStore } from './core/refresh-conflicts.js';
import { DrizzleRefreshConflicts } from './repos/drizzle-refresh-conflicts.js';
import { ReconcileChangeSetMergesAction } from './core/actions/reconcile-change-set-merges.action.js';
import { ReturnChangeSetAction } from './core/actions/return-change-set.action.js';
import { SignOffChangeSetAction } from './core/actions/sign-off-change-set.action.js';
import { SubmitChangeSetAction } from './core/actions/submit-change-set.action.js';
import { ApprovalStanding } from './core/approval-standing.js';
import { ApprovalStore } from './core/approval-store.js';
import { ChangeSetEvents } from './core/change-set-events.js';
import { DeprecationEvents } from './core/deprecation-events.js';
import { Workflow } from './core/workflow.js';
import { ChangeSetAuthors } from './core/change-set-authors.js';
import { DrizzleApprovalStore } from './repos/drizzle-approval-store.js';
import { DrizzleChangeSetEvents } from './repos/drizzle-change-set-events.js';

/**
 * Change sets: drafts on their own branch (Git) with their state in
 * Postgres. Start, list, read and abandon; a timer removes branches whose
 * change set was never recorded. Locks on modules and manuals, held by
 * change sets. Working copies: the editor's autosaves, in Postgres, and
 * save points committing them to the branch. The review workflow: submit,
 * return, approve, sign off and merge (`core/workflow.ts`).
 */
@Module({
  // `ChangeSetStore` comes from `AuthoredBranchesModule` (global),
  // `WorkingCopyStore` from `WorkingCopyReadsModule` (global);
  // `UserDirectory` from `AccessModule` (approvals are checked against
  // their approvers' roles now: `ApprovalStanding`).
  // `AssetUploads` from `AssetsModule`: saves check the files they name were not deleted.
  // `MaintenanceLineStore` from `MaintenanceLineStoreModule` (global): change sets on a line, carrying forward.
  imports: [
    ContentModule,
    AuditModule,
    AuthoredBranchesModule,
    AccessModule,
    AssetsModule,
    SettingsModule,
  ],
  controllers: [
    ChangeSetsController,
    LocksController,
    WorkingCopiesController,
    CommitsController,
    ChangeSetWorkflowController,
  ],
  providers: [
    // How the deprecations' webhook events are made, and who may know of them (#974).
    DeprecationWebhookHandler,
    ListChangeSetsAction,
    GetChangeSetAction,
    CreateChangeSetAction,
    AbandonChangeSetAction,
    EditChangeSetAction,
    RevertChangesAction,
    ReconcileChangeSetBranchesAction,
    ChangeSetReconciler,
    ListLocksAction,
    GetLockAction,
    AcquireLockAction,
    ReleaseLockAction,
    BreakLockAction,
    BreakLocksAction,
    SaveWorkingCopyAction,
    GetWorkingCopyAction,
    DiscardWorkingCopyAction,
    CommitWorkingCopiesAction,
    ReconcileChangeSetCommitsAction,
    FindMissingChangeSetBranchesAction,
    CommitRecorder,
    Workflow,
    ChangeSetAuthors,
    DeprecationEvents,
    ApprovalStanding,
    SubmitChangeSetAction,
    ReturnChangeSetAction,
    ApproveChangeSetAction,
    GetChangeSetReviewAction,
    SignOffChangeSetAction,
    MergeChangeSetAction,
    CarryChange,
    CarryForwardChangeSetAction,
    RebaseChangeSetAction,
    RefreshChangeSetAction,
    ListRefreshConflictsAction,
    ReconcileChangeSetMergesAction,
    ListChangeSetChangesAction,
    ChangeSetTouches,
    LockHolding,
    ChangeSetBranchPresence,
    ChangeSetBehind,
    { provide: ApprovalStore, useClass: DrizzleApprovalStore },
    { provide: ChangeSetEvents, useClass: DrizzleChangeSetEvents },
    { provide: LockStore, useClass: DrizzleLockStore },
    { provide: ChangeSetBranches, useClass: GitChangeSetBranches },
    { provide: ChangeSetCommits, useClass: DrizzleChangeSetCommits },
    { provide: CommitIntents, useClass: DrizzleCommitIntents },
    { provide: CarryForwards, useClass: DrizzleCarryForwards },
    {
      provide: ChangeSetSupersessions,
      useClass: DrizzleChangeSetSupersessions,
    },
    { provide: RefreshConflictStore, useClass: DrizzleRefreshConflicts },
  ],
  // For comments (#24): change sets found as their routes find them, and their branches.
  // `LockStore` for deactivating a user (`AccessAdminModule`), which releases its locks.
  // For imports (#256): an import is written through the change-set actions.
  // For translation imports (#51): the same, and abandoning the change set of one that failed.
  exports: [
    CreateChangeSetAction,
    AbandonChangeSetAction,
    AcquireLockAction,
    SaveWorkingCopyAction,
    CommitWorkingCopiesAction,
    // For marking a translation current (#656): its working copy goes again when the save point fails.
    DiscardWorkingCopyAction,
    ChangeSetTouches,
    GetChangeSetAction,
    GetWorkingCopyAction,
    ChangeSetBranches,
    ListChangeSetChangesAction,
    LockStore,
    // For renaming modules (#265, `ModuleRenamesModule`): the save-point path.
    CommitRecorder,
    CommitIntents,
  ],
})
export class ChangeSetsModule {}
