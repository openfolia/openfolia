import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { DesignTemplateId } from '@openfolia/content-model';
import type { Request } from 'express';
import { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import {
  AcceptsQuery,
  JsonApi,
  PageParams,
  Paged,
} from '../../base/api/json-api.decorators.js';
import {
  ErrorDocument,
  PageLinks,
  PageMeta,
  pagedDocument,
  resourceObject,
  singleDocument,
  toPagedDocument,
} from '../../base/api/json-api.js';
import { ReadsWorkingCopies } from '../../change-sets/api/working-copy-reads.js';
import type { PageRequest } from '../../base/core/paging.js';
import {
  CONTENT_HEADERS,
  CurrentSnapshot,
  ReadsContent,
} from '../../content/api/read-content.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import {
  ListPageDesignTemplatesAction,
  type PageDesignTemplateEntry,
} from '../core/actions/list-page-design-templates.action.js';
import {
  GetDesignTemplateFileAction,
  GetExampleDesignTemplateAction,
  ListDesignTemplateFilesAction,
  type TemplateFileListed,
  type TemplateFileRead,
} from '../core/actions/design-template-files.actions.js';

export const PageDesignTemplateResource = resourceObject('PageDesignTemplate', {
  attributes: z.object({
    path: z
      .string()
      .describe(
        'Its entry file in the content repository, `templates/<id>/manual.typ`.',
      ),
  }),
})
  .describe(
    '`id` is the template’s folder name, what a page design names as its `template`.',
  )
  .meta({ id: 'PageDesignTemplateResource' });

export const PageDesignTemplatePageDocument = pagedDocument(
  PageDesignTemplateResource,
).meta({ id: 'PageDesignTemplatePageDocument' });

export const PageDesignTemplateFileResource = resourceObject(
  'PageDesignTemplateFile',
  {
    attributes: z.object({
      path: z
        .string()
        .describe(
          'Its path in the template’s folder (`manual.typ`, `parts/notice.typ`); in the content repository `templates/<templateId>/<path>`.',
        ),
      size: z.int().min(0).describe('Its size in bytes.'),
      text: z
        .boolean()
        .describe(
          'Whether it is a text file the template screen edits (`.typ`, `.yaml`, `.yml`, `.json`, `.toml`, `.csv`, `.txt`, `.xml`, `.svg`, `.bib`); an image or font is only listed.',
        ),
    }),
    meta: z.object({
      draft: z
        .boolean()
        .describe(
          'Read with `workingCopy=true`: whether the change set’s working copy stands in for it (a file only a working copy holds is listed too). Otherwise false.',
        ),
      committed: z
        .boolean()
        .describe(
          'Whether the commit read has the file; false for one only a working copy holds (deleting it drops the working copy).',
        ),
    }),
  },
)
  .describe('`id` is the file’s path in the template’s folder.')
  .meta({ id: 'PageDesignTemplateFileResource' });

export const PageDesignTemplateFilePageDocument = z
  .object({
    data: z.array(PageDesignTemplateFileResource),
    meta: z.object({
      page: PageMeta,
      folder: z
        .object({
          files: z.int().min(0).describe('The files the folder holds.'),
          bytes: z.int().min(0).describe('Their size together, in bytes.'),
          maxFiles: z
            .int()
            .describe(
              'The most files a template’s folder may hold (`MAX_TEMPLATE_FILES`).',
            ),
          maxBytes: z
            .int()
            .describe(
              'The most bytes a template’s files may hold together (`MAX_TEMPLATE_BYTES`).',
            ),
          pastCaps: z
            .boolean()
            .describe(
              'Whether the folder is past either cap: then it is not compiled (its preview and PDFs are 422 `template-error`), and a save that adds to it is 422 `template-too-large`.',
            ),
        })
        .describe(
          'The whole folder against its caps (#803), every page’s files counted; read with `workingCopy=true`, each draft at its length in place of its file, and every draft listed, also past the caps.',
        ),
    }),
    links: PageLinks,
  })
  .meta({ id: 'PageDesignTemplateFilePageDocument' });

export const PageDesignTemplateFileTextResource = resourceObject(
  'PageDesignTemplateFileText',
  {
    attributes: z.object({
      path: z.string().describe('Its path in the template’s folder.'),
      text: z.string().describe('The file’s text (UTF-8).'),
    }),
  },
)
  .describe('`id` is the file’s path in the template’s folder.')
  .meta({ id: 'PageDesignTemplateFileTextResource' });

export const PageDesignTemplateFileTextDocument = singleDocument(
  PageDesignTemplateFileTextResource,
).meta({ id: 'PageDesignTemplateFileTextDocument' });

export const PageDesignTemplateFileTextPageDocument = pagedDocument(
  PageDesignTemplateFileTextResource,
).meta({ id: 'PageDesignTemplateFileTextPageDocument' });

const toFileResource = (
  file: TemplateFileListed,
): z.infer<typeof PageDesignTemplateFileResource> => ({
  type: 'PageDesignTemplateFile',
  id: file.path,
  attributes: { path: file.path, size: file.size, text: file.text },
  meta: { draft: file.draft, committed: file.committed },
});

const toTextResource = (
  file: TemplateFileRead,
): z.infer<typeof PageDesignTemplateFileTextResource> => ({
  type: 'PageDesignTemplateFileText',
  id: file.path,
  attributes: { path: file.path, text: file.text },
});

const TEMPLATE_ID = {
  name: 'templateId',
  example: 'house',
  description: 'The template’s folder name (`templates/<templateId>/`).',
} as const;

/** Checked by the action: a path that is no template text file's is 404. */
const FilePathQuery = z.string().max(1000);

