import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import {
  TERM_STATUSES,
  TermId,
  type TermStatus,
} from '@openfolia/content-model';
import type { Request } from 'express';
import { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import { DeliveryApi } from '../../base/api/delivery.decorator.js';
import {
  Filters,
  JsonApi,
  PageParams,
  Paged,
} from '../../base/api/json-api.decorators.js';
import { toPagedDocument } from '../../base/api/json-api.js';
import { params } from '../../base/api/schemas.js';
import type { PageRequest } from '../../base/core/paging.js';
import {
  CONTENT_HEADERS,
  CurrentSnapshot,
  ReadsContent,
} from '../../content/api/read-content.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import { MAX_QUERY_LENGTH } from '../../search/core/content-search.js';
import { GetTermAction } from '../core/actions/get-term.action.js';
import { ListTermsAction } from '../core/actions/list-terms.action.js';
import {
  TermDocument,
  TermPageDocument,
  toTermListResource,
  toTermDetailResource,
} from './term.resources.js';

/** `filter[q]`: what to look for, as `GET /search` takes it. */
const TermQuery = z
  .string()
  .trim()
  .min(1, 'Give at least one character to search for.')
  .max(MAX_QUERY_LENGTH, `At most ${MAX_QUERY_LENGTH} characters.`);

const TermStatusParam = z.enum(TERM_STATUSES);

const DomainParam = z
  .string()
  .trim()
  .min(1, 'Give a domain.')
  .max(100, 'At most 100 characters.');

/** The terminology (#135): terms as content, read at `?ref=` like every content route. */
@ApiTags('terms')
@Controller('terms')
@JsonApi()
@ReadsContent()
export class TermsController {
  constructor(
    private readonly listTerms: ListTermsAction,
    private readonly getTerm: GetTermAction,
  ) {}

  @Get()
  @DeliveryApi()
  @Paged()
  @Filters(
    {
      name: 'lang',
      description:
        'Only terms holding this language (a language tag); `filter[q]` then looks in it only.',
    },
    {
      name: 'status',
      description: `Only terms of this status: ${TERM_STATUSES.map((s) => `\`${s}\``).join(', ')}.`,
    },
    {
      name: 'domain',
      description:
        'Only terms of this domain, case, diacritics and runs of white space aside.',
    },
    {
      name: 'q',
      description: `1 to ${MAX_QUERY_LENGTH} characters after trimming: part of one of a term’s variants (preferred, allowed or forbidden) or of its definition, folded as \`GET /search\` folds (case, diacritics and runs of white space aside).`,
    },
  )
  @ApiOperation({
    summary: 'List terms',
    description:
      'The terms at `?ref=`, by ID. The filters run before paging, and `meta.page.total` counts what they let through. Without a filter, a file in `terms/` that is no term is listed too (`UnreadableTermResource`, with `meta.error`); a filter leaves such files out. Terms carry no audience: every reader of the ref reads them, in every language.',
  })
  @ApiPermission('content.read')
  @ApiOkResponse({
    standardSchema: TermPageDocument,
    headers: CONTENT_HEADERS,
  })
  async list(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @PageParams() page: PageRequest,
    @Query('filter[lang]', { schema: params.lang.optional() }) lang?: string,
    @Query('filter[status]', { schema: TermStatusParam.optional() })
    status?: TermStatus,
    @Query('filter[domain]', { schema: DomainParam.optional() })
    domain?: string,
    @Query('filter[q]', { schema: TermQuery.optional() }) q?: string,
  ): Promise<z.infer<typeof TermPageDocument>> {
    const result = await this.listTerms.handle({
      actor,
      snapshot,
      filter: { lang, status, domain, q },
      page,
    });
    return toPagedDocument(req, page, result, toTermListResource);
  }

  @Get(':termId')
  @DeliveryApi()
  @ApiOperation({
    summary: 'Read a term',
    description:
      'One term at `?ref=`, with the problems found checking it against the configuration and the module files linking it (`meta.linkedIn`, #245). A file that is no term is 422 `invalid-content`.',
  })
  @ApiParam({ name: 'termId', example: 'charger' })
  @ApiPermission('content.read')
  @ApiOkResponse({ standardSchema: TermDocument, headers: CONTENT_HEADERS })
  async read(
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @Param('termId', { schema: TermId }) id: string,
  ): Promise<z.infer<typeof TermDocument>> {
    const { term, issues, usage } = await this.getTerm.handle({
      actor,
      snapshot,
      id,
    });
    return { data: toTermDetailResource(term, issues, usage) };
  }
}
