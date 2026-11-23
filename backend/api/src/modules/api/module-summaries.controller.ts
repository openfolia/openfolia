import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import {
  Filters,
  JsonApi,
  PageParams,
  Paged,
} from '../../base/api/json-api.decorators.js';
import { toPagedDocument } from '../../base/api/json-api.js';
import { params } from '../../base/api/schemas.js';
import { NotFoundError } from '../../base/core/errors.js';
import type { PageRequest } from '../../base/core/paging.js';
import {
  BeyondTheCommit,
  CONTENT_HEADERS,
  CurrentSnapshot,
  ReadsContent,
} from '../../content/api/read-content.js';
import {
  MAX_MODULE_IDS,
  moduleFilterParams,
  ModuleFilters,
  moduleIdList,
} from '../../content/api/module-filter.params.js';
import type { FacetValue } from '../../content/core/module-filter.js';
import { OpenSnapshotAction } from '../../content/core/actions/open-snapshot.action.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import { RELEASED_BRANCH } from '../../content/core/released.js';
import {
  ListModuleSummariesAction,
  SUMMARY_STATUSES,
  type SummaryStatus,
} from '../core/actions/list-module-summaries.action.js';
import { HISTORY_WINDOW } from '../core/module-history.js';
import {
  ModuleSummaryPageDocument,
  toModuleSummaryResource,
} from './module-summary.resources.js';

export const MAX_SUMMARY_QUERY_LENGTH = 200;

const BooleanFilter = z.enum(['true', 'false']).transform((v) => v === 'true');

const SummaryQuery = z.string().max(MAX_SUMMARY_QUERY_LENGTH).trim().min(1);

/** The most module IDs `filter[id]` takes: a full page of them (`MAX_MODULE_IDS`). */
export const MAX_SUMMARY_IDS = MAX_MODULE_IDS;

/** `filter[id]`: module IDs, comma-separated, each a module ID, at most `MAX_SUMMARY_IDS`. */
const SummaryIds = moduleIdList('filter[id]');

/**
 * The content browser's list: one row per module, its languages grouped,
 * filtered and paged on the server. Not part of the delivery API: it is for
 * authors (whether a module changed is a draft's notion).
 */
@ApiTags('modules')
@Controller('module-summaries')
@JsonApi()
@ReadsContent()
export class ModuleSummariesController {
  constructor(
    private readonly listSummaries: ListModuleSummariesAction,
    private readonly openSnapshot: OpenSnapshotAction,
  ) {}

  @Get()
  // `meta.changed` depends on the released branch too, as this reader sees it; deleted modules,
  // for a reader without draft access, on `main` and the releases (#418).
  @BeyondTheCommit()
  @Paged()
  @ModuleFilters()
  @Filters(
    {
      name: 'lang',
      description:
        'Only modules that exist in this language; titles in it, and `filter[keyword]` matched in it.',
    },
    {
      name: 'changed',
      description:
        '`true`: only modules that differ from the released branch (`main`); `false`: only those that do not.',
    },
    {
      name: 'q',
      description: `Only modules whose title (in any language) or ID contains this text, case aside; 1 to ${MAX_SUMMARY_QUERY_LENGTH} characters after trimming.`,
    },
    {
      name: 'snippet',
      description:
        '`true`: only snippets, the modules of a type the configuration marks `snippet: true`; `false`: only the others.',
    },
    {
      name: 'deprecated',
      description:
        '`true`: only deprecated modules (`attributes.deprecated`, #266); `false`: only the others. A content browser hides deprecated modules with `false`. Not applied to deleted modules (`filter[status]`), listed either way.',
    },
    {
      name: 'id',
      description: `Only the modules of these IDs, comma-separated (\`a,b,c\`), 1 to ${MAX_SUMMARY_IDS}: a screen reads the summaries of the modules it shows (a manual's outline) instead of the whole list. An ID that names no module the reader sees is left out, like any module that does not match.`,
    },
    {
      name: 'status',
      description: `\`current\` (the default): the modules there; \`deleted\`: the modules deleted on the ref's first-parent line (among its newest ${HISTORY_WINDOW} commits) that the reader sees no file of now, each summarised from the last versions of its deleted files that the reader may see (\`meta.deleted\`; a module outside their scope is never listed). Without \`content.read.draft\`, only the deleted files whose last version released content (\`main\`’s head, a release tag) holds exactly, each from that file as the reader reads it there. \`any\`: both, in one list. Every other filter but \`filter[deprecated]\` applies to a deleted module's last versions.`,
    },
  )
  @ApiOperation({
    summary: 'List module summaries',
    description:
      'The modules the reader may see, one per module ID with the languages it exists in, ordered by title. For a content browser: filters run on the server, before paging, and `meta.changed` says whether a module differs from the released branch (`main`), as the reader sees that (a language deleted on the branch alone does not count; a module outside what the reader sees on `main` counts as changed). Module files that cannot be read are left out (`GET /modules` lists them).',
  })
  @ApiPermission('content.read')
  @ApiOkResponse({
    standardSchema: ModuleSummaryPageDocument,
    headers: CONTENT_HEADERS,
  })
  async list(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @PageParams() page: PageRequest,
    @Query('filter[lang]', { schema: params.lang.optional() }) lang?: string,
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
    @Query('filter[changed]', { schema: BooleanFilter.optional() })
    changed?: boolean,
    @Query('filter[q]', { schema: SummaryQuery.optional() }) q?: string,
    @Query('filter[snippet]', { schema: BooleanFilter.optional() })
    snippet?: boolean,
    @Query('filter[deprecated]', { schema: BooleanFilter.optional() })
    deprecated?: boolean,
    @Query('filter[status]', { schema: z.enum(SUMMARY_STATUSES).optional() })
    status?: SummaryStatus,
    @Query('filter[id]', { schema: SummaryIds.optional() })
    ids?: ReadonlySet<string>,
  ): Promise<z.infer<typeof ModuleSummaryPageDocument>> {
    const released = await this.released(actor);
    const result = await this.listSummaries.handle({
      actor,
      snapshot,
      released,
      filter: {
        lang,
        type,
        audience,
        facets,
        keywords,
        changed,
        q,
        snippet,
        deprecated,
        status,
        ids,
      },
      page,
    });
    return toPagedDocument(req, page, result, toModuleSummaryResource);
  }

  /** The released branch as `actor` reads it; undefined when there is none. */
  private async released(actor: Actor): Promise<ReadableContent | undefined> {
    try {
      return await this.openSnapshot.handle({ actor, ref: RELEASED_BRANCH });
    } catch (error) {
      if (error instanceof NotFoundError) return undefined;
      throw error;
    }
  }
}
