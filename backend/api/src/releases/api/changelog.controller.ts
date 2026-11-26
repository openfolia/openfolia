import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { z } from 'zod';
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
import { NamesPeople } from '../../base/api/people.js';
import { toPagedDocument } from '../../base/api/json-api.js';
import type { PageRequest } from '../../base/core/paging.js';
import {
  CHANGELOG_SCANNED,
  ListChangelogAction,
} from '../core/actions/release-changes.action.js';
import {
  ChangelogPageDocument,
  releaseFilters,
  toChangelogEntryResource,
} from './release.resources.js';

@ApiTags('releases')
@Controller('changelog')
@JsonApi()
@NamesPeople()
export class ChangelogController {
  constructor(private readonly listChangelog: ListChangelogAction) {}

  @Get()
  @Paged()
  @Filters(
    {
      name: 'product',
      description:
        'Only releases of this product (a value of the product facet).',
    },
    {
      name: 'manual',
      description:
        'Only releases that changed this manual (by ID), as you see it.',
    },
    {
      name: 'lang',
      description:
        'Only releases that changed a manual in this language (a language tag), as you see it.',
    },
    {
      name: 'major',
      description:
        '`true`: only major releases; `false`: only the others. Left out: all.',
    },
  )
  @ApiOperation({
    summary: 'Read the changelog',
    description: `Releases, newest first, withdrawn ones too (marked, with the reason, in \`attributes.withdrawal\`), each with its notes and, in \`meta.changedManuals\`, how many manuals it changed as you see them (its changes: \`GET /releases/{releaseId}/changes\`). Filtered by manual or language, it lists the releases that changed it as you see them, filtered before paging, so neither the list nor the total tells of a manual outside your scope; that is worked out from Git, so only the ${CHANGELOG_SCANNED} newest releases matching the other filters are looked through then (\`meta.truncated\` when there were more). Needs the \`content.read\` permission.`,
  })
  @DeliveryApi()
  @ApiPermission('content.read')
  @ApiOkResponse({ standardSchema: ChangelogPageDocument })
  async list(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @PageParams() page: PageRequest,
    @Query('filter[product]', { schema: releaseFilters.product.optional() })
    product?: string,
    @Query('filter[manual]', { schema: releaseFilters.manual.optional() })
    manual?: string,
    @Query('filter[lang]', { schema: releaseFilters.lang.optional() })
    lang?: string,
    @Query('filter[major]', { schema: releaseFilters.major.optional() })
    major?: boolean,
  ): Promise<z.infer<typeof ChangelogPageDocument>> {
    const result = await this.listChangelog.handle({
      actor,
      page,
      filter: {
        ...(product !== undefined && { product }),
        ...(manual !== undefined && { manual }),
        ...(lang !== undefined && { lang }),
        ...(major !== undefined && { major }),
      },
    });
    const document = toPagedDocument(
      req,
      page,
      result,
      toChangelogEntryResource,
    );
    return {
      ...document,
      meta: { ...document.meta, truncated: result.truncated },
    };
  }
}
