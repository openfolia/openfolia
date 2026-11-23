import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { PageDesignId } from '@openfolia/content-model';
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
import { toPagedDocument } from '../../base/api/json-api.js';
import { params } from '../../base/api/schemas.js';
import type { PageRequest } from '../../base/core/paging.js';
import {
  MAX_MODULE_IDS,
  moduleIdList,
} from '../../content/api/module-filter.params.js';
import {
  BeyondTheCommit,
  CONTENT_HEADERS,
  CurrentSnapshot,
  ReadsContent,
} from '../../content/api/read-content.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import { GetTranslationStatusAction } from '../core/actions/get-translation-status.action.js';
import { ListTranslationStatusesAction } from '../core/actions/list-translation-statuses.action.js';
import type { StatusPaging } from '../core/translation-index.js';
import {
  TRANSLATION_STATES,
  TRANSLATION_STATUS_KINDS,
  type TranslationState,
  type TranslationStatusKind,
} from '../core/translation-status.js';
import {
  toTranslationStatusDetailResource,
  toTranslationStatusResource,
  TranslationStatusDocument,
  TranslationStatusPageDocument,
} from './translation-status.resources.js';
import { Folder } from './translation-job.resources.js';

export const MAX_STATUS_QUERY_LENGTH = 200;

const StatusQuery = z.string().max(MAX_STATUS_QUERY_LENGTH).trim().min(1);

/** `filter[module]` (#694): module IDs, comma-separated, at most `MAX_MODULE_IDS`. */
const StatusModules = moduleIdList('filter[module]');

/** What `page[size]` counts on `GET /translations/status` (#689). */
const STATUS_PAGINGS = [
  'status',
  'row',
] as const satisfies readonly StatusPaging[];

const PERMISSION_NOTE =
  'Needs `translation.manage` or `content.read.draft` (in any scope), on top of reading content (`content.read`); what it lists is limited by the reader’s scope, its languages included.';

/**
 * The translation state of source modules per target language (#243),
 * derived from the content, the translation records next to translated
 * modules and the open translation jobs. Not part of the delivery API.
 */
@ApiTags('translations')
@Controller('translations/status')
@JsonApi()
@ReadsContent()
export class TranslationsController {
  constructor(
    private readonly listStatuses: ListTranslationStatusesAction,
    private readonly getStatus: GetTranslationStatusAction,
  ) {}

