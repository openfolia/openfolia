import { Controller, Get, HttpStatus, Query, Req } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { DeliveryApi } from '../../base/api/delivery.decorator.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import {
  AcceptsQuery,
  Filters,
  JsonApi,
  PageParams,
  Paged,
} from '../../base/api/json-api.decorators.js';
import { ErrorDocument, toPagedDocument } from '../../base/api/json-api.js';
import { JsonApiException } from '../../base/api/json-api.exception.js';
import { params } from '../../base/api/schemas.js';
import type { PageRequest } from '../../base/core/paging.js';
import {
  CONTENT_HEADERS,
  CurrentSnapshot,
  ReadsContent,
} from '../../content/api/read-content.js';
import {
  moduleFilterParams,
  ModuleFilters,
} from '../../content/api/module-filter.params.js';
import {
  filtersModules,
  type FacetValue,
} from '../../content/core/module-filter.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import { MAX_QUERY_LENGTH } from '../core/content-search.js';
import { SearchContentAction } from '../core/actions/search-content.action.js';
import { SearchPageDocument, toSearchResource } from './search.resources.js';

const SearchQuery = z
  .string()
  .trim()
  .min(1, 'Give at least one character to search for.')
  .max(MAX_QUERY_LENGTH, `At most ${MAX_QUERY_LENGTH} characters.`);

/** `Module`/`Manual`/`Term` as in `attributes.resourceType`; lower case too. */
const ResourceType = z
  .enum(['module', 'manual', 'term', 'Module', 'Manual', 'Term'])
  .transform((v) => v.toLowerCase() as 'module' | 'manual' | 'term');

/** What `filter[type]` meant before `filter[resourceType]`: still accepted, deprecated. */
const LEGACY_TYPES: ReadonlySet<string> = new Set(['module', 'manual']);

@ApiTags('search')
@Controller('search')
@JsonApi()
@ReadsContent()
export class SearchController {
  constructor(private readonly searchContent: SearchContentAction) {}

  @Get()
  @DeliveryApi()
  @Paged()
  @AcceptsQuery('filter[q]')
  @ApiQuery({
    name: 'filter[q]',
    required: false,
    description: `What to search for, 1 to ${MAX_QUERY_LENGTH} characters after trimming. Every word has to match, in the title, in the keywords or in one block's text; case and diacritics do not matter. Required unless a module filter (\`filter[type]\` as a module type, \`filter[audience]\`, \`filter[facet]\`, \`filter[keyword]\`) is given.`,
    schema: { type: 'string', minLength: 1, maxLength: MAX_QUERY_LENGTH },
  })
  @Filters(
    {
      name: 'lang',
      description:
        'Only modules and terms in this language (manuals have none, so they are left out).',
    },
    {
      name: 'resourceType',
      description:
        'Only `Module`, only `Manual` or only `Term` results (as in `attributes.resourceType`; `module`, `manual` and `term` too).',
    },
  )
  @ModuleFilters({
    typeDescription:
      'Only modules of this module type (a configured key, e.g. `procedure`); manuals are left out. **Deprecated meaning:** without `filter[resourceType]`, the values `module` and `manual` still mean `filter[resourceType]`, as they did before it; use `filter[resourceType]` for that.',
  })
  @ApiOperation({
    summary: 'Search modules, manuals and terms',
    description:
      'Modules by title, keywords, FAQ questions and text, manuals by title, and terms (one result per term and language) by their preferred variant (as the title), their allowed and forbidden variants (as keywords) and their definition (as text), among what the reader may see, at `?ref=`. Case and diacritics do not matter, and every word of the query is found anywhere in a title, in the keywords, in one FAQ question or in one block. With the Postgres search (the default) a word is found in any of its forms in the content’s language too (`starting` finds `starts`), and with a typo in a title or keyword; with an embedder configured, by meaning too (`meta.matchedOn: meaning`, after every word match). Title matches come first, then keyword matches, FAQ question matches (`meta.matchedOn: question`) and text matches, each ranked by how well they match in all of those ways. The filters run before paging, and the total counts only results the reader may see. A module filter (type, audience, facet, keyword) leaves manuals and terms out; with one, `filter[q]` may be left out, and every module the filters let through is a result (`meta.matchedOn: filter`), ordered by title. A filter value the configuration does not know matches nothing (no error). The excerpt is plain text with the match offsets in `meta`. Limits: each reader (a person or a service account) may search `CCMS_SEARCH_PER_MINUTE` times a minute on a server (default 120; past it 429 `rate-limited`), and a search has `CCMS_SEARCH_TIMEOUT_MS` in the database for all its statements together (default 5 s; past it 503 `database-timeout`); both answers carry `Retry-After`.',
  })
  @ApiPermission('content.read')
  @ApiOkResponse({
    standardSchema: SearchPageDocument,
    headers: CONTENT_HEADERS,
  })
  @ApiTooManyRequestsResponse({
    description:
      '`rate-limited`: more searches this minute than `CCMS_SEARCH_PER_MINUTE` allows the reader on this server, or two of the reader’s searches are in progress already (`Retry-After: 1`); `Retry-After` (and `meta.retryAfter`) says when to try again.',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description:
      '`database-timeout`: the search took longer in the database than `CCMS_SEARCH_TIMEOUT_MS` (all its statements together) and was stopped. `search-busy`: as many searches as `CCMS_SEARCH_CONCURRENCY` allows ran at once on this server, and this one waited too long for its turn. Each with `Retry-After`.',
    standardSchema: ErrorDocument,
  })
  async search(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @PageParams() page: PageRequest,
    @Query('filter[q]', { schema: SearchQuery.optional() })
    query?: z.infer<typeof SearchQuery>,
    @Query('filter[lang]', { schema: params.lang.optional() }) lang?: string,
    @Query('filter[resourceType]', { schema: ResourceType.optional() })
    resourceType?: z.infer<typeof ResourceType>,
    @Query('filter[type]', { schema: moduleFilterParams.type.optional() })
    type?: string,
    @Query('filter[audience]', {
      schema: moduleFilterParams.audience.optional(),
    })
    audience?: string,
    @Query('filter[facet]', { schema: moduleFilterParams.facet.optional() })
    facets?: FacetValue[],
    @Query('filter[keyword]', {
      schema: moduleFilterParams.keyword.optional(),
    })
    keywords?: string[],
  ): Promise<z.infer<typeof SearchPageDocument>> {
    // The old meaning of `filter[type]`, as long as `filter[resourceType]` is not given.
    const legacy =
      resourceType === undefined &&
      type !== undefined &&
      LEGACY_TYPES.has(type);
    const filter = {
      lang,
      resourceType: legacy ? (type as 'module' | 'manual') : resourceType,
      type: legacy ? undefined : type,
      audience,
      facets,
      keywords,
    };
    if (query === undefined && !filtersModules(filter)) {
      throw new JsonApiException(HttpStatus.BAD_REQUEST, [
        {
          code: 'invalid-parameter',
          detail:
            'Give something to search for, or a module filter (type, audience, facet or keyword).',
          source: { parameter: 'filter[q]' },
        },
      ]);
    }
    const result = await this.searchContent.handle({
      actor,
      snapshot,
      query,
      filter,
      page,
    });
    return toPagedDocument(req, page, result, toSearchResource);
  }
}
