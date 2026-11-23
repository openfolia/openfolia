import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiQuery,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import {
  AcceptsQuery,
  Filters,
  JsonApi,
  PageParams,
  Paged,
} from '../../base/api/json-api.decorators.js';
import { ErrorDocument, toPagedDocument } from '../../base/api/json-api.js';
import type { PageRequest } from '../../base/core/paging.js';
import { AcquireLockAction } from '../core/actions/acquire-lock.action.js';
import { BreakLocksAction } from '../core/actions/break-locks.action.js';
import { BreakLockAction } from '../core/actions/break-lock.action.js';
import { READ_CHANGE_SETS } from '../core/actions/list-change-sets.action.js';
import {
  GetLockAction,
  ListLocksAction,
} from '../core/actions/list-locks.action.js';
import { ReleaseLockAction } from '../core/actions/release-lock.action.js';
import type { LockSubject } from '../core/lock.js';
import {
  AcquireLockDocument,
  BreakLockDocument,
  BreakLocksDocument,
  BreakLocksResultDocument,
  LockDocument,
  LockPageDocument,
  lockFilters,
  toLockResource,
} from './lock.resources.js';

type Document = z.infer<typeof LockDocument>;

const LOCK_ID = {
  name: 'lockId',
  description:
    'The lock’s ID (a UUID). One that names no lock, malformed or not, is 404.',
  schema: { type: 'string', format: 'uuid' },
} as const;

const CHANGE_SET_ID = {
  name: 'changeSetId',
  description:
    'The change set’s ID (a UUID). One that names no change set, malformed or not, is 404.',
  schema: { type: 'string', format: 'uuid' },
} as const;

/** `?ifUnchanged=`: `true` or `false`, nothing else. */
const IfUnchanged = z.enum(['true', 'false']).transform((v) => v === 'true');

const LOCK_NOT_FOUND = {
  description:
    '`not-found`: no lock with this ID (released or broken, or never taken), or one the actor may not know of (outside their `content.read.draft` scope), answered exactly alike.',
  standardSchema: ErrorDocument,
};

@ApiTags('locks')
@Controller()
@JsonApi()
export class LocksController {
  constructor(
    private readonly listLocks: ListLocksAction,
    private readonly getLock: GetLockAction,
    private readonly acquireLock: AcquireLockAction,
    private readonly releaseLock: ReleaseLockAction,
    private readonly breakLock: BreakLockAction,
    private readonly breakLocks: BreakLocksAction,
  ) {}

  @Get('locks')
  @Paged()
  @Filters(
    {
      name: 'holder',
      description: 'Only locks held by this user (or service) ID.',
    },
    {
      name: 'changeSet',
      description: 'Only locks of this change set (its ID).',
    },
    {
      name: 'subject',
      description:
        'Only the lock on this subject: `module/<lang>/<moduleId>`, `manual/<manualId>`, `config` or `term/<termId>`, e.g. `module/en/battery-charging`.',
    },
  )
  @ApiOperation({
    summary: 'List locks',
    description: `Who holds which module or manual, for which change set; newest first. Only locks whose subject, as committed on its change set's branch, lies within the reader's \`${READ_CHANGE_SETS}\` scope are listed (and counted); a subject with nothing committed only for a reader of all of its language (a module) or manuals of every audience. Without \`${READ_CHANGE_SETS}\`, only the caller's own locks, within their \`content.read\` scope (authors always see their own work).`,
  })
  @ApiOkResponse({ standardSchema: LockPageDocument })
  async list(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @PageParams() page: PageRequest,
    @Query('filter[holder]', { schema: lockFilters.holder.optional() })
    holder?: string,
    @Query('filter[changeSet]', { schema: lockFilters.changeSet.optional() })
    changeSetId?: string,
    @Query('filter[subject]', { schema: lockFilters.subject.optional() })
    subject?: LockSubject,
  ): Promise<z.infer<typeof LockPageDocument>> {
    const result = await this.listLocks.handle({
      actor,
      page,
      filter: {
        ...(holder !== undefined && { holder }),
        ...(changeSetId !== undefined && { changeSetId }),
        ...(subject !== undefined && { subject }),
      },
    });
    return toPagedDocument(req, page, result, toLockResource);
  }

