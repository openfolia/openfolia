import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiServiceUnavailableResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
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
import { ErrorDocument } from '../../base/api/json-api.js';
import type { PageRequest } from '../../base/core/paging.js';
import { MAX_REVIEWED_PATHS } from '../../change-sets/core/review-scope.js';
import { ListChangeSetChecksAction } from '../core/actions/list-change-set-checks.action.js';
import type { CheckSeverity } from '../core/check.js';
import {
  CheckPageDocument,
  checkFilters,
  toCheckPageDocument,
} from './check.resources.js';
import { SEVERITY_FILTER } from './manual-checks.controller.js';

@ApiTags('checks')
@Controller('change-sets')
@JsonApi()
export class ChangeSetChecksController {
  constructor(private readonly listChecks: ListChangeSetChecksAction) {}

  @Get(':changeSetId/checks')
  @Paged()
  @Filters(SEVERITY_FILTER)
  @ApiOperation({
    summary: 'Check a change set',
    description:
      'Blocking issues and warnings in what a change set changes, at its head (the review head once submitted, else its branch’s head): each changed module there (validation, module and cross-references, images the blob store does not hold, missing translations of a source-language module, and a `module-cycle` at each of its module references that leads back to it, whether or not a manual includes it), each changed manual there (as `GET /manuals/{id}/checks`), and the manuals and modules there that still refer to a module it removed. Read as the reader may read the head: nothing about a module they may not see is listed or counted, so a cycle through one is not reported to them. The change set is found as `GET /change-sets/{changeSetId}` finds it. Needs the `content.read` permission.',
  })
  @ApiParam({
    name: 'changeSetId',
    description:
      'The change set’s ID (a UUID). One that names no change set, malformed or not, is 404.',
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiPermission('content.read')
  @ApiServiceUnavailableResponse({
    description:
      'The PDF renderer is busy (`renderer-busy`: the checks render each PDF to check PDF/UA-1), too many checks are cutting the chunks of a whole commit (`chunk-sets-busy`, #710), or the server is shutting down; `Retry-After` says when to try again.',
    standardSchema: ErrorDocument,
  })
  @ApiOkResponse({ standardSchema: CheckPageDocument })
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
  async list(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @PageParams() page: PageRequest,
    @Param('changeSetId') id: string,
    @Query('filter[severity]', { schema: checkFilters.severity.optional() })
    severity?: CheckSeverity,
  ): Promise<z.infer<typeof CheckPageDocument>> {
    const result = await this.listChecks.handle({
      actor,
      id,
      page,
      filter: severity === undefined ? {} : { severity },
    });
    return toCheckPageDocument(req, page, result);
  }
}
