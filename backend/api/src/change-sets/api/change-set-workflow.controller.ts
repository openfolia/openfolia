import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  ApiConflictResponse,
  ApiUnprocessableEntityResponse,
  ApiServiceUnavailableResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import {
  JsonApi,
  PageParams,
  Paged,
} from '../../base/api/json-api.decorators.js';
import { ErrorDocument, toPagedDocument } from '../../base/api/json-api.js';
import type { PageRequest } from '../../base/core/paging.js';
import { ListRefreshConflictsAction } from '../core/actions/list-refresh-conflicts.action.js';
import { ApproveChangeSetAction } from '../core/actions/approve-change-set.action.js';
import { GetChangeSetReviewAction } from '../core/actions/get-change-set-review.action.js';
import { MergeChangeSetAction } from '../core/actions/merge-change-set.action.js';
import { CarryForwardChangeSetAction } from '../core/actions/carry-forward-change-set.action.js';
import { RebaseChangeSetAction } from '../core/actions/rebase-change-set.action.js';
import type { CarryConflict } from '../core/carry-change.js';
import { RefreshChangeSetAction } from '../core/actions/refresh-change-set.action.js';
import { ReturnChangeSetAction } from '../core/actions/return-change-set.action.js';
import { SignOffChangeSetAction } from '../core/actions/sign-off-change-set.action.js';
import { SubmitChangeSetAction } from '../core/actions/submit-change-set.action.js';
import {
  ChangeSetDocument,
  toChangeSetResource,
} from './change-set.resources.js';
import {
  CarryForwardDocument,
  RebaseDocument,
  MAX_CARRY_CONFLICTS,
  MergeDocument,
  RefreshChangeSetDocument,
  RefreshConflictPageDocument,
  RefreshDocument,
  ReviewDocument,
  toRefreshConflictResource,
  toReviewMeta,
  TransitionDocument,
} from './workflow.resources.js';

const DATABASE_TIMEOUT =
  '`database-timeout`: the transaction waited too long for a row held elsewhere, or a statement ran too long (`CCMS_DATABASE_WRITE_LOCK_TIMEOUT_MS`, `CCMS_DATABASE_WRITE_STATEMENT_TIMEOUT_MS`); nothing of it was written to the database (a merge may have landed in Git already: it is recorded by the reconciler). `Retry-After` says when to try again.';

const ID_PARAMETER = {
  name: 'changeSetId',
  description:
    'The change set’s ID (a UUID). One that names no change set, malformed or not, is 404.',
  schema: { type: 'string', format: 'uuid' },
} as const;

const NOT_FOUND = {
  description:
    '`not-found`: no change set with this ID (or another author’s, for an actor without `content.read.draft`).',
  standardSchema: ErrorDocument,
};

/** Who counts as a change set's author (#597). */
const AUTHORS =
  'its author: whoever started it or wrote a commit it holds, the writers of what a carry-forward or a move onto a rewritten base carried into it included';
const FOUR_EYES = ` Never by ${AUTHORS} (403; 409 \`too-many-commits\` when its line is too long to read whole).`;

/** Approve's and sign-off's author rule (#588). */
const selfRule = (name: 'approve' | 'sign-off') =>
  ` Not by ${AUTHORS} (403; 409 \`too-many-commits\` when its line is too long to read whole), unless the installation’s self-approval rule (\`GET /settings\`) is ${name === 'approve' ? '`review` or `review-and-sign-off`' : '`review-and-sign-off`'}: then their scope is checked as anyone’s, and the approval, its audit event and \`meta.review\` carry \`self: true\` (\`selfApproved\`).`;

const HEAD_MOVED =
  '`head-moved`: its branch moved after it was submitted (pushed to outside the API), so no approval holds; it has been returned to draft (`meta.reviewHead`, `meta.head`).';

const comment = (body: TransitionDocument) => {
  const text = body?.meta?.comment;
  return text === undefined ? {} : { comment: text };
};

/**
 * The review workflow's transitions, one route each, as abandoning is
 * (`POST /change-sets/:changeSetId/abandon`): each needs its own
 * permission, which the route documents. Every transition writes one audit
 * event with its comment and one outbox row (`core/workflow.ts`).
 */
