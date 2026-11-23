import { Controller, Get, Req } from '@nestjs/common';
import { DeliveryApi } from '../../base/api/delivery.decorator.js';
import type { Request } from 'express';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import {
  JsonApi,
  PageParams,
  Paged,
} from '../../base/api/json-api.decorators.js';
import { toPagedDocument } from '../../base/api/json-api.js';
import type { PageRequest } from '../../base/core/paging.js';
import {
  CONTENT_HEADERS,
  CurrentSnapshot,
  ReadsContent,
} from '../../content/api/read-content.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import {
  ditaMappingIssues,
  iirdsMappingIssues,
  languageDirectionIssues,
} from '@openfolia/content-model';
import { GetConfigAction } from '../core/actions/get-config.action.js';
import { ListConfigUsagesAction } from '../core/actions/list-config-usages.action.js';
import { ListRefsAction } from '../core/actions/list-refs.action.js';
import {
  ConfigUsagePageDocument,
  ProjectConfigDocument,
  RefPageDocument,
  toConfigUsageResource,
  toRefResource,
} from './project.resources.js';

@ApiTags('project')
@Controller()
@JsonApi()
export class ProjectController {
  constructor(
    private readonly listRefs: ListRefsAction,
    private readonly getConfig: GetConfigAction,
    private readonly listUsages: ListConfigUsagesAction,
  ) {}

  @Get('refs')
  @DeliveryApi()
  @Paged()
  @ApiOperation({
    summary: 'Branches and tags',
    description:
      'Branches, then tags, each with the commit it points to. Without `content.read.draft`, only `main` and the tags.',
  })
  @ApiPermission('content.read')
  @ApiOkResponse({ standardSchema: RefPageDocument })
  async refs(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @PageParams() page: PageRequest,
  ): Promise<z.infer<typeof RefPageDocument>> {
    const result = await this.listRefs.handle({ actor, page });
    return toPagedDocument(req, page, result, toRefResource);
  }

  @Get('config')
  @DeliveryApi()
  @ReadsContent()
  @ApiOperation({
    summary: 'Project configuration',
    description:
      'Languages, audiences, module types, variant attributes and safety symbols (`openfolia.yaml`). With an iiRDS mapping (`iirds`), `meta.iirdsIssues` checks it against the rest: what it leaves unmapped, keys naming nothing; with a DITA mapping (`dita`), `meta.ditaIssues` lists its values naming nothing configured; `meta.directionIssues` lists each `languages.direction` entry for a language not configured.',
  })
  @ApiPermission('content.read')
  @ApiOkResponse({
    standardSchema: ProjectConfigDocument,
    headers: CONTENT_HEADERS,
  })
  async config(
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
  ): Promise<z.infer<typeof ProjectConfigDocument>> {
    const config = await this.getConfig.handle({ actor, snapshot });
    const directionIssues = languageDirectionIssues(config);
    return {
      data: {
        type: 'ProjectConfig',
        id: 'project',
        attributes: config,
        ...((config.iirds || config.dita || directionIssues.length > 0) && {
          meta: {
            ...(config.iirds && { iirdsIssues: iirdsMappingIssues(config) }),
            ...(config.dita && {
              ditaIssues: ditaMappingIssues(config.dita, config),
            }),
            ...(directionIssues.length > 0 && { directionIssues }),
          },
        }),
      },
    };
  }

  @Get('config/usages')
  @ReadsContent()
  @Paged()
  @ApiOperation({
    summary: 'How much content uses each configured value',
    description:
      'One `ConfigUsage` per value the configuration at `?ref=` defines (languages, module types, audiences, facets and their values, variant attributes and their values, text attributes, safety symbols), in the configuration’s order, with the modules (by ID) and manuals that name it in `meta`. Counted on what the reader may see; unreadable files are left out. For the project settings (“used by 3 modules”); the usage check that refuses removing a value in use reads past the reader’s scope (`config-in-use`, see the configuration’s working copy).',
  })
  @ApiPermission('content.read')
  @ApiOkResponse({
    standardSchema: ConfigUsagePageDocument,
    headers: CONTENT_HEADERS,
  })
  async usages(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @PageParams() page: PageRequest,
  ): Promise<z.infer<typeof ConfigUsagePageDocument>> {
    const result = await this.listUsages.handle({ actor, snapshot, page });
    return toPagedDocument(req, page, result, toConfigUsageResource);
  }
}
