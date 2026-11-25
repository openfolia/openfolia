import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { DeliveryApi } from '../../base/api/delivery.decorator.js';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import { ReadsWorkingCopies } from '../../change-sets/api/working-copy-reads.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import {
  Filters,
  JsonApi,
  PageParams,
  Paged,
} from '../../base/api/json-api.decorators.js';
import { ErrorDocument, toPagedDocument } from '../../base/api/json-api.js';
import { params } from '../../base/api/schemas.js';
import type { PageRequest } from '../../base/core/paging.js';
import {
  CONTENT_HEADERS,
  BeyondTheCommit,
  CurrentSnapshot,
  ReadsContent,
} from '../../content/api/read-content.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import { GetManualAction } from '../core/actions/get-manual.action.js';
import {
  ListManualsAction,
  MANUAL_STATUSES,
  type ManualStatus,
} from '../core/actions/list-manuals.action.js';
import { HISTORY_WINDOW } from '../../modules/core/module-history.js';
import { ResolveManualAction } from '../core/actions/resolve-manual.action.js';
import {
  ManualDocument,
  ManualPageDocument,
  ResolvedManualDocument,
  toManualListResource,
  toManualResource,
  toResolvedManualResource,
} from './manual.resources.js';
import { BROKEN_OR_TOO_LARGE } from './too-large-response.js';
import { paginate } from '../../base/core/paging.js';
import { GetUpdateGuideAction } from '../core/actions/get-update-guide.action.js';
import {
  UpdateGuideDocument,
  UpdateGuideStepPageDocument,
  toUpdateGuideResource,
  toUpdateGuideStepResource,
} from './update-guide.resources.js';

@ApiTags('manuals')
@Controller('manuals')
@JsonApi()
@ReadsContent()
export class ManualsController {
  constructor(
    private readonly listManuals: ListManualsAction,
    private readonly getManual: GetManualAction,
    private readonly resolveManual: ResolveManualAction,
    private readonly getUpdateGuide: GetUpdateGuideAction,
  ) {}

  @Get()
  @DeliveryApi()
  // Deleted manuals, for a reader without draft access, depend on `main` and the releases (#410).
  @BeyondTheCommit()
  @Paged()
  @Filters({
    name: 'status',
    description: `\`current\` (the default): the manuals there; \`deleted\`: the manuals deleted on the ref's first-parent line (among its newest ${HISTORY_WINDOW} commits) that have no manifest now, each from its last manifest the reader may see (\`meta.deleted\`; one outside their scope is never listed), each with a history to open (\`GET /manuals/{id}/history\`). Without \`content.read.draft\`, only those whose last manifest released content (\`main\`’s head, a release tag) holds exactly, from that manifest as the reader reads it there. \`any\`: both, in one list.`,
  })
  @ApiOperation({
    summary: 'List manuals',
    description:
      'The manuals the reader may see (their audience within its scope), ordered by ID. One whose manifest cannot be read is listed with its error to a reader of every audience.',
  })
  @ApiPermission('content.read')
  @ApiOkResponse({
    standardSchema: ManualPageDocument,
    headers: CONTENT_HEADERS,
  })
  async list(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @PageParams() page: PageRequest,
    @Query('filter[status]', { schema: z.enum(MANUAL_STATUSES).optional() })
    status?: ManualStatus,
  ): Promise<z.infer<typeof ManualPageDocument>> {
    const result = await this.listManuals.handle({
      actor,
      snapshot,
      page,
      status,
    });
    return toPagedDocument(req, page, result, toManualListResource);
  }

  @Get(':id')
  @DeliveryApi()
  // `?workingCopy=true` (an authoring parameter, kept out of the delivery document): its author's
  // working copies in place of their files, a derived manual gathered from the rule its working
  // copy holds, from the source as the change set holds it (#669, the editor's builder).
  @ReadsWorkingCopies()
  @ApiOperation({
    summary: 'Read a manual definition',
    description:
      'The manifest, the variants it is published in (with the slugs the other manual routes take) and the problems found in it.',
  })
  @ApiParam({ name: 'id', example: 'operating' })
  @ApiPermission('content.read')
  @ApiOkResponse({ standardSchema: ManualDocument, headers: CONTENT_HEADERS })
  async read(
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @Param('id', { schema: params.manualId }) id: string,
  ): Promise<z.infer<typeof ManualDocument>> {
    const manual = await this.getManual.handle({ actor, snapshot, id });
    return { data: toManualResource({ id, ...manual }) };
  }