  @Get('locks/:lockId')
  @ApiOperation({
    summary: 'Read a lock',
    description: `A lock the reader may not know of (as for the list: outside their scope, or, without \`${READ_CHANGE_SETS}\`, another holder's) is 404, exactly like a lock that does not exist.`,
  })
  @ApiParam(LOCK_ID)
  @ApiOkResponse({ standardSchema: LockDocument })
  @ApiNotFoundResponse(LOCK_NOT_FOUND)
  async get(
    @CurrentActor() actor: Actor,
    @Param('lockId') id: string,
  ): Promise<Document> {
    return { data: toLockResource(await this.getLock.handle({ actor, id })) };
  }

  @Post('change-sets/:changeSetId/locks')
  @ApiOperation({
    summary: 'Lock a module or manual for a change set',
    description:
      'Takes the lock on the subject for the change set, recorded with a `lock.acquire` audit event: 201 with the new lock. A subject the change set holds already is answered 200 with its lock (nothing changes). Only the change set’s author takes locks for it (403; for an actor without `content.read.draft` another author’s change set is 404, exactly like a missing one), only while it is a draft. The subject, as committed on the change set’s branch, must lie within a role holding `content.edit` and be one the actor reads; a subject with nothing committed only for an actor who edits and reads all of its language (a module) or manuals of every audience. Else 403, one answer whatever the reason. Needs the `content.edit` permission.',
  })
  @ApiParam(CHANGE_SET_ID)
  @ApiCreatedResponse({
    description: 'The lock taken.',
    standardSchema: LockDocument,
    headers: {
      Location: { description: 'The new lock.', schema: { type: 'string' } },
    },
  })
  @ApiOkResponse({
    description: 'The change set held the lock already.',
    standardSchema: LockDocument,
  })
  @ApiNotFoundResponse({
    description:
      '`not-found`: no change set with this ID (or, for an actor without `content.read.draft`, another author’s).',
    standardSchema: ErrorDocument,
  })
  @ApiConflictResponse({
    description:
      '`locked`: another change set holds the subject; for an actor who may read that lock (`GET /locks` lists it to them), `meta` names the lock (`lockId`), its `holder`, `changeSetId` and `since`, and, while that change set is there, its `changeSetTitle`, `changeSetState` and `hasChanges`: whether it has changes to the subject (a working copy, or a commit changing it since its base), so its holder can tell whether `DELETE /locks/{lockId}?ifUnchanged=true` would free it (anyone else gets no `meta`). `invalid-state`: the change set is no draft (`meta.state`). `too-many-locks`: the holder holds the most locks one may (`meta.max`). `lock-contended`: the subject was locked and released again while trying, more than once; try again.',
    standardSchema: ErrorDocument,
  })
  @ApiPermission('content.edit')
  async acquire(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') changeSetId: string,
    @Body({ schema: AcquireLockDocument }) body: AcquireLockDocument,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Document> {
    const { lock, created } = await this.acquireLock.handle({
      actor,
      changeSetId,
      subject: body.data.attributes.subject,
    });
    if (created) {
      res.setHeader('Location', `/locks/${lock.id}`);
    } else {
      res.status(HttpStatus.OK);
    }
    return { data: toLockResource(lock) };
  }

  @Delete('locks/:lockId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Release a lock',
    description:
      'Removes the lock, recorded with a `lock.release` audit event. Only its holder may release it (an admin may break it): 403 for anyone else who may read it, and 404, exactly like a missing lock, for anyone who may not (no `content.read.draft`, or the lock outside its scope). With `ifUnchanged=true`, only while the lock’s change set has no changes to its subject (no working copy of it, no commit changing it since its base): else 409 `has-changes` and the lock stays. The editor frees a module so from another of the holder’s change sets. Needs the `content.edit` permission.',
  })
  @ApiParam(LOCK_ID)
  @AcceptsQuery('ifUnchanged')
  @ApiQuery({
    name: 'ifUnchanged',
    required: false,
    description:
      '`true`: release only while the lock’s change set has no changes to its subject (409 `has-changes` otherwise). Default `false`.',
    schema: { type: 'string', enum: ['true', 'false'] },
  })
  @ApiNoContentResponse({ description: 'Released.' })
  @ApiNotFoundResponse(LOCK_NOT_FOUND)
  @ApiConflictResponse({
    description:
      '`has-changes` (with `ifUnchanged=true`): the lock’s change set has a working copy of its subject, or a commit changing it since its base (`meta.changeSetId`); the lock stays.',
    standardSchema: ErrorDocument,
  })
  @ApiPermission('content.edit')
  async release(
    @CurrentActor() actor: Actor,
    @Param('lockId') id: string,
    @Query('ifUnchanged', { schema: IfUnchanged.optional() })
    ifUnchanged?: boolean,
  ): Promise<void> {
    await this.releaseLock.handle({
      actor,
      id,
      ...(ifUnchanged && { ifUnchanged }),
    });
  }

