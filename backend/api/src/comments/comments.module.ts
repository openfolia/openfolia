import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ChangeSetsModule } from '../change-sets/change-sets.module.js';
import { ContentModule } from '../content/content.module.js';
import { CommentsController } from './api/comments.controller.js';
import { CreateCommentAction } from './core/actions/create-comment.action.js';
import { DeleteCommentAction } from './core/actions/delete-comment.action.js';
import { EditCommentAction } from './core/actions/edit-comment.action.js';
import { GetCommentAction } from './core/actions/get-comment.action.js';
import { ListCommentsAction } from './core/actions/list-comments.action.js';
import {
  ReopenCommentAction,
  ResolveCommentAction,
} from './core/actions/resolve-comment.action.js';
import { ChangeSetComments } from './core/change-set-comments.js';
import { CommentStore } from './core/comment-store.js';
import { DrizzleCommentStore } from './repos/drizzle-comment-store.js';

/**
 * Comments on blocks of a change set's modules (#24): threads and replies,
 * resolved and reopened, edited and deleted by their authors (#268), in Postgres (never Git), every change in the
 * audit log. Read and written through the change set's own visibility.
 */
@Module({
  // `ChangeSetStore` comes from `AuthoredBranchesModule` (global).
  imports: [ContentModule, AuditModule, ChangeSetsModule],
  controllers: [CommentsController],
  providers: [
    ChangeSetComments,
    ListCommentsAction,
    GetCommentAction,
    CreateCommentAction,
    ResolveCommentAction,
    ReopenCommentAction,
    EditCommentAction,
    DeleteCommentAction,
    { provide: CommentStore, useClass: DrizzleCommentStore },
  ],
  // A module renamed in a change set takes its comments along (#265).
  exports: [CommentStore],
})
export class CommentsModule {}
