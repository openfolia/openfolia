import { Controller, Get, Req } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
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
  GetStorageUsageAction,
  READ_STORAGE_USAGE,
} from '../core/actions/get-storage-usage.action.js';
import { ListStoredFilesAction } from '../core/actions/list-stored-files.action.js';
import {
  StoredFilePageDocument,
  StorageUsageDocument,
  toStorageUsageDocument,
  toStoredFileResource,
} from './storage-usage.resources.js';

/** `GET /storage-usage` and `GET /storage-usage/files` (#404), for administrators. */
@ApiTags('storage')
@Controller('storage-usage')
@JsonApi()
export class StorageUsageController {
  constructor(
    private readonly getUsage: GetStorageUsageAction,
    private readonly listFiles: ListStoredFilesAction,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Storage used',
    description: `The storage this installation uses, per category: media (uploaded images and attachments) and archived PDFs (release outputs), which count towards the limit (\`CCMS_STORAGE_LIMIT_BYTES\`, none by default), and the Git content and the database for information. The totals move with every upload and delete and are counted afresh periodically (\`recountedAt\`); no store is counted on request. Needs the \`${READ_STORAGE_USAGE}\` permission.`,
  })
  @ApiOkResponse({ standardSchema: StorageUsageDocument })
  @ApiPermission(READ_STORAGE_USAGE)
  async get(
    @CurrentActor() actor: Actor,
  ): Promise<z.infer<typeof StorageUsageDocument>> {
    return toStorageUsageDocument(await this.getUsage.handle({ actor }));
  }

  @Get('files')
  @Paged()
  @ApiOperation({
    summary: 'Largest uploaded files',
    description: `The files uploaded into change sets, largest first, each once (by its hash), whichever change set holds it. Needs the \`${READ_STORAGE_USAGE}\` permission.`,
  })
  @ApiOkResponse({ standardSchema: StoredFilePageDocument })
  @ApiPermission(READ_STORAGE_USAGE)
  async files(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @PageParams() page: PageRequest,
  ): Promise<z.infer<typeof StoredFilePageDocument>> {
    const result = await this.listFiles.handle({ actor, page });
    return toPagedDocument(req, page, result, toStoredFileResource);
  }
}