  @Get(':id/variants/:variant/:lang')
  @DeliveryApi()
  @ApiOperation({
    summary: 'Resolve a manual',
    description:
      'The manual assembled for one listed variant and a configured language: conditions applied, module references inlined, text attributes filled in (one the variant has no value for stays an `attribute` node, reported as `missing-text-attribute`), modules the reader may not see left out (an `outside-scope` issue each, for `content.read.draft` holders). Missing translations fall back to the source language and are reported as issues.',
  })
  @ApiParam({ name: 'id', example: 'operating' })
  @ApiParam({ name: 'variant', example: 'model=large' })
  @ApiParam({ name: 'lang', example: 'en' })
  @ApiPermission('content.read')
  @ApiOkResponse({
    standardSchema: ResolvedManualDocument,
    headers: CONTENT_HEADERS,
  })
  @ApiUnprocessableEntityResponse({
    description: BROKEN_OR_TOO_LARGE,
    standardSchema: ErrorDocument,
  })
  async resolve(
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @Param('id', { schema: params.manualId }) id: string,
    @Param('variant', { schema: params.variant }) variant: string,
    @Param('lang', { schema: params.lang }) lang: string,
  ): Promise<z.infer<typeof ResolvedManualDocument>> {
    const resolution = await this.resolveManual.handle({
      actor,
      snapshot,
      id,
      variant,
      lang,
    });
    return { data: toResolvedManualResource(variant, resolution) };
  }

  @Get(':id/update-guide/:lang')
  @DeliveryApi()
  @ApiOperation({
    summary: 'Read an update guide',
    description:
      'An update guide (`kind: update-guide`, #906) in a configured language: the versions a reader picks from and to, the levels and options it offers, and how many steps the reader may see (`…/steps` lists them). Not found for a manual of another kind, as for one the reader may not see.',
  })
  @ApiParam({ name: 'id', example: 'software-update' })
  @ApiParam({ name: 'lang', example: 'en' })
  @ApiPermission('content.read')
  @ApiOkResponse({
    standardSchema: UpdateGuideDocument,
    headers: CONTENT_HEADERS,
  })
  @ApiUnprocessableEntityResponse({
    description: BROKEN_OR_TOO_LARGE,
    standardSchema: ErrorDocument,
  })
  async updateGuide(
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @Param('id', { schema: params.manualId }) id: string,
    @Param('lang', { schema: params.lang }) lang: string,
  ): Promise<z.infer<typeof UpdateGuideDocument>> {
    const view = await this.getUpdateGuide.handle({
      actor,
      snapshot,
      id,
      lang,
    });
    return { data: toUpdateGuideResource(view) };
  }

  @Get(':id/update-guide/:lang/steps')
  @DeliveryApi()
  @Paged()
  @ApiOperation({
    summary: 'List an update guide’s steps',
    description:
      'Every step of the update guide the reader may see (#906), whatever its level and condition, with its version, phase, level, condition and body, ordered by version, then phase (`before`, `during`, `after`), then manifest order: a client picks the steps of a jump itself (`resolveUpdateGuide` in `@openfolia/content-model/core`: `from < version <= to`, the reader’s level and options).',
  })
  @ApiParam({ name: 'id', example: 'software-update' })
  @ApiParam({ name: 'lang', example: 'en' })
  @ApiPermission('content.read')
  @ApiOkResponse({
    standardSchema: UpdateGuideStepPageDocument,
    headers: CONTENT_HEADERS,
  })
  @ApiUnprocessableEntityResponse({
    description: BROKEN_OR_TOO_LARGE,
    standardSchema: ErrorDocument,
  })
  async updateGuideSteps(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @PageParams() page: PageRequest,
    @Param('id', { schema: params.manualId }) id: string,
    @Param('lang', { schema: params.lang }) lang: string,
  ): Promise<z.infer<typeof UpdateGuideStepPageDocument>> {
    const view = await this.getUpdateGuide.handle({
      actor,
      snapshot,
      id,
      lang,
    });
    return toPagedDocument(
      req,
      page,
      paginate(view.steps, page),
      toUpdateGuideStepResource,
    );
  }
}
