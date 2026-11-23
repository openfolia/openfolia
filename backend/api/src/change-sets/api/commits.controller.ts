import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import { JsonApi } from '../../base/api/json-api.decorators.js';
import { ErrorDocument } from '../../base/api/json-api.js';
import { CommitWorkingCopiesAction } from '../core/actions/commit-working-copies.action.js';
import { RevertChangesAction } from '../core/actions/revert-changes.action.js';
import {
  CommitDocument,
  CreateCommitDocument,
  CreateRevertDocument,
  NoCommitDocument,
  RevertDocument,
  toCommitDocument,
  toRevertDocument,
} from './commit.resources.js';

const CHANGE_SET_ID = {
  name: 'changeSetId',
  description:
    'The change set’s ID (a UUID). One that names no change set, malformed or not, is 404.',
  schema: { type: 'string', format: 'uuid' },
} as const;

const DATABASE_TIMEOUT =
  '`database-timeout`: the transaction waited too long for a row held elsewhere, or a statement ran too long (`CCMS_DATABASE_WRITE_LOCK_TIMEOUT_MS`, `CCMS_DATABASE_WRITE_STATEMENT_TIMEOUT_MS`); nothing of it was written to the database, but the Git commit may have landed on the branch already: it is recorded by the next save point or reconciler pass, and a retry then finds nothing left to commit (200, `meta.commit` null). `Retry-After` says when to try again.';

const REVERT_DESCRIPTION = `Takes modules, manuals, terms or the configuration back out of the change set: one commit on its branch, made as a save point is, that puts each subject's file back as it is at the change set's base commit (a subject the change set created is deleted), then drops their working copies and releases their locks, with a \`change-set.revert\` audit event (and the commit's own, and one \`lock.release\` per lock). A subject whose file is unchanged and that has only a working copy makes no commit (\`meta.commit\` null). Only the change set's author, while it is a draft, and only for subjects whose lock it holds; scope is checked as for deleting the file at the head and changing it at the base. A configuration put back that content kept at the head no longer fits is 422 \`config-in-use\`; a page design the change set added, taken out while the configuration or a manual names it, is 409 \`design-in-use\` (#554). Needs the \`content.edit\` permission.`;

const DESCRIPTION = `A save point: commits the change set’s working copies (all, or \`subjects\`) and \`deletes\` (a deleted module’s translation record in its language with it) in one commit on its branch, each printed canonically, with the actor as author, then drops those working copies and records a \`change-set.commit\` audit event (and one \`<module|manual>.write\` or \`.delete\` per file). Only the change set’s author, while it is a draft, and only for subjects whose lock it holds; scope is checked again against the branch head, as for a save. Invalid content is refused (422, one error per problem). A page design still named by the configuration or a manual, as the commit leaves them, is not deleted (409 \`design-in-use\`, #554). A working copy holding exactly the committed file is dropped without a commit; when nothing changes, no commit is made (200). The client decides when (closing a module, submitting, every few minutes); the server has no timer. Needs the \`content.edit\` permission.`;

/** Save points: commits from working copies onto a change set's branch. */
@ApiTags('working copies')
@Controller('change-sets')
@JsonApi()
export class CommitsController {
  constructor(
    private readonly commitWorkingCopies: CommitWorkingCopiesAction,
    private readonly revertChanges: RevertChangesAction,
  ) {}

