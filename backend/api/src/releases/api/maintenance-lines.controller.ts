import {
  Body,
  Controller,
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
import {
  CloseMaintenanceLineAction,
  GetMaintenanceLineAction,
  ListMaintenanceLineReleasesAction,
  ListMaintenanceLinesAction,
  StartMaintenanceLineAction,
} from '../core/actions/maintenance-lines.action.js';
import type { MaintenanceLineState } from '../core/maintenance-line.js';
import {
  CloseMaintenanceLineDocument,
  MaintenanceLineDocument,
  MaintenanceLinePageDocument,
  maintenanceLineFilters,
  StartMaintenanceLineDocument,
  toMaintenanceLineResource,
} from './maintenance-line.resources.js';
import { ReleasePageDocument, toReleaseResource } from './release.resources.js';

type Document = z.infer<typeof MaintenanceLineDocument>;

const ID_PARAMETER = {
  name: 'maintenanceLineId',
  description:
    'The maintenance line’s ID (a UUID). One that names no line, malformed or not, is 404.',
  schema: { type: 'string', format: 'uuid' },
} as const;

const NOT_FOUND = {
  description: '`not-found`: no maintenance line with this ID.',
  standardSchema: ErrorDocument,
};

const TIMEOUT = {
  description:
    '`database-timeout`: the transaction waited too long for a row held elsewhere, or a statement ran too long; nothing of it was written. `Retry-After` says when to try again.',
  standardSchema: ErrorDocument,
};

@ApiTags('maintenance-lines')
@Controller('maintenance-lines')
@JsonApi()
@NamesPeople()
export class MaintenanceLinesController {
  constructor(
    private readonly listLines: ListMaintenanceLinesAction,
    private readonly getLine: GetMaintenanceLineAction,
    private readonly startLine: StartMaintenanceLineAction,
    private readonly closeLine: CloseMaintenanceLineAction,
    private readonly listReleases: ListMaintenanceLineReleasesAction,
  ) {}

  @Get()
  @Paged()
  @Filters(
    {
      name: 'product',
      description: 'Only lines of this product.',
    },
    {
      name: 'state',
      description: 'Only `open` lines, or only `closed` ones.',
    },
  )
  @ApiOperation({
    summary: 'List maintenance lines',
    description:
      'Maintenance lines, newest first: each the branch an older product revision is fixed on, started from one of its releases. Needs the `content.read.draft` permission (a line’s branch holds unreleased fixes).',
  })
  @ApiPermission('content.read.draft')
  @ApiOkResponse({ standardSchema: MaintenanceLinePageDocument })
  async list(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @PageParams() page: PageRequest,
    @Query('filter[product]', {
      schema: maintenanceLineFilters.product.optional(),
    })
    product?: string,
    @Query('filter[state]', {
      schema: maintenanceLineFilters.state.optional(),
    })
    state?: MaintenanceLineState,
  ): Promise<z.infer<typeof MaintenanceLinePageDocument>> {
    const result = await this.listLines.handle({
      actor,
      page,
      filter: {
        ...(product !== undefined && { product }),
        ...(state !== undefined && { state }),
      },
    });
    return toPagedDocument(req, page, result, toMaintenanceLineResource);
  }

  @Get(':maintenanceLineId')
  @ApiOperation({
    summary: 'Read a maintenance line',
    description:
      'One maintenance line: its product and revision, its branch and where it points now (`meta.head`), its base release, who started it and whether it is closed. Needs the `content.read.draft` permission.',
  })
  @ApiParam(ID_PARAMETER)
  @ApiPermission('content.read.draft')
  @ApiOkResponse({ standardSchema: MaintenanceLineDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  async get(
    @CurrentActor() actor: Actor,
    @Param('maintenanceLineId') id: string,
  ): Promise<Document> {
    return {
      data: toMaintenanceLineResource(await this.getLine.handle({ actor, id })),
    };
  }

  @Get(':maintenanceLineId/releases')
  @Paged()
  @ApiOperation({
    summary: 'List the releases of a maintenance line',
    description:
      'The releases cut from the line’s branch (`POST /releases` with `maintenanceLine`), newest first; its base release is `relationships.baseRelease`, not one of them. Needs the `content.read.draft` permission.',
  })
  @ApiParam(ID_PARAMETER)
  @ApiPermission('content.read.draft')
  @ApiOkResponse({ standardSchema: ReleasePageDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  async releases(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @Param('maintenanceLineId') id: string,
    @PageParams() page: PageRequest,
  ): Promise<z.infer<typeof ReleasePageDocument>> {
    const result = await this.listReleases.handle({ actor, id, page });
    return toPagedDocument(req, page, result, toReleaseResource);
  }

  @Post()
  @ApiOperation({
    summary: 'Start a maintenance line',
    description:
      'Starts a line for fixing an older product revision: creates the branch named by `CCMS_MAINTENANCE_BRANCH` (default `maintenance/{product}/{revision}`, the base release’s) at exactly the release’s commit, then records the line and a `maintenance-line.start` audit event. Change sets start on it with `maintenanceLine` (`POST /change-sets`) and merge into its branch; releases are cut from its head with `maintenanceLine` (`POST /releases`). One line per release. Needs the `release.publish` permission in a role whose scope covers the release’s product in every language, module type and audience, and `content.read` (to read `openfolia.yaml` at the release’s tag).',
  })
  @ApiPermission('release.publish')
  @ApiCreatedResponse({
    standardSchema: MaintenanceLineDocument,
    headers: {
      Location: { description: 'The new line.', schema: { type: 'string' } },
    },
  })
  @ApiConflictResponse({
    description:
      '`maintenance-line-exists`: a line was started from this release already (`meta.maintenanceLineId`). `branch-exists`: a branch of the line’s name exists at another commit, or clashes with a branch or tag.',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`invalid-maintenance-branch`: the product and revision make no branch name by the pattern.',
    standardSchema: ErrorDocument,
  })
  @ApiNotFoundResponse({
    description: '`not-found`: no published release with this ID.',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse(TIMEOUT)
  async start(
    @CurrentActor() actor: Actor,
    @Body({ schema: StartMaintenanceLineDocument })
    body: StartMaintenanceLineDocument,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Document> {
    const view = await this.startLine.handle({
      actor,
      releaseId: body.data.relationships.baseRelease.data.id,
    });
    res.setHeader('Location', `/maintenance-lines/${view.line.id}`);
    return { data: toMaintenanceLineResource(view) };
  }

  @Post(':maintenanceLineId/close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Close a maintenance line',
    description:
      'Closes a line for good: its branch, its change sets and its releases stay (open change sets may still be merged, releases still cut), but no new change set starts on it. Records a `maintenance-line.close` audit event with the comment. Needs the `release.publish` permission as starting a line does.',
  })
  @ApiParam(ID_PARAMETER)
  @ApiPermission('release.publish')
  @ApiOkResponse({ standardSchema: MaintenanceLineDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    description:
      '`invalid-state`: the line is closed already (`meta.state: "closed"`).',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse(TIMEOUT)
  async close(
    @CurrentActor() actor: Actor,
    @Param('maintenanceLineId') id: string,
    @Body({ schema: CloseMaintenanceLineDocument })
    body: CloseMaintenanceLineDocument,
  ): Promise<Document> {
    const comment = body?.meta?.comment;
    return {
      data: toMaintenanceLineResource(
        await this.closeLine.handle({
          actor,
          id,
          ...(comment !== undefined && { comment }),
        }),
      ),
    };
  }
}