@ApiTags('change-sets')
@Controller('change-sets/:changeSetId')
@JsonApi()
export class ChangeSetWorkflowController {
  constructor(
    private readonly submitChangeSet: SubmitChangeSetAction,
    private readonly returnChangeSet: ReturnChangeSetAction,
    private readonly approveChangeSet: ApproveChangeSetAction,
    private readonly signOffChangeSet: SignOffChangeSetAction,
    private readonly mergeChangeSet: MergeChangeSetAction,
    private readonly carryForwardChangeSet: CarryForwardChangeSetAction,
    private readonly rebaseChangeSet: RebaseChangeSetAction,
    private readonly changeSetReview: GetChangeSetReviewAction,
    private readonly refreshChangeSet: RefreshChangeSetAction,
    private readonly refreshConflicts: ListRefreshConflictsAction,
  ) {}

  @Get('review')
  @ApiOperation({
    summary: 'Where a change set’s review stands',
    description:
      'Read only: every approval it needs (`required`: the review, and a sign-off for each restricted module type it changes), the approvals of its review head (of its branch’s head while a draft) and what is still `pending`, and the approvals that `lapsed` (their approver lost the role or scope), all as approve, sign-off and merge judge them; `granted` is always empty. The change set is found as `GET /change-sets/{changeSetId}` finds it. Needs `content.read.draft`, as reviewing does.',
  })
  @ApiParam(ID_PARAMETER)
  @ApiOkResponse({ standardSchema: ReviewDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    description:
      '`branch-missing` (a draft whose branch is gone), `base-missing` (its base branch is gone).',
    standardSchema: ErrorDocument,
  })
  @ApiPermission('content.read.draft')
  async review(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') id: string,
  ): Promise<z.infer<typeof ReviewDocument>> {
    const outcome = await this.changeSetReview.handle({ actor, id });
    return {
      data: toChangeSetResource(outcome.changeSet),
      meta: { review: toReviewMeta(outcome) },
    };
  }