  @Get()
  // `at-provider` comes from the translation jobs, not from the commit.
  @BeyondTheCommit()
  @Paged()
  @AcceptsQuery('page[by]')
  @ApiQuery({
    name: 'page[by]',
    required: false,
    description:
      'What `page[size]`, `meta.page.total` and the pages count: `status` (the default), one `TranslationStatus` each; or `row` (#689), one row of the module × language matrix each (a module, a page design, a manual or the project labels), with every status the row has on the page, however many languages that is (at most `page[size]` × the target languages).',
    schema: { type: 'string', enum: [...STATUS_PAGINGS], default: 'status' },
  })
  @Filters(
    {
      name: 'lang',
      description:
        'Only this target language; one that is not a target language matches nothing.',
    },
    {
      name: 'manual',
      description:
        'Only the modules this manual includes, also through module references, as the reader reads it, its page design, its own text, and the project labels (its title page shows them); a manual the reader may not see matches nothing.',
    },
    {
      name: 'folder',
      description:
        'Only the modules in a folder of the content browser: `<type>` (a module type) or `<type>/<value>` (and a value of the first configured facet). No page design, no manual and no project labels.',
    },
    {
      name: 'state',
      description: `Only this state: ${TRANSLATION_STATES.map((s) => `\`${s}\``).join(', ')}.`,
    },
    {
      name: 'q',
      description: `Only modules whose source title or ID (page designs whose name or ID, manuals whose source title or ID; the project labels for text in \`Project labels\` or \`config.project\`, e.g. \`labels\` or \`config\`) contains this text, case and diacritics aside; 1 to ${MAX_STATUS_QUERY_LENGTH} characters after trimming.`,
    },
    {
      name: 'module',
      description: `Only these source modules, comma-separated (\`a,b,c\`), 1 to ${MAX_MODULE_IDS} module IDs (#694): a content list reads the states of the modules on its page, with \`page[by]=row\` and a \`page[size]\` of at least their number (paged by status, the default, a page holds at most \`page[size]\` statuses: one per ID and target language). No page design, no manual and no project labels. An ID that names no source module the reader sees matches nothing, like a module that does not exist.`,
    },
    {
      name: 'kind',
      description:
        'Only `module` rows, only `design` rows (a page design’s region text, #568), only `manual` rows (a manual’s own text: its title, its groups’ titles, #731, and its cover images’ alternative text, #656), or only the `config` row (the project labels in `openfolia.yaml`, #731).',
    },
  )
  @ApiOperation({
    summary: 'List translation status',
    description: `First one \`TranslationStatus\` (\`kind\` \`config\`) per target language for the project labels (#731: the labels in \`openfolia.yaml\`; every reader of the ref reads them in every language; \`filter[manual]\` keeps them, \`filter[folder]\` not; none while no label has text); then one (\`kind\` \`design\`) per page design with region text and target language (#568; designs carry no audience: every reader of the ref reads them in every language; \`filter[manual]\` keeps the manual's design, \`filter[folder]\` none), by name; then one (\`kind\` \`manual\`) per manual and target language the reader reads it in (#656, #731: its title, its groups’ titles and its cover images’ alternative text; \`filter[manual]\` keeps that manual's, \`filter[folder]\` none), by title; then one per source module (as the reader sees it in the source language) and target language the reader would see a translation in, at \`?ref=\`: \`up-to-date\`, \`outdated\` (with \`meta.outdatedBlocks\`), \`missing\` or \`at-provider\`. Filtered before paging, so \`meta.page.total\` counts only what the reader may see. Ordered by source title, module ID and the configured order of target languages. Source files that cannot be read are left out. ${PERMISSION_NOTE}`,
  })
  @ApiPermission('translation.manage')
  @ApiOkResponse({
    standardSchema: TranslationStatusPageDocument,
    headers: CONTENT_HEADERS,
  })
  async list(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @PageParams() page: PageRequest,
    @Query('page[by]', { schema: z.enum(STATUS_PAGINGS).optional() })
    by: StatusPaging | undefined,
    @Query('filter[lang]', { schema: params.lang.optional() }) lang?: string,
    @Query('filter[manual]', { schema: params.manualId.optional() })
    manual?: string,
    @Query('filter[folder]', { schema: Folder.optional() }) folder?: string,
    @Query('filter[state]', { schema: z.enum(TRANSLATION_STATES).optional() })
    state?: TranslationState,
    @Query('filter[q]', { schema: StatusQuery.optional() }) q?: string,
    @Query('filter[kind]', {
      schema: z.enum(TRANSLATION_STATUS_KINDS).optional(),
    })
    kind?: TranslationStatusKind,
    @Query('filter[module]', { schema: StatusModules.optional() })
    modules?: ReadonlySet<string>,
  ): Promise<z.infer<typeof TranslationStatusPageDocument>> {
    const result = await this.listStatuses.handle({
      actor,
      snapshot,
      filter: { lang, manual, folder, state, q, kind, modules },
      page,
      by,
    });
    return toPagedDocument(req, page, result, toTranslationStatusResource);
  }

  @Get(':lang/config/project')
  @BeyondTheCommit()
  @ApiOperation({
    summary: 'Read the project labels’ translation status',
    description: `The project labels (#731: module types’, audiences’, facets’ and their values’, variant attributes’ and their values’, text attributes’, safety symbols’ and callout styles’ labels in \`openfolia.yaml\`) in one target language, with every unit’s state in \`meta.blocks\` (\`moduleTypes.<id>\`, \`facets.<id>.<value>\`, …). Not found when the language is no target language or there is no label to translate. ${PERMISSION_NOTE}`,
  })
  @ApiParam({ name: 'lang', example: 'de' })
  @ApiPermission('translation.manage')
  @ApiOkResponse({
    standardSchema: TranslationStatusDocument,
    headers: CONTENT_HEADERS,
  })
  async readConfig(
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @Param('lang', { schema: params.lang }) lang: string,
  ): Promise<z.infer<typeof TranslationStatusDocument>> {
    const status = await this.getStatus.handle({
      actor,
      snapshot,
      config: true,
      lang,
    });
    return { data: toTranslationStatusDetailResource(status) };
  }

  @Get(':lang/designs/:designId')
  @BeyondTheCommit()
  @ApiOperation({
    summary: 'Read a page design’s translation status',
    description: `A page design’s region text (#568) in one target language, with every unit’s state in \`meta.blocks\` (\`<slot>.<block>\`). Not found when the language is no target language, there is no such design (or it cannot be read), or it has no region text. ${PERMISSION_NOTE}`,
  })
  @ApiParam({ name: 'lang', example: 'de' })
  @ApiParam({ name: 'designId', example: 'product-line' })
  @ApiPermission('translation.manage')
  @ApiOkResponse({
    standardSchema: TranslationStatusDocument,
    headers: CONTENT_HEADERS,
  })
  async readDesign(
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @Param('lang', { schema: params.lang }) lang: string,
    @Param('designId', { schema: PageDesignId }) designId: string,
  ): Promise<z.infer<typeof TranslationStatusDocument>> {
    const status = await this.getStatus.handle({
      actor,
      snapshot,
      designId,
      lang,
    });
    return { data: toTranslationStatusDetailResource(status) };
  }

  @Get(':lang/manuals/:manualId')
  @BeyondTheCommit()
  @ApiOperation({
    summary: 'Read a manual’s own translation status',
    description: `A manual’s own text (its title and its groups’ titles, #731; its cover images’ alternative text, #656) in one target language, with every unit’s state in \`meta.blocks\` (\`title\`, \`group.<hex>\`, \`coverImage.default\`, \`coverImage.variant-<hex>\`). Not found when the language is no target language, there is no such manual for the reader (or its manifest cannot be read), or they do not read it in that language. ${PERMISSION_NOTE}`,
  })
  @ApiParam({ name: 'lang', example: 'de' })
  @ApiParam({ name: 'manualId', example: 'operating-manual' })
  @ApiPermission('translation.manage')
  @ApiOkResponse({
    standardSchema: TranslationStatusDocument,
    headers: CONTENT_HEADERS,
  })
  async readManual(
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @Param('lang', { schema: params.lang }) lang: string,
    @Param('manualId', { schema: params.manualId }) manualId: string,
  ): Promise<z.infer<typeof TranslationStatusDocument>> {
    const status = await this.getStatus.handle({
      actor,
      snapshot,
      manualId,
      lang,
    });
    return { data: toTranslationStatusDetailResource(status) };
  }

  @Get(':lang/:moduleId')
  @BeyondTheCommit()
  @ApiOperation({
    summary: 'Read a translation status',
    description: `One source module in one target language, with every translatable block’s state in \`meta.blocks\`. Not found, exactly like a module that does not exist, when the language is no target language, the module is not there for the reader in the source language, or the reader would not see a translation in that language. ${PERMISSION_NOTE}`,
  })
  @ApiParam({ name: 'lang', example: 'de' })
  @ApiParam({ name: 'moduleId', example: 'battery-charging' })
  @ApiPermission('translation.manage')
  @ApiOkResponse({
    standardSchema: TranslationStatusDocument,
    headers: CONTENT_HEADERS,
  })
  async read(
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @Param('lang', { schema: params.lang }) lang: string,
    @Param('moduleId', { schema: params.moduleId }) moduleId: string,
  ): Promise<z.infer<typeof TranslationStatusDocument>> {
    const status = await this.getStatus.handle({
      actor,
      snapshot,
      moduleId,
      lang,
    });
    return { data: toTranslationStatusDetailResource(status) };
  }
}
