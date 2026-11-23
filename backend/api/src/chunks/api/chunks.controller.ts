import { Controller, Get, Query, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { parseVariantSlug, type VariantValues } from '@openfolia/content-model';
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
import { ErrorDocument, toPagedDocument } from '../../base/api/json-api.js';
import { params } from '../../base/api/schemas.js';
import type { PageRequest } from '../../base/core/paging.js';
import type { Env } from '../../config/env.js';
import {
  moduleFilterParams,
  ModuleFilters,
} from '../../content/api/module-filter.params.js';
import {
  BeyondTheCommit,
  CONTENT_HEADERS,
  CurrentSnapshot,
  ReadsContent,
} from '../../content/api/read-content.js';
import type { FacetValue } from '../../content/core/module-filter.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import { GetModuleStatusesAction } from '../../modules/core/actions/get-module-statuses.action.js';
import { VariantQuery } from '../../preview/api/preview.controller.js';
import { ListChunksAction } from '../core/actions/list-chunks.action.js';
import { ChunkPageDocument, toChunkResource } from './chunk.resources.js';

/** A full commit ID (SHA-1 or SHA-256), as `X-Ccms-Commit` names one. */
export const CommitId = z
  .string()
  .regex(
    /^[0-9a-f]{40}([0-9a-f]{24})?$/,
    'a full commit ID (40 or 64 lowercase hex characters), as `X-Ccms-Commit` gives it',
  );

/**
 * Retrieval chunks (#52): the content as ready-made Markdown chunks with
 * the metadata a retrieval pipeline filters on, for syncing it into a
 * search or embedding index. Part of the delivery API.
 */
@ApiTags('chunks')
@Controller('chunks')
@JsonApi()
@ReadsContent()
export class ChunksController {
  private readonly defaultRef: string;

  constructor(
    private readonly listChunks: ListChunksAction,
    private readonly getStatuses: GetModuleStatusesAction,
    config: ConfigService<Env, true>,
  ) {
    this.defaultRef = config.get('CCMS_DEFAULT_REF', { infer: true });
  }

  @Get()
  @DeliveryApi()
  // `meta.release` depends on the release tags too, not only the commit read.
  @BeyondTheCommit()
  @Paged()
  @ModuleFilters()
  @Filters(
    {
      name: 'module',
      description:
        'Only the chunks of this module (a module ID), one per language the reader may read it in (and one per FAQ entry in it). A module outside the reader’s scope, or that does not exist, has none.',
    },
    {
      name: 'lang',
      description: 'Only chunks in this language.',
    },
    {
      name: 'manual',
      description:
        'Only the modules this manual includes, as the reader may see it (with `filter[variant]`: the entries it includes for that variant). A manual the reader may not see, or that does not exist, includes nothing.',
    },
    {
      name: 'variant',
      description:
        'A variant slug such as `model=large,software=2.3` (as `GET /manuals/{id}` lists them, or any configured attribute values): variant blocks are resolved for it, so one for another variant is not in the text. Without it, each variant block is kept, headed by its condition. An attribute or value the configuration does not hold is a 422 `unknown-variant`.',
    },
    {
      name: 'changedSince',
      description:
        'A full commit ID in the history of the commit read (one a previous sync got in `X-Ccms-Commit`): only the chunks that may have changed since, because a module file their text was made from or depends on (an included module, a translation of it, a cross-reference target), the configuration or a manifest naming the module changed. `meta.release` is no file: a new release lists nothing here. Any other commit is a 400 `invalid-parameter`. Only files you may read now count: a deleted module, or a chunk whose included module was deleted or left your scope since, is not listed, so a full sync now and then catches those.',
    },
  )
  @ApiOperation({
    summary: 'List retrieval chunks',
    description:
      'The content as retrieval chunks: one per module and language the reader may see at `?ref=`, ordered by module ID and language, each followed by one per FAQ entry in it (`attributes.entry`, the entry alone as its text), each the module as Markdown with the metadata to filter on (type, audience, facets, keywords, manuals, variant conditions, the newest release) and `contentHash`, the SHA-256 of the text, so a pipeline re-embeds only what changed. Scoped like every read: a module outside the reader’s scope is never listed, counted or inlined into another chunk, and the filters run before paging. A module too large to cut once its module references are included has no chunk, and only it: `meta.leftOut` names it. Modules too large to cut together (many each including a lot, past a budget of four times the content they are made from) make the whole commit a 422 `chunk-set-too-large`, for readers who see them.',
  })
  @ApiPermission('content.read')
  @ApiOkResponse({
    standardSchema: ChunkPageDocument,
    headers: CONTENT_HEADERS,
  })
  @ApiUnprocessableEntityResponse({
    description:
      "`invalid-content`: a file needed for the answer is broken; the error's `meta.path` names it. `unknown-variant`: `filter[variant]` names an attribute or value the configuration does not hold. `chunk-set-too-large`: the chunks of the commit, as you see them, are too large to cut together; `meta` names the budget (`nodes`, `chars`, `tableCells`) and the modules that expanded the most (`largest`).",
    standardSchema: ErrorDocument,
  })
  async list(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @PageParams() page: PageRequest,
    @Query('filter[module]', { schema: params.moduleId.optional() })
    moduleId?: string,
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
    @Query('filter[manual]', { schema: params.manualId.optional() })
    manual?: string,
    @Query('filter[variant]', { schema: VariantQuery.optional() })
    variant?: string,
    @Query('filter[changedSince]', { schema: CommitId.optional() })
    changedSince?: string,
  ): Promise<z.infer<typeof ChunkPageDocument>> {
    const result = await this.listChunks.handle({
      actor,
      snapshot,
      filter: {
        module: moduleId,
        lang,
        type,
        audience,
        facets,
        keywords,
        manual,
        variant:
          variant === undefined
            ? undefined
            : (parseVariantSlug(variant) as VariantValues),
        changedSince,
      },
      page,
    });
    const statuses = await this.getStatuses.handle({
      actor,
      snapshot,
      modules: result.items.map((chunk) => ({
        id: chunk.moduleId,
        lang: chunk.lang,
      })),
    });
    const read = {
      ref:
        typeof req.query['ref'] === 'string'
          ? req.query['ref']
          : this.defaultRef,
      commit: snapshot.commit,
    };
    const document = toPagedDocument(req, page, result, (chunk) =>
      toChunkResource(
        chunk,
        read,
        statuses.get(`${chunk.lang}/${chunk.moduleId}`),
      ),
    );
    return result.leftOut
      ? {
          ...document,
          meta: {
            ...document.meta,
            leftOut: result.leftOut.map((m) => ({ ...m })),
          },
        }
      : document;
  }
}
