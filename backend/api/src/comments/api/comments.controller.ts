import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import {
  Filters,
  JsonApi,
  PageParams,
  Paged,
} from '../../base/api/json-api.decorators.js';
import { NamesPeople } from '../../base/api/people.js';
import { ErrorDocument, toPagedDocument } from '../../base/api/json-api.js';
import type { PageRequest } from '../../base/core/paging.js';
import { CreateCommentAction } from '../core/actions/create-comment.action.js';
import { DeleteCommentAction } from '../core/actions/delete-comment.action.js';
import { EditCommentAction } from '../core/actions/edit-comment.action.js';
import { GetCommentAction } from '../core/actions/get-comment.action.js';
import { ListCommentsAction } from '../core/actions/list-comments.action.js';
import {
  ReopenCommentAction,
  ResolveCommentAction,
} from '../core/actions/resolve-comment.action.js';
import { type CommentSubject, MAX_COMMENTS } from '../core/comment.js';
import {
  CommentDocument,
  CommentPageDocument,
  commentFilters,
  CreateCommentDocument,
  EditCommentDocument,
  toCommentResource,
} from './comment.resources.js';

type Document = z.infer<typeof CommentDocument>;

const CHANGE_SET_ID = {
  name: 'changeSetId',
  description:
    'The change set’s ID (a UUID). One that names no change set, malformed or not, is 404.',
  schema: { type: 'string', format: 'uuid' },
} as const;

const COMMENT_ID = {
  name: 'commentId',
  description:
    'The comment’s ID (a UUID). One that names no comment of this change set, malformed or not, is 404.',
  schema: { type: 'string', format: 'uuid' },
} as const;

const WHO_SEES =
  'The change set is found as `GET /change-sets/{changeSetId}` finds it (another author’s is 404, exactly like a missing one, for an actor without `content.read.draft`). A comment is there for a reader who sees its module: at the change set’s head where it is there, else at its base; a module on neither side any more only for a reader of all of its language. Any other is 404, exactly like a missing one.';

const WHO_WRITES =
  'Only the change set’s author, or a reviewer holding `content.review` in a role that covers the module (403 otherwise, one answer whatever the reason), and only on an open change set (`draft`, `in-review` or `approved`).';

const ONLY_AUTHOR =
  'Only the comment’s author, while they may comment on its module (as the change set’s author, or a reviewer holding `content.review` in a role that covers it): 403 for anyone else who sees the comment, and 404, exactly like a missing one, for anyone who does not. Only on an open change set (`draft`, `in-review` or `approved`). Nobody may edit or delete another person’s comment, admins included.';

const NOT_THE_AUTHOR = {
  description:
    '`forbidden`: the actor lacks `content.read`, did not write the comment, or may no longer comment on its module (one answer whatever the reason).',
  standardSchema: ErrorDocument,
};

const CHANGE_SET_NOT_FOUND = {
  description:
    '`not-found`: no change set with this ID, or a commit of it the reader may not open.',
  standardSchema: ErrorDocument,
};

const COMMENT_NOT_FOUND = {
  description:
    '`not-found`: no change set or comment with this ID, or one the reader may not see, answered alike.',
  standardSchema: ErrorDocument,
};

const MAY_NOT_WRITE = {
  description:
    '`forbidden`: the actor lacks `content.read`, or is neither the change set’s author nor a holder of `content.review` in a role covering the module (one answer whatever the reason).',
  standardSchema: ErrorDocument,
};

const TIMEOUT = {
  description:
    '`database-timeout`: the transaction waited too long for a row held elsewhere, or a statement ran too long (`CCMS_DATABASE_WRITE_LOCK_TIMEOUT_MS`, `CCMS_DATABASE_WRITE_STATEMENT_TIMEOUT_MS`); nothing of it was written to the database. `Retry-After` says when to try again.',
  standardSchema: ErrorDocument,
};

@ApiTags('comments')
@Controller('change-sets/:changeSetId/comments')
@JsonApi()
@NamesPeople()
export class CommentsController {
  constructor(
    private readonly listComments: ListCommentsAction,
    private readonly getComment: GetCommentAction,
    private readonly createComment: CreateCommentAction,
    private readonly resolveComment: ResolveCommentAction,
    private readonly reopenComment: ReopenCommentAction,
    private readonly editComment: EditCommentAction,
    private readonly deleteComment: DeleteCommentAction,
  ) {}

