import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { DeliveryApi } from '../../base/api/delivery.decorator.js';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { ConfigKey } from '@openfolia/content-model';
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
import { toPagedDocument } from '../../base/api/json-api.js';
import { params } from '../../base/api/schemas.js';
import type { PageRequest } from '../../base/core/paging.js';
import {
  BeyondTheCommit,
  CONTENT_HEADERS,
  CurrentSnapshot,
  ReadsContent,
} from '../../content/api/read-content.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import {
  moduleFilterParams,
  ModuleFilters,
} from '../../content/api/module-filter.params.js';
import type { FacetValue } from '../../content/core/module-filter.js';
import { GetModuleAction } from '../core/actions/get-module.action.js';
import { GetModuleStatusesAction } from '../core/actions/get-module-statuses.action.js';
import { GetModuleUsageAction } from '../core/actions/get-module-usage.action.js';
import {
  ListModulesAction,
  MODULE_SORT_FIELDS,
  MODULE_STATUSES,
  type ModuleSort,
  type ModuleSortField,
  type ModuleStatusFilter,
} from '../core/actions/list-modules.action.js';
import {
  ModuleDocument,
  ModulePageDocument,
  toModuleListResource,
  toModuleResource,
} from './module.resources.js';

/** The most fields one `sort` names. */
export const MAX_SORT_FIELDS = MODULE_SORT_FIELDS.length;

const SORT_FIELD = new RegExp(`^-?(${MODULE_SORT_FIELDS.join('|')})$`);

/** `sort`: comma-separated fields, each ascending or (`-`) descending, each once. */
export const ModuleSortParam = z
  .string()
  .transform((v) => v.split(','))
  .pipe(
    z
      .array(
        z
          .string()
          .regex(
            SORT_FIELD,
            `a field (${MODULE_SORT_FIELDS.join(', ')}), \`-\` before it for descending`,
          ),
      )
      .min(1)
      .max(MAX_SORT_FIELDS, `At most ${MAX_SORT_FIELDS} fields.`)
      .refine(
        (fields) =>
          new Set(fields.map((f) => f.replace(/^-/, ''))).size ===
          fields.length,
        'Each field at most once.',
      ),
  )
  .transform((fields): ModuleSort[] =>
    fields.map((f) => ({
      field: f.replace(/^-/, '') as ModuleSortField,
      descending: f.startsWith('-'),
    })),
  );

const StatusParam = z.enum(MODULE_STATUSES);

@ApiTags('modules')
@Controller('modules')
@JsonApi()
@ReadsContent()
export class ModulesController {
  constructor(
    private readonly listModules: ListModulesAction,
    private readonly getModule: GetModuleAction,
    private readonly getStatuses: GetModuleStatusesAction,
    private readonly getUsage: GetModuleUsageAction,
  ) {}

  @Get()
  @DeliveryApi()
  @BeyondTheCommit()
  @Paged()
  @Filters({ name: 'lang', description: 'Only modules in this language.' })
  @ModuleFilters()
  @Filters(
    {
      name: 'product',
      description:
        'Only modules with this value of the product facet (`release.productFacet` in the configuration, else the first facet), as releases name products; none when there is no facet.',
    },
    {
      name: 'status',
      description: `Only modules that stand so (\`meta.status\`): \`released\` (the newest release holding the module holds exactly this file), \`changed\` (a release holds it, but this file differs), \`unreleased\` (none of the 50 newest releases holds it) or \`in-change-set\` (an open change set the reader may read changes it; none for a reader who is not told of change sets).`,
    },
  )
  @AcceptsQuery('sort')
  @ApiQuery({
    name: 'sort',
    required: false,
    description: `Comma-separated fields (\`${MODULE_SORT_FIELDS.join('`, `')}\`; \`usage\` is the count of manuals and modules using it), each \`-\`-prefixed for descending, each at most once; ties by language, then ID. A file that cannot be read sorts after the rest by title and type. Default: \`lang,id\`.`,
    schema: { type: 'string', example: '-usage,title' },
  })
  @ApiOperation({
    summary: 'List modules',
    description:
      'The modules the reader may see, ordered by language and ID (or `sort`), filtered on the module index before paging (the total counts only those), each with its status in `meta.status` and where it is used in `meta.usedIn` and `meta.usage` (only manuals and modules the reader may see). A module file that cannot be read is listed with its error to a reader of everything in its language; a filter on metadata or status leaves it out.',
  })
  @ApiPermission('content.read')
  @ApiOkResponse({
    standardSchema: ModulePageDocument,
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
    @Query('filter[product]', { schema: ConfigKey.optional() })
    product?: string,
    @Query('filter[status]', { schema: StatusParam.optional() })
    status?: ModuleStatusFilter,
    @Query('sort', { schema: ModuleSortParam.optional() })
    sort?: ModuleSort[],
  ): Promise<z.infer<typeof ModulePageDocument>> {
    const result = await this.listModules.handle({
      actor,
      snapshot,
      filter: { lang, type, audience, facets, keywords, product, status },
      sort,
      page,
    });
    return toPagedDocument(req, page, result, toModuleListResource);
  }

  @Get(':lang/:id')
  @DeliveryApi()
  @BeyondTheCommit()
  @ApiOperation({
    summary: 'Read a module',
    description:
      'One module in one language, with the problems found checking it against the project configuration, its status (`meta.status`: the newest release holding it, `main`, the open change sets changing it), derived from Git, and where it is used (`meta.usedIn`, `meta.usage`: only manuals and modules the reader may see).',
  })
  @ApiParam({ name: 'lang', example: 'en' })
  @ApiParam({ name: 'id', example: 'battery-charging' })
  @ApiPermission('content.read')
  @ApiOkResponse({ standardSchema: ModuleDocument, headers: CONTENT_HEADERS })
  async read(
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @Param('lang', { schema: params.lang }) lang: string,
    @Param('id', { schema: params.moduleId }) id: string,
  ): Promise<z.infer<typeof ModuleDocument>> {
    const { module, issues } = await this.getModule.handle({
      actor,
      snapshot,
      id,
      lang,
    });
    const statuses = await this.getStatuses.handle({
      actor,
      snapshot,
      modules: [{ id, lang }],
    });
    const status = statuses.get(`${lang}/${id}`);
    if (!status) throw new Error(`no status for ${lang}/${id}`);
    const usage = await this.getUsage.handle({ actor, snapshot, id });
    return { data: toModuleResource(module, issues, status, usage) };
  }
}
