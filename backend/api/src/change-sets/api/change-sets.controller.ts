import {
  Body,
  Controller,
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
import { AbandonChangeSetAction } from '../core/actions/abandon-change-set.action.js';
import { CreateChangeSetAction } from '../core/actions/create-change-set.action.js';
import { EditChangeSetAction } from '../core/actions/edit-change-set.action.js';
import { GetChangeSetAction } from '../core/actions/get-change-set.action.js';
import { ListChangeSetChangesAction } from '../core/actions/list-change-set-changes.action.js';
import { MAX_REVIEWED_PATHS } from '../core/review-scope.js';
import {
  ListChangeSetsAction,
  READ_CHANGE_SETS,
} from '../core/actions/list-change-sets.action.js';
import type { ChangeSetState } from '../core/change-set.js';
import {
  AbandonChangeSetDocument,
  ChangeSetDocument,
  ChangeSetPageDocument,
  changeSetFilters,
  CreateChangeSetDocument,
  EditChangeSetDocument,
  toChangeSetResource,
  toChangeSetResourceWithBranch,
} from './change-set.resources.js';
import { ChangeSetBehind } from '../core/change-set-behind.js';
import { ChangeSetSupersessions } from '../core/supersessions.js';
import { ChangeSetBranchPresence } from '../core/change-set-branch-presence.js';
import {
  ChangeSetChangePageDocument,
  toChangeSetChangeResource,
} from './change.resources.js';

type Document = z.infer<typeof ChangeSetDocument>;

const ID_PARAMETER = {
  name: 'changeSetId',
  description:
    'The change set’s ID (a UUID). One that names no change set, malformed or not, is 404.',
  schema: { type: 'string', format: 'uuid' },
} as const;

const NOT_FOUND = {
  description: '`not-found`: no change set with this ID.',
  standardSchema: ErrorDocument,
};

@ApiTags('change-sets')
@Controller('change-sets')
@JsonApi()
export class ChangeSetsController {
  constructor(
    private readonly listChangeSets: ListChangeSetsAction,
    private readonly getChangeSet: GetChangeSetAction,
    private readonly createChangeSet: CreateChangeSetAction,
    private readonly abandonChangeSet: AbandonChangeSetAction,
    private readonly editChangeSet: EditChangeSetAction,
    private readonly listChanges: ListChangeSetChangesAction,
    private readonly presence: ChangeSetBranchPresence,
    private readonly behind: ChangeSetBehind,
    private readonly supersessions: ChangeSetSupersessions,
  ) {}

  @Get()
  @NamesPeople()
  @Paged()
  @Filters(
    {
      name: 'state',
      description:
        'Only change sets in this state: `draft`, `in-review`, `approved`, `merged` or `abandoned`.',
    },
    {
      name: 'author',
      description: 'Only change sets started by this user (or service) ID.',
    },
  )
  @ApiOperation({
    summary: 'List change sets',
    description: `Change sets, newest first: every one for a holder of the \`${READ_CHANGE_SETS}\` permission, only the caller's own for anyone else (authors always see their own work; another author's filter then lists nothing). Each says in \`meta.branchMissing\` whether its branch is gone from the content repository. \`meta.counts\` counts the change sets of each state the other filters leave, as the reader sees them, for a list's state filters.`,
  })
  @ApiOkResponse({ standardSchema: ChangeSetPageDocument })
  async list(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @PageParams() page: PageRequest,
    @Query('filter[state]', { schema: changeSetFilters.state.optional() })
    state?: ChangeSetState,
    @Query('filter[author]', { schema: changeSetFilters.author.optional() })
    author?: string,
  ): Promise<z.infer<typeof ChangeSetPageDocument>> {
    const result = await this.listChangeSets.handle({
      actor,
      page,
      filter: {
        ...(state !== undefined && { state }),
        ...(author !== undefined && { author }),
      },
    });
    const missing = await this.presence.missing(result.items);
    const document = toPagedDocument(
      req,
      page,
      result,
      toChangeSetResourceWithBranch(missing),
    );
    return { ...document, meta: { ...document.meta, counts: result.counts } };
  }

  @Get(':changeSetId')
  @NamesPeople()
  @ApiOperation({
    summary: 'Read a change set',
    description: `Any change set for a holder of the \`${READ_CHANGE_SETS}\` permission, only the caller's own for anyone else: another author's change set is then 404, exactly like one that does not exist. \`meta.branchMissing\` says whether its branch is gone from the content repository (reads at it then answer 404 \`change-set-branch-missing\`); it is never recreated. \`meta.behind\`, for an open one, counts the commits its base branch has that its branch does not.`,
  })
  @ApiParam(ID_PARAMETER)
  @ApiOkResponse({ standardSchema: ChangeSetDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  async get(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') id: string,
  ): Promise<Document> {
    const changeSet = await this.getChangeSet.handle({ actor, id });
    const missing = await this.presence.missing([changeSet]);
    const resource = toChangeSetResourceWithBranch(missing)(changeSet);
    const [standing, links] = await Promise.all([
      missing.has(changeSet.id) ? undefined : this.behind.of(actor, changeSet),
      this.supersessions.linksOf(changeSet.id),
    ]);
    return {
      data: {
        ...resource,
        meta: {
          branchMissing: missing.has(changeSet.id),
          ...(standing && {
            behind: standing.behind,
            base: { state: standing.base },
          }),
          ...links,
        },
      },
    };
  }

  @Get(':changeSetId/changes')
  @Paged()
  @ApiOperation({
    summary: 'List what a change set changes',
    description: `The modules and manuals that differ between the change set’s base commit and its head (the review head once submitted, else its branch’s head), each with what differs: its metadata fields and, for a module, its blocks by block ID (\`added\`, \`changed\`, \`removed\`; unchanged blocks are not listed). Derived from Git, never stored. Each side is read as the reader may read that commit, and shows only what they would also see on the other: a module or manual they may not see there is not there, exactly like a missing one, and one they see on neither side is neither listed nor counted. Other files (the configuration, templates, images) are not listed. The change set is found as \`GET /change-sets/{changeSetId}\` finds it; its author reads its base as released content when it started from released content. Needs the \`content.read\` permission.`,
  })
  @ApiParam(ID_PARAMETER)
  @ApiPermission('content.read')
  @ApiOkResponse({ standardSchema: ChangeSetChangePageDocument })
  @ApiNotFoundResponse({
    description:
      '`not-found`: no change set with this ID, or a commit of it the reader may not open.',
    standardSchema: ErrorDocument,
  })
  @ApiConflictResponse({
    description: '`branch-missing`: the change set’s branch is gone.',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description: `\`too-many-changes\`: more than ${MAX_REVIEWED_PATHS} files differ; \`invalid-content\`: the configuration at a side cannot be read.`,
    standardSchema: ErrorDocument,
  })
  async changes(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @PageParams() page: PageRequest,
    @Param('changeSetId') id: string,
  ): Promise<z.infer<typeof ChangeSetChangePageDocument>> {
    const result = await this.listChanges.handle({ actor, id, page });
    const document = toPagedDocument(
      req,
      page,
      result,
      toChangeSetChangeResource(id),
    );
    return {
      ...document,
      meta: { ...document.meta, base: result.base, head: result.head },
    };
  }

  @Post()
  @NamesPeople()
  @ApiOperation({
    summary: 'Start a change set',
    description:
      'Creates the change set’s own branch (`change-sets/<id>`, named by the server) at the base branch’s current commit, then records the change set and a `change-set.create` audit event. With `maintenanceLine` (a maintenance line’s ID) the base is the line’s branch: fixes to an older product revision, merged into it and released from it. Needs the `content.edit` permission.',
  })
  @ApiCreatedResponse({
    standardSchema: ChangeSetDocument,
    headers: {
      Location: {
        description: 'The new change set.',
        schema: { type: 'string' },
      },
    },
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`invalid-base`: `baseRef` (or, without it, the server’s default ref) names no branch, or a change set’s; `maintenanceLine` names no line; or both are given.',
    standardSchema: ErrorDocument,
  })
  @ApiConflictResponse({
    description:
      '`invalid-state`: the maintenance line is closed (`meta.state: "closed"`): no new change sets start on it.',
    standardSchema: ErrorDocument,
  })
  @ApiPermission('content.edit')
  async create(
    @CurrentActor() actor: Actor,
    @Body({ schema: CreateChangeSetDocument }) body: CreateChangeSetDocument,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Document> {
    const { title, description, baseRef, maintenanceLine } =
      body.data.attributes;
    const changeSet = await this.createChangeSet.handle({
      actor,
      title,
      ...(description != null && { description }),
      ...(baseRef !== undefined && { baseRef }),
      ...(maintenanceLine !== undefined && { maintenanceLine }),
    });
    res.setHeader('Location', `/change-sets/${changeSet.id}`);
    return { data: toChangeSetResource(changeSet) };
  }

  @Patch(':changeSetId')
  @NamesPeople()
  @ApiOperation({
    summary: 'Rename a change set',
    description:
      'Sets an open change set’s `title` or `description` (`null` clears it) and records a `change-set.edit` audit event with the old and new values; a value that is the same changes nothing and is not audited. Nothing else changes this way (any other member is 400 `invalid-body`). Only its author: 403 for anyone else who holds `content.read.draft`, and 404, exactly like a missing change set, for anyone who does not. Needs the `content.edit` permission.',
  })
  @ApiParam(ID_PARAMETER)
  @ApiOkResponse({ standardSchema: ChangeSetDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    description:
      '`invalid-state`: the change set is no longer open (merged or abandoned); `meta.state` says which. `id-mismatch`: the resource object names another change set than the path.',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description:
      '`database-timeout`: the transaction waited too long for a row held elsewhere, or a statement ran too long; nothing of it was written. `Retry-After` says when to try again.',
    standardSchema: ErrorDocument,
  })
  @ApiPermission('content.edit')
  async edit(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') id: string,
    @Body({ schema: EditChangeSetDocument }) body: EditChangeSetDocument,
  ): Promise<Document> {
    const { title, description } = body.data.attributes;
    const changeSet = await this.editChangeSet.handle({
      actor,
      id,
      resourceId: body.data.id,
      ...(title !== undefined && { title }),
      ...(description !== undefined && { description }),
    });
    return { data: toChangeSetResource(changeSet) };
  }

  @Post(':changeSetId/abandon')
  @NamesPeople()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Abandon a change set',
    description:
      'Marks an open change set `abandoned` and records a `change-set.abandon` audit event. Nothing is deleted in Git: its branch stays readable. Only its author may abandon it: 403 for anyone else who holds `content.read.draft`, and 404, exactly like a missing change set, for anyone who does not. One exception: an admin (`admin.roles`, holding `content.read.draft`) may abandon another author’s change set whose branch is gone from the content repository (`meta.branchMissing`; the event then has `data.branchMissing`). Needs the `content.edit` permission.',
  })
  @ApiParam(ID_PARAMETER)
  @ApiOkResponse({ standardSchema: ChangeSetDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    description:
      '`invalid-state`: the change set is no longer open (merged or abandoned); `meta.state` says which.',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description:
      '`database-timeout`: the transaction waited too long for a row held elsewhere, or a statement ran too long (`CCMS_DATABASE_WRITE_LOCK_TIMEOUT_MS`, `CCMS_DATABASE_WRITE_STATEMENT_TIMEOUT_MS`); nothing of it was written to the database. `Retry-After` says when to try again.',
    standardSchema: ErrorDocument,
  })
  @ApiPermission('content.edit')
  async abandon(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') id: string,
    @Body({ schema: AbandonChangeSetDocument }) body: AbandonChangeSetDocument,
  ): Promise<Document> {
    const comment = body?.meta?.comment;
    const changeSet = await this.abandonChangeSet.handle({
      actor,
      id,
      ...(comment !== undefined && { comment }),
    });
    return { data: toChangeSetResource(changeSet) };
  }
}