  @Post('locks/:lockId/break')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Break someone’s lock',
    description:
      'An admin removes a lock held by someone else, with a required comment, recorded with a `lock.break` audit event naming the holder. Needs the `admin.roles` permission.',
  })
  @ApiParam(LOCK_ID)
  @ApiNoContentResponse({ description: 'Broken.' })
  @ApiNotFoundResponse(LOCK_NOT_FOUND)
  @ApiServiceUnavailableResponse({
    description:
      '`database-timeout`: the transaction waited too long for a row held elsewhere, or a statement ran too long (`CCMS_DATABASE_WRITE_LOCK_TIMEOUT_MS`, `CCMS_DATABASE_WRITE_STATEMENT_TIMEOUT_MS`); nothing of it was written to the database. `Retry-After` says when to try again.',
    standardSchema: ErrorDocument,
  })
  @ApiPermission('admin.roles')
  async break(
    @CurrentActor() actor: Actor,
    @Param('lockId') id: string,
    @Body({ schema: BreakLockDocument }) body: BreakLockDocument,
  ): Promise<void> {
    await this.breakLock.handle({ actor, id, comment: body.meta.comment });
  }

  @Post('locks/break')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Break all locks of a change set or a holder',
    description:
      'An admin removes every lock of one change set (`meta.changeSet`) or one holder (`meta.holder`: exactly one of the two), with a required comment, in one transaction: a holder who left, or lost `content.edit`, cannot release. Each lock gets its own `lock.break` audit event (the comment, the holder, `data.bulk`). Answers with `meta.count`, which may be 0. A holder holds at most 1,000 locks, so a call breaks at most that many. A lock taken after the call is a new one and stays. Needs the `admin.roles` permission.',
  })
  @ApiOkResponse({ standardSchema: BreakLocksResultDocument })
  @ApiNotFoundResponse({
    description: '`not-found`: no change set with this ID.',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description:
      '`database-timeout`: the transaction waited too long for a row held elsewhere, or a statement ran too long (`CCMS_DATABASE_WRITE_LOCK_TIMEOUT_MS`, `CCMS_DATABASE_WRITE_STATEMENT_TIMEOUT_MS`); nothing of it was written to the database. `Retry-After` says when to try again.',
    standardSchema: ErrorDocument,
  })
  @ApiPermission('admin.roles')
  async breakAll(
    @CurrentActor() actor: Actor,
    @Body({ schema: BreakLocksDocument }) body: BreakLocksDocument,
  ): Promise<z.infer<typeof BreakLocksResultDocument>> {
    const { comment, changeSet, holder } = body.meta;
    const count = await this.breakLocks.handle({
      actor,
      comment,
      ...(holder ? { holder } : { changeSetId: changeSet ?? '' }),
    });
    return { meta: { count } };
  }
}