  @Post(':changeSetId/commits')
  @ApiOperation({ summary: 'Commit working copies', description: DESCRIPTION })
  @ApiParam(CHANGE_SET_ID)
  @ApiCreatedResponse({
    description: 'Committed.',
    standardSchema: CommitDocument,
  })
  @ApiOkResponse({
    description: 'Nothing changed: no commit.',
    standardSchema: NoCommitDocument,
  })
  @ApiNotFoundResponse({
    description: '`not-found`: no change set with this ID.',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description: DATABASE_TIMEOUT,
    standardSchema: ErrorDocument,
  })
  @ApiConflictResponse({
    description:
      '`lock-required`: the change set does not hold a subject’s lock (`meta.subject`). `stale-working-copy`: a subject’s file changed on the branch since its working copy was based on it (`meta.subjects`, `meta.head`). `branch-moved`: the branch moved while committing, twice (try again). `working-copy-changed`: working copies were saved or discarded while committing, twice (`meta.subjects`; try again). `invalid-state`: the change set is no draft (`meta.state`). `design-in-use`: a page design to delete is still named by the configuration (`pdf.design`) or a manual (`design`) as the commit leaves them (`meta.designs`; `meta.usedIn`: `{ in: "config", design }` or `{ in: "manual", design, manual? }`, a manual you may not read without its ID; at most 50, `meta.more` counts the rest).',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`invalid-working-copy`: one error per problem, `source.pointer` naming the subject (and block), `meta.issue` the validation code. `config-in-use`: the configuration committed would make content on the branch invalid (one error per usage, as for its working copy). `unknown-asset`: a module names a file you may not use (`meta.assets`), checked again as saving checks it. `translation-record-protected`: a page design’s or manual’s translation record changed in a language whose translation you do not manage (`meta.subject`, `meta.languages`), checked again as saving checks it. `duplicate-subject`, `nothing-to-delete`, `not-deletable` (the configuration), `too-large`, `too-many-changes` (`meta.max`), `too-many-files`, `invalid-message`.',
    standardSchema: ErrorDocument,
  })
  @ApiPermission('content.edit')
  async commit(
    @CurrentActor() actor: Actor,
    // Checked by the action, after its permission check.
    @Param('changeSetId') changeSetId: string,
    @Body({ schema: CreateCommitDocument }) body: CreateCommitDocument,
    @Res({ passthrough: true }) res: Response,
  ) {
    const attributes = body?.data?.attributes;
    const outcome = await this.commitWorkingCopies.handle({
      actor,
      changeSetId,
      ...(attributes?.subjects && { subjects: attributes.subjects }),
      ...(attributes?.deletes && { deletes: attributes.deletes }),
      ...(attributes?.message !== undefined && {
        message: attributes.message,
      }),
    });
    if (outcome.commit === undefined) res.status(HttpStatus.OK);
    return toCommitDocument(outcome);
  }

  @Post(':changeSetId/reverts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Take changes out of a change set',
    description: REVERT_DESCRIPTION,
  })
  @ApiParam(CHANGE_SET_ID)
  @ApiOkResponse({
    description: 'Taken out.',
    standardSchema: RevertDocument,
  })
  @ApiNotFoundResponse({
    description: '`not-found`: no change set with this ID.',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description: DATABASE_TIMEOUT,
    standardSchema: ErrorDocument,
  })
  @ApiConflictResponse({
    description:
      '`lock-required`: the change set does not hold a subject’s lock (`meta.subject`). `branch-moved`, `working-copy-changed`: the branch or a working copy moved while committing, twice (try again). `invalid-state`: the change set is no draft (`meta.state`). `design-in-use`: a page design the change set added, taken out, is named by the configuration or a manual the revert leaves (`meta` as for a commit’s).',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`not-changed`: the change set does not change a subject (`meta.subject`). `not-restorable`: its file at the base is not UTF-8 text (`meta.subject`). `duplicate-subject`, `too-many-changes` (`meta.max`).',
    standardSchema: ErrorDocument,
  })
  @ApiPermission('content.edit')
  async revert(
    @CurrentActor() actor: Actor,
    // Checked by the action, after its permission check.
    @Param('changeSetId') changeSetId: string,
    @Body({ schema: CreateRevertDocument }) body: CreateRevertDocument,
  ) {
    const outcome = await this.revertChanges.handle({
      actor,
      changeSetId,
      subjects: body.data.attributes.subjects,
    });
    return toRevertDocument(outcome);
  }
}