  @Post('submit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit a change set for review',
    description:
      '`draft` → `in-review`: its branch’s head becomes its `reviewHead`, what approvals are of and a merge merges. Then it is frozen (no lock, save or save point) until a reviewer returns it; its locks are kept. By its author, or an editor whose `content.edit` scope covers everything it changes. Audited as `change-set.submit`.',
  })
  @ApiParam(ID_PARAMETER)
  @ApiOkResponse({ standardSchema: ChangeSetDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    description:
      '`invalid-state` (not a draft; `meta.state`), `uncommitted-working-copies` (make a save point or discard them first; `meta.count`), `no-changes`, `branch-moved`.',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`translation-record-protected`: a page design or manual the change set changed, which an update from the base reported conflicting, holds a translation record that differs from its base commit’s in a language whose translation you do not manage (`meta.subject`, `meta.languages`): update again, or save it with the base commit’s record.',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description: DATABASE_TIMEOUT,
    standardSchema: ErrorDocument,
  })
  @ApiPermission('content.edit')
  async submit(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') id: string,
    @Body({ schema: TransitionDocument }) body: TransitionDocument,
  ): Promise<z.infer<typeof ChangeSetDocument>> {
    const changeSet = await this.submitChangeSet.handle({
      actor,
      id,
      ...comment(body),
    });
    return { data: toChangeSetResource(changeSet) };
  }

  @Post('return')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Return a change set to its author',
    description: `\`in-review\` or \`approved\` (not merged, say after a conflict) → \`draft\`, with the changes requested in the comment. Its review head is cleared and its approvals removed; its locks stay. By a reviewer whose \`content.review\` scope covers everything it changes.${FOUR_EYES} Audited as \`change-set.return\`.`,
  })
  @ApiParam(ID_PARAMETER)
  @ApiOkResponse({ standardSchema: ChangeSetDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    description:
      '`invalid-state`: not in review or approved (`meta.state`; `merged` when a merge that had landed unrecorded is recorded now).',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description: DATABASE_TIMEOUT,
    standardSchema: ErrorDocument,
  })
  @ApiPermission('content.review')
  async return(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') id: string,
    @Body({ schema: TransitionDocument }) body: TransitionDocument,
  ): Promise<z.infer<typeof ChangeSetDocument>> {
    const changeSet = await this.returnChangeSet.handle({
      actor,
      id,
      ...comment(body),
    });
    return { data: toChangeSetResource(changeSet) };
  }

  @Post('approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve a change set in review',
    description: `Records the review approval of its review head, by a reviewer whose \`content.review\` scope covers everything it changes.${selfRule('approve')} It becomes \`approved\` once nothing is pending: the review, and a sign-off for each restricted module type it changes; until then it stays \`in-review\`. \`meta.review\` says where it stands. Audited as \`change-set.approve\`.`,
  })
  @ApiParam(ID_PARAMETER)
  @ApiOkResponse({ standardSchema: ReviewDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    description: `\`invalid-state\` (not in review; \`meta.state\`), \`already-approved\`, ${HEAD_MOVED}`,
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description: DATABASE_TIMEOUT,
    standardSchema: ErrorDocument,
  })
  @ApiPermission('content.review')
  async approve(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') id: string,
    @Body({ schema: TransitionDocument }) body: TransitionDocument,
  ): Promise<z.infer<typeof ReviewDocument>> {
    const outcome = await this.approveChangeSet.handle({
      actor,
      id,
      ...comment(body),
    });
    return {
      data: toChangeSetResource(outcome.changeSet),
      meta: { review: toReviewMeta(outcome) },
    };
  }

  @Post('sign-off')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign off a change set’s restricted module types',
    description: `The extra approval restricted module types (\`restricted: true\` in the configuration) need: one sign-off per such type it changes whose changed modules all lie within the approver’s \`content.approve\` scope.${selfRule('sign-off')} Otherwise as approve. Audited as \`change-set.sign-off\`.`,
  })
  @ApiParam(ID_PARAMETER)
  @ApiOkResponse({ standardSchema: ReviewDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    description: `\`invalid-state\`, \`no-sign-off-needed\` (it changes no module of a restricted type), \`already-approved\`, ${HEAD_MOVED}`,
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description: DATABASE_TIMEOUT,
    standardSchema: ErrorDocument,
  })
  @ApiPermission('content.approve')
  async signOff(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') id: string,
    @Body({ schema: TransitionDocument }) body: TransitionDocument,
  ): Promise<z.infer<typeof ReviewDocument>> {
    const outcome = await this.signOffChangeSet.handle({
      actor,
      id,
      ...comment(body),
    });
    return {
      data: toChangeSetResource(outcome.changeSet),
      meta: { review: toReviewMeta(outcome) },
    };
  }

  @Post('merge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Merge an approved change set into its base',
    description:
      'Merges exactly its review head into its base branch (`baseRef`) with a merge commit carrying one `Approved-by` trailer per approver, then marks it `merged`, releases its locks and records `change-set.merge`. By a publisher whose `release.publish` scope covers everything it changes. Each approval counts only while its approver still holds the role and scope it took. A conflict changes nothing: the change set stays approved but unmerged; nor does a merge that would leave content invalid under the configuration it keeps (422 `config-in-use`).',
  })
  @ApiParam(ID_PARAMETER)
  @ApiOkResponse({ standardSchema: MergeDocument })
  @ApiUnprocessableEntityResponse({
    description:
      '`config-in-use`: the merged tree would hold content invalid under the configuration it keeps (a value one side removed, the other uses); one error per usage, `source.pointer` naming the subject and block, `meta.subject`, `meta.issue`.',
    standardSchema: ErrorDocument,
  })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    description: `\`merge-conflict\` (\`meta.conflicts\`: \`{ path, kinds }\`, at most 100; \`meta.total\`), \`invalid-state\`, \`not-approved\` (\`meta.pending\`), \`approval-lapsed\` (an approval it needs no longer holds: its approver lost the role or scope it took; \`meta.pending\`, \`meta.lapsed\`: \`{ requirement, approver }\`), \`base-moved\` (try again), \`base-missing\`, \`base-rewritten\` (the base no longer holds the change set’s base commit), ${HEAD_MOVED}`,
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description: DATABASE_TIMEOUT,
    standardSchema: ErrorDocument,
  })
  @ApiPermission('release.publish')
  async merge(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') id: string,
    @Body({ schema: TransitionDocument }) body: TransitionDocument,
  ): Promise<z.infer<typeof MergeDocument>> {
    const outcome = await this.mergeChangeSet.handle({
      actor,
      id,
      ...comment(body),
    });
    return {
      data: toChangeSetResource(outcome.changeSet),
      meta: {
        merge: { commit: outcome.commit, fastForward: outcome.fastForward },
      },
    };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update a change set from its base',
    description:
      'Merges its base branch’s head into its branch (a fast-forward when it has no commits of its own), so it holds what was merged there since it started; its `baseCommit` moves on to that head, and what it changes is counted from there. A draft, by its author only. A conflict writes nothing to Git: 409 `refresh-conflict` lists the files, and each module, manual, configuration or term among them is recorded as reported (`GET /change-sets/{changeSetId}/refresh-conflicts`). To resolve, make them what they should be in the editor (saving them), then update again with them in `meta.keep`, or name those to keep as they are in `meta.keepMine` (“Keep my version”): their working copies are committed first, as a save point, and where they conflict the change set’s version is kept. A subject in `meta.keep` whose keeping matters (its file conflicts, or its working copy is in the way) must have been saved since it was reported, against a base whose file is still the one reported: else 409 `refresh-unresolved`, and nothing is written. The reports are cleared once an update goes through. Audited as `change-set.refresh`, with the subjects resolved by editing (`resolvedByEditing`) and kept by choice (`keptByChoice`). Working copies whose file did not change move on to the new head. The merge commit gets an outbox row like a save point.',
  })
  @ApiParam(ID_PARAMETER)
  @ApiOkResponse({ standardSchema: RefreshDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    description:
      '`refresh-conflict` (`meta.conflicts`: `{ path, subject?, kinds }`, at most 100; `meta.total`; kinds are git’s, `contents`, `modify/delete`, …, or `working-copy`: a working copy not yet committed of a file the base changed: commit or discard it first, or keep it), `refresh-unresolved` (subjects in `meta.keep` not saved since they were reported, or whose file the base changed again since: `meta.unresolved`: `{ path, subject }`; `meta.total`; save them or name them in `meta.keepMine`), `invalid-state` (not a draft; `meta.state`), `lock-required` (a kept subject that conflicts: take its lock first; `meta.subject`), `stale-working-copy` and the other answers of a save point (committing the kept working copies), `base-missing` (its base branch is gone, or is a draft you may not read), `base-rewritten` (the base no longer holds its base commit), `branch-missing`, `branch-moved` (its branch kept moving; try again), `unrelated-histories`.',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`duplicate-subject` (a subject named twice in `meta.keep` or `meta.keepMine`, or in both), `translation-record-protected` (a kept page design or manual whose translation record differs from the base’s in a language whose translation you do not manage: save it with the base branch’s record as it is now first), and the answers of a save point for a kept working copy (`invalid-working-copy`, …).',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description: DATABASE_TIMEOUT,
    standardSchema: ErrorDocument,
  })
  @ApiPermission('content.edit')
  async refresh(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') id: string,
    @Body({ schema: RefreshChangeSetDocument }) body: RefreshChangeSetDocument,
  ): Promise<z.infer<typeof RefreshDocument>> {
    const outcome = await this.refreshChangeSet.handle({
      actor,
      id,
      ...(body?.meta?.keep !== undefined && { keep: body.meta.keep }),
      ...(body?.meta?.keepMine !== undefined && {
        keepMine: body.meta.keepMine,
      }),
      ...(body?.meta?.comment !== undefined && {
        comment: body.meta.comment,
      }),
    });
    return {
      data: toChangeSetResource(outcome.changeSet),
      meta: {
        refresh: {
          updated: outcome.updated,
          head: outcome.head,
          fastForward: outcome.fastForward,
          savePoint: outcome.savePoint ?? null,
        },
      },
    };
  }

  @Get('refresh-conflicts')
  @Paged()
  @ApiOperation({
    summary: 'List the conflicts an update reported',
    description:
      'The modules, manuals, configuration and terms an update from the base reported as conflicting (`refresh-conflict`, or `refresh-unresolved`), in subject order, each with the base head it was reported against and when its working copy was first saved since (`savedAt`): what “Update again” may keep (#437). Cleared once an update goes through. By the change set’s author only (403 for anyone else who reads drafts). Needs the `content.edit` permission.',
  })
  @ApiParam(ID_PARAMETER)
  @ApiOkResponse({ standardSchema: RefreshConflictPageDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiPermission('content.edit')
  async listRefreshConflicts(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @PageParams() page: PageRequest,
    @Param('changeSetId') id: string,
  ): Promise<z.infer<typeof RefreshConflictPageDocument>> {
    const result = await this.refreshConflicts.handle({ actor, id, page });
    return toPagedDocument(req, page, result, toRefreshConflictResource(id));
  }

  @Post('carry-forward')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Carry a fix forward to main',
    description:
      'For a change set merged into a maintenance line: starts a new draft change set on `main` and applies the same change there, three-way (its own diff only, never what the line held before it). Each module, manual, configuration or term it changes is locked for the new change set, and what applied cleanly is committed there as a save point; what did not (a conflict, a lock another change set holds, a subject outside the actor’s scope on `main`, a file that is no subject) is left as it is on `main` and listed in `meta.carryForward.conflicts`, with the blocks to apply by hand where it can tell. Never automatic. Records `change-set.create` (with `carriedForwardFrom`) on the new change set and `change-set.carry-forward` on this one, with an outbox row naming both. By its author, or an editor whose `content.edit` scope covers everything it changes.',
  })
  @ApiParam(ID_PARAMETER)
  @ApiOkResponse({ standardSchema: CarryForwardDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    description:
      '`invalid-state`: it is not merged (`meta.state`). `not-on-maintenance-line`: it was merged elsewhere. `already-carried-forward`: a change set carrying it forward exists and is not abandoned (`meta.changeSetId`). `no-changes`: `main` holds the change already. `branch-missing`: there is no `main`.',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description: `\`too-many-changes\`: it changes more files than one commit takes.`,
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description: DATABASE_TIMEOUT,
    standardSchema: ErrorDocument,
  })
  @ApiPermission('content.edit')
  async carryForward(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') id: string,
    @Body({ schema: TransitionDocument }) _body: TransitionDocument,
  ): Promise<z.infer<typeof CarryForwardDocument>> {
    const outcome = await this.carryForwardChangeSet.handle({ actor, id });
    return {
      data: toChangeSetResource(outcome.changeSet),
      meta: {
        carryForward: {
          from: outcome.source.id,
          commit: outcome.commit ?? null,
          applied: [...outcome.applied],
          conflicts: listedConflicts(outcome.conflicts),
          total: outcome.conflicts.length,
        },
      },
    };
  }

  @Post('rebase')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Move a change set onto its rewritten base’s current head',
    description:
      'For an open change set whose base branch was rewritten (`meta.base.state: "rewritten"` on `GET /change-sets/{changeSetId}`: its base commit is no longer in the base’s history, after a force-push or a restore), which can therefore be neither updated nor merged: starts a new draft change set on the base’s current head, with the same title and description, and applies the change set’s own changes there (its base commit to its branch’s head), three-way. Its working copies are committed first, as a save point, for a draft. Each module, manual, configuration or term it changes is locked for the new change set, and what applied cleanly is committed there as a save point; what did not (a conflict, a lock another change set holds, a subject outside your scope, a file that is no subject) is left as the base has it and listed in `meta.rebase.conflicts`, with the blocks to apply by hand where it can tell. The old change set is abandoned, superseded by the new one (`meta.supersededBy`, `meta.supersedes`); its branch and comments stay readable. Approvals do not carry over. Records `change-set.create` (with `supersedes`) on the new change set, and `change-set.abandon` (with `supersededBy`) and `change-set.rebase` on the old one. By its author only (it closes the change set; 403 for anyone else); the new change set is yours too. Moved already: 409 `already-superseded`, naming the new one in `meta.changeSetId`.',
  })
  @ApiParam(ID_PARAMETER)
  @ApiOkResponse({ standardSchema: RebaseDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    description:
      '`invalid-state`: it is no longer open (`meta.state`). `base-not-rewritten`: its base still holds its base commit: update it instead. `already-superseded`: a change set not abandoned holds its changes already (`meta.changeSetId`). `uncommitted-working-copies`: it has working copies only its author can commit, or it is in review (`meta.subjects`). `base-missing`: its base branch is gone, or is a draft you may not read. `branch-missing`: its branch is gone. The answers of a save point for its working copies (`stale-working-copy`, …).',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`too-many-changes`: it changes more files than one commit takes. The answers of a save point for its working copies (`invalid-working-copy`, …).',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description: DATABASE_TIMEOUT,
    standardSchema: ErrorDocument,
  })
  @ApiPermission('content.edit')
  async rebase(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') id: string,
    @Body({ schema: TransitionDocument }) _body: TransitionDocument,
  ): Promise<z.infer<typeof RebaseDocument>> {
    const outcome = await this.rebaseChangeSet.handle({ actor, id });
    return {
      data: toChangeSetResource(outcome.changeSet),
      meta: {
        rebase: {
          from: outcome.source.id,
          commit: outcome.commit ?? null,
          applied: [...outcome.applied],
          conflicts: listedConflicts(outcome.conflicts),
          total: outcome.conflicts.length,
        },
      },
    };
  }
}

/** The first `MAX_CARRY_CONFLICTS` conflicts, as the resources list them. */
function listedConflicts(conflicts: readonly CarryConflict[]) {
  return conflicts.slice(0, MAX_CARRY_CONFLICTS).map((c) => ({
    path: c.path,
    ...(c.subject && { subject: c.subject }),
    kinds: [...c.kinds],
    ...(c.blockIds && { blockIds: [...c.blockIds] }),
  }));
}