  @Get()
  @Paged()
  @Filters(
    {
      name: 'module',
      description:
        'Only comments on this module: `<lang>/<moduleId>`, e.g. `en/battery-charging`.',
    },
    {
      name: 'block',
      description: 'Only comments on this block ID.',
    },
    {
      name: 'resolved',
      description:
        '`false` (the default): open threads only; `true`: resolved threads only; `any`: both. A reply goes with its thread.',
    },
  )
  @ApiOperation({
    summary: 'List a change set’s comments',
    description: `Comments on blocks of the change set’s modules, in thread order: threads by when they were started, each followed by its replies, oldest first. Resolved threads are hidden unless \`filter[resolved]\` asks for them. Each says in \`meta.orphaned\` whether its block is gone from the change set’s head (named in \`meta.head\`). ${WHO_SEES} Comments the reader may not see are neither listed nor counted. Needs the \`content.read\` permission.`,
  })
  @ApiParam(CHANGE_SET_ID)
  @ApiPermission('content.read')
  @ApiOkResponse({ standardSchema: CommentPageDocument })
  @ApiNotFoundResponse(CHANGE_SET_NOT_FOUND)
  @ApiConflictResponse({
    description: '`branch-missing`: the change set’s branch is gone.',
    standardSchema: ErrorDocument,
  })
  async list(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @PageParams() page: PageRequest,
    @Param('changeSetId') changeSetId: string,
    @Query('filter[module]', { schema: commentFilters.module.optional() })
    module?: CommentSubject,
    @Query('filter[block]', { schema: commentFilters.block.optional() })
    blockId?: string,
    @Query('filter[resolved]', { schema: commentFilters.resolved.optional() })
    resolved?: boolean | 'any',
  ): Promise<z.infer<typeof CommentPageDocument>> {
    const result = await this.listComments.handle({
      actor,
      changeSetId,
      page,
      filter: {
        ...(module !== undefined && { module }),
        ...(blockId !== undefined && { blockId }),
        ...(resolved !== 'any' && { resolved: resolved ?? false }),
      },
    });
    const document = toPagedDocument(req, page, result, toCommentResource);
    return { ...document, meta: { ...document.meta, head: result.head } };
  }

  @Get(':commentId')
  @ApiOperation({
    summary: 'Read a comment',
    description: `${WHO_SEES} Needs the \`content.read\` permission.`,
  })
  @ApiParam(CHANGE_SET_ID)
  @ApiParam(COMMENT_ID)
  @ApiPermission('content.read')
  @ApiOkResponse({ standardSchema: CommentDocument })
  @ApiNotFoundResponse(COMMENT_NOT_FOUND)
  @ApiConflictResponse({
    description: '`branch-missing`: the change set’s branch is gone.',
    standardSchema: ErrorDocument,
  })
  async get(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') changeSetId: string,
    @Param('commentId') commentId: string,
  ): Promise<Document> {
    const read = await this.getComment.handle({
      actor,
      changeSetId,
      commentId,
    });
    return { data: toCommentResource(read) };
  }

  @Post()
  @ApiOperation({
    summary: 'Comment on a block, or reply to a thread',
    description: `A new thread on a block of a module (\`attributes.subject\` and \`attributes.blockId\`: a block, list item or procedure step in the module at the change set’s head or at its base, as the reader sees it), or a reply to a thread (\`relationships.thread\`: its first comment), on the thread’s block. ${WHO_WRITES} Recorded with a \`comment.create\` audit event (the change set, module, block and head; never the text). The anchor is the block’s ID: the comment stays on the block while it is edited or moved, and stays, \`meta.orphaned\`, once a save point removes it. Needs the \`content.read\` permission.`,
  })
  @ApiParam(CHANGE_SET_ID)
  @ApiPermission('content.read')
  @ApiCreatedResponse({
    standardSchema: CommentDocument,
    headers: {
      Location: { description: 'The new comment.', schema: { type: 'string' } },
    },
  })
  @ApiNotFoundResponse(CHANGE_SET_NOT_FOUND)
  @ApiConflictResponse({
    description: `\`invalid-state\`: the change set is not open (\`meta.state\`). \`too-many-comments\`: it holds ${MAX_COMMENTS} comments already (\`meta.max\`). \`branch-missing\`: its branch is gone.`,
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`block-not-found`: no such block in the module at the head or the base, or a module the reader may not see, answered alike. `invalid-thread`: `relationships.thread` names no thread of this change set the reader sees, or a reply.',
    standardSchema: ErrorDocument,
  })
  @ApiForbiddenResponse(MAY_NOT_WRITE)
  @ApiServiceUnavailableResponse(TIMEOUT)
  async create(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') changeSetId: string,
    @Body({ schema: CreateCommentDocument }) body: CreateCommentDocument,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Document> {
    const { attributes, relationships } = body.data;
    const read = await this.createComment.handle({
      actor,
      changeSetId,
      body: attributes.body,
      anchor: relationships
        ? { threadId: relationships.thread.data.id }
        : {
            subject: attributes.subject as CommentSubject,
            blockId: attributes.blockId as string,
          },
    });
    res.setHeader(
      'Location',
      `/change-sets/${read.comment.changeSetId}/comments/${read.comment.id}`,
    );
    return { data: toCommentResource(read) };
  }

  @Post(':commentId/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resolve a thread',
    description: `Marks the thread (its first comment) resolved, recorded with a \`comment.resolve\` audit event. Its comments stay stored; lists hide resolved threads unless \`filter[resolved]\` asks for them. ${WHO_WRITES} ${WHO_SEES} Needs the \`content.read\` permission.`,
  })
  @ApiParam(CHANGE_SET_ID)
  @ApiParam(COMMENT_ID)
  @ApiPermission('content.read')
  @ApiOkResponse({ standardSchema: CommentDocument })
  @ApiNotFoundResponse(COMMENT_NOT_FOUND)
  @ApiConflictResponse({
    description:
      '`already-resolved`: the thread is resolved. `invalid-state`: the change set is not open (`meta.state`). `branch-missing`: its branch is gone.',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`not-a-thread`: the comment is a reply; resolve its thread (`meta.threadId`).',
    standardSchema: ErrorDocument,
  })
  @ApiForbiddenResponse(MAY_NOT_WRITE)
  @ApiServiceUnavailableResponse(TIMEOUT)
  async resolve(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') changeSetId: string,
    @Param('commentId') commentId: string,
  ): Promise<Document> {
    const read = await this.resolveComment.handle({
      actor,
      changeSetId,
      commentId,
    });
    return { data: toCommentResource(read) };
  }