const toResource = (
  entry: PageDesignTemplateEntry,
): z.infer<typeof PageDesignTemplateResource> => ({
  type: 'PageDesignTemplate',
  id: entry.id,
  attributes: { path: entry.path },
});

/**
 * An organisation's own page design templates (#396): folders of the content repository
 * (`templates/<id>/manual.typ`) a page design names as its `template`, read at `?ref=`.
 */
@ApiTags('page-designs')
@Controller('page-design-templates')
@JsonApi()
@ReadsContent()
export class PageDesignTemplatesController {
  constructor(
    private readonly listTemplates: ListPageDesignTemplatesAction,
    private readonly listFiles: ListDesignTemplateFilesAction,
    private readonly getFile: GetDesignTemplateFileAction,
  ) {}

  @Get()
  @Paged()
  @ReadsWorkingCopies()
  @ApiOperation({
    summary: 'List page design templates',
    description:
      'The own Typst templates at `?ref=` a page design can name as its `template` (#396): every folder `templates/<id>/` with a `manual.typ`, by ID; with `workingCopy=true` (the change set’s author) also one whose `manual.typ` only a working copy holds. Only the listing is read. Templates carry no audience: every reader of the ref learns of them. Their contract and the example template: the user guide, "Own templates".',
  })
  @ApiPermission('content.read')
  @ApiOkResponse({
    standardSchema: PageDesignTemplatePageDocument,
    headers: CONTENT_HEADERS,
  })
  async list(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @PageParams() page: PageRequest,
  ): Promise<z.infer<typeof PageDesignTemplatePageDocument>> {
    const result = await this.listTemplates.handle({ actor, snapshot, page });
    return toPagedDocument(req, page, result, toResource);
  }

  @Get(':templateId/files')
  @Paged()
  @ReadsWorkingCopies()
  @ApiOperation({
    summary: 'List a page design template’s files',
    description:
      'The regular files of the template’s folder (`templates/<templateId>/`) at `?ref=`, by path (#396): its size, and whether the template screen edits it as text. With `workingCopy=true` (the change set’s author), files its working copies hold stand in for theirs (`meta.draft`), and files only a working copy holds are listed too. Only the listing is read. Templates carry no audience: every reader of the ref reads them.',
  })
  @ApiParam(TEMPLATE_ID)
  @ApiPermission('content.read')
  @ApiOkResponse({
    standardSchema: PageDesignTemplateFilePageDocument,
    headers: CONTENT_HEADERS,
  })
  @ApiNotFoundResponse({
    description:
      '`not-found`: the folder holds no file (nor a working copy of one).',
    standardSchema: ErrorDocument,
  })
  async files(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @Param('templateId', { schema: DesignTemplateId }) templateId: string,
    @PageParams() page: PageRequest,
  ): Promise<z.infer<typeof PageDesignTemplateFilePageDocument>> {
    const result = await this.listFiles.handle({
      actor,
      snapshot,
      templateId,
      page,
    });
    const paged = toPagedDocument(req, page, result, toFileResource);
    return { ...paged, meta: { ...paged.meta, folder: result.folder } };
  }

  @Get(':templateId/file')
  @AcceptsQuery('path')
  @ReadsWorkingCopies()
  @ApiOperation({
    summary: 'Read a page design template’s text file',
    description:
      'One text file of the template’s folder at `?ref=` by its path in it (#396), as committed; with `workingCopy=true` (the change set’s author) the working copy’s text in its place. To change it, save a working copy in a change set (`PUT /change-sets/{changeSetId}/page-design-templates/{templateId}/files/working-copy?path=`). Every reader of the ref reads it.',
  })
  @ApiParam(TEMPLATE_ID)
  @ApiQuery({
    name: 'path',
    required: true,
    example: 'manual.typ',
    description:
      'The file’s path in the template’s folder. One that is no template text file’s (a name starting with `.`, a path leaving the folder, an image) is 404.',
    schema: { type: 'string' },
  })
  @ApiPermission('content.read')
  @ApiOkResponse({
    standardSchema: PageDesignTemplateFileTextDocument,
    headers: CONTENT_HEADERS,
  })
  @ApiNotFoundResponse({
    description:
      '`not-found`: no such text file in the template (or none that is UTF-8 text).',
    standardSchema: ErrorDocument,
  })
  async file(
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @Param('templateId', { schema: DesignTemplateId }) templateId: string,
    @Query('path', { schema: FilePathQuery }) path: string,
  ): Promise<z.infer<typeof PageDesignTemplateFileTextDocument>> {
    const file = await this.getFile.handle({
      actor,
      snapshot,
      templateId,
      path,
    });
    return { data: toTextResource(file) };
  }
}

/**
 * The example page design template (#396): the files a new own template starts from, laid out
 * as the built-in layout.
 */
@ApiTags('page-designs')
@Controller('page-design-template-example')
@JsonApi()
export class PageDesignTemplateExampleController {
  constructor(private readonly example: GetExampleDesignTemplateAction) {}

  @Get('files')
  @Paged()
  @ApiOperation({
    summary: 'List the example page design template’s files',
    description:
      'The renderer’s example template (#396), each file with its text, by path: the files a new own template starts from (`templates/<id>/`, saved as working copies), which lay a manual out as the classic layout does. Nothing of the content repository is read. Empty when the server’s renderer has no own templates.',
  })
  @ApiPermission('content.read')
  @ApiOkResponse({ standardSchema: PageDesignTemplateFileTextPageDocument })
  async files(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @PageParams() page: PageRequest,
  ): Promise<z.infer<typeof PageDesignTemplateFileTextPageDocument>> {
    const result = await this.example.handle({ actor, page });
    return toPagedDocument(req, page, result, toTextResource);
  }
}