  @Post(':commentId/reopen')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reopen a thread',
    description: `Marks a resolved thread (its first comment) open again, recorded with a \`comment.reopen\` audit event. ${WHO_WRITES} ${WHO_SEES} Needs the \`content.read\` permission.`,
  })
  @ApiParam(CHANGE_SET_ID)
  @ApiParam(COMMENT_ID)
  @ApiPermission('content.read')
  @ApiOkResponse({ standardSchema: CommentDocument })
  @ApiNotFoundResponse(COMMENT_NOT_FOUND)
  @ApiConflictResponse({
    description:
      '`not-resolved`: the thread is open. `invalid-state`: the change set is not open (`meta.state`). `branch-missing`: its branch is gone.',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`not-a-thread`: the comment is a reply; reopen its thread (`meta.threadId`).',
    standardSchema: ErrorDocument,
  })
  @ApiForbiddenResponse(MAY_NOT_WRITE)
  @ApiServiceUnavailableResponse(TIMEOUT)
  async reopen(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') changeSetId: string,
    @Param('commentId') commentId: string,
  ): Promise<Document> {
    const read = await this.reopenComment.handle({
      actor,
      changeSetId,
      commentId,
    });
    return { data: toCommentResource(read) };
  }

  @Patch(':commentId')
  @ApiOperation({
    summary: 'Edit one’s own comment',
    description: `Replaces the comment’s text; it stays on its block, in its thread, and is marked edited (\`meta.editedAt\`). The earlier text is not kept: a \`comment.edit\` audit event records that it was edited, never the text. The same text changes nothing and is not audited. ${ONLY_AUTHOR} Needs the \`content.read\` permission.`,
  })
  @ApiParam(CHANGE_SET_ID)
  @ApiParam(COMMENT_ID)
  @ApiPermission('content.read')
  @ApiOkResponse({ standardSchema: CommentDocument })
  @ApiNotFoundResponse(COMMENT_NOT_FOUND)
  @ApiConflictResponse({
    description:
      '`comment-deleted`: the comment is deleted. `invalid-state`: the change set is not open (`meta.state`). `id-mismatch`: `data.id` is not the path’s. `branch-missing`: its branch is gone.',
    standardSchema: ErrorDocument,
  })
  @ApiForbiddenResponse(NOT_THE_AUTHOR)
  @ApiServiceUnavailableResponse(TIMEOUT)
  async edit(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') changeSetId: string,
    @Param('commentId') commentId: string,
    @Body({ schema: EditCommentDocument }) body: EditCommentDocument,
  ): Promise<Document> {
    const read = await this.editComment.handle({
      actor,
      changeSetId,
      commentId,
      resourceId: body.data.id,
      body: body.data.attributes.body,
    });
    return { data: toCommentResource(read) };
  }

  @Delete(':commentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete one’s own comment',
    description: `Takes the comment back. A thread’s first comment with replies stays in its place without its text (\`meta.deleted\`, \`body\` null), so the thread stays readable; a reply, or a thread without replies, is gone (404 from then on), and the last reply of a deleted thread takes the thread with it. The text is not kept: a \`comment.delete\` audit event records that it was deleted (\`data.kept\`: whether it stays as deleted), never the text. ${ONLY_AUTHOR} Needs the \`content.read\` permission.`,
  })
  @ApiParam(CHANGE_SET_ID)
  @ApiParam(COMMENT_ID)
  @ApiPermission('content.read')
  @ApiNoContentResponse({ description: 'Deleted.' })
  @ApiNotFoundResponse(COMMENT_NOT_FOUND)
  @ApiConflictResponse({
    description:
      '`comment-deleted`: the comment is deleted already. `invalid-state`: the change set is not open (`meta.state`). `branch-missing`: its branch is gone.',
    standardSchema: ErrorDocument,
  })
  @ApiForbiddenResponse(NOT_THE_AUTHOR)
  @ApiServiceUnavailableResponse(TIMEOUT)
  async delete(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') changeSetId: string,
    @Param('commentId') commentId: string,
  ): Promise<void> {
    await this.deleteComment.handle({ actor, changeSetId, commentId });
  }
}
