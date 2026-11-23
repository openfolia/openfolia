import { Controller, Get, Query, Req } from '@nestjs/common';
import {
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { params } from '../../base/api/schemas.js';
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
import { ErrorDocument, toPagedDocument } from '../../base/api/json-api.js';
import type { PageRequest } from '../../base/core/paging.js';
import {
  BeyondTheCommit,
  CONTENT_HEADERS,
  CurrentSnapshot,
  ReadsContent,
} from '../../content/api/read-content.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import { MAX_QUERY_LENGTH } from '../../search/core/content-search.js';
import { ListAssetsAction } from '../core/actions/list-assets.action.js';
import { AssetPageDocument, toAssetResource } from './asset.resources.js';

const NAME = '[a-z0-9][a-z0-9!#$&^_.+-]{0,62}';

/** `image` or `image/png`: a media type's top-level type, or the whole of it, lowercase. */
const MediaTypeFilter = z
  .string()
  .regex(
    new RegExp(`^${NAME}(/${NAME})?$`),
    'A lowercase top-level type (`image`) or media type (`image/png`).',
  );

/** What to find, as for `GET /search`. */
const AssetQuery = z
  .string()
  .trim()
  .min(1, 'Give at least one character to search for.')
  .max(MAX_QUERY_LENGTH, `At most ${MAX_QUERY_LENGTH} characters.`);

/** `true` or `false`. */
export const UnusedFilter = z
  .enum(['true', 'false'], { error: '`true` or `false`.' })
  .transform((value) => value === 'true');

/** Checked for its form only; one that names no change set of the reader's is 404. */
const ChangeSetFilter = z.string().min(1).max(64);

/** The images in the repository, for the insert-image dialog (#72). */
@ApiTags('assets')
@Controller('assets')
@JsonApi()
@ReadsContent()
export class AssetListController {
  constructor(private readonly listAssets: ListAssetsAction) {}

  @Get()
  @Paged()
  @BeyondTheCommit()
  @AcceptsQuery('filter[q]')
  @ApiQuery({
    name: 'filter[q]',
    required: false,
    description: `Only files this text is found in, 1 to ${MAX_QUERY_LENGTH} characters after trimming (empty: 400): the alt text or title of an image block showing it, the name, description or file name of an attachment block attaching it, or the title or ID of a module showing it, as one piece of text (case and diacritics do not matter); or the file name of its upload into the change set of \`filter[changeSet]\`; a whole SHA-256 also finds the file of that hash. Only modules the reader may see are searched, so a file is never found through one outside their scope.`,
    schema: { type: 'string', minLength: 1, maxLength: MAX_QUERY_LENGTH },
  })
  @Filters(
    {
      name: 'type',
      description:
        'Only files of this type: a top-level type (`image`: every image), a media type (`image/png`: only PNGs), or `attachment`: the files an attachment block the reader may see attaches, and uploads into the change set of `filter[changeSet]` of a type no image or font upload has (decided by the blocks and uploads, so it also lists a missing file); `font` (or `font/ttf`, …): the fonts the page designs at `?ref=` name and those uploaded into the change set of `filter[changeSet]`, each with `attributes.font` (its family, style, copyright and licence). Lowercase. A missing file (`meta.missing`) has no type, so a media type filter never matches it.',
    },
    {
      name: 'lang',
      description:
        'Only files a module in this language (that the reader may see) uses: an image block shows it or an attachment block attaches it there. `meta.languages` names every language using a file.',
    },
    {
      name: 'unused',
      description:
        '`true`: instead, the files nobody uses, to tidy up: uploads into any change set and files in the blob store that no module file refers to at `main`, any other branch that is not a change set’s, any tag, the head of any open change set or any working copy, last uploaded or stored more than 24 hours ago (renditions aside), last uploaded first. Each can be deleted (`DELETE /assets/{hash}`). `filter[q]` then matches the upload’s file name, `filter[type]` works as otherwise, `filter[changeSet]` keeps that change set’s uploads, `filter[lang]` finds nothing (an unused file has no language). Needs `content.read.draft` and `content.edit`, each in a role whose scope restricts nothing (403 otherwise). `false`: as if left out.',
    },
    {
      name: 'changeSet',
      description:
        'A change set of the reader’s own (its ID): its uploaded images are listed too, first, also before a module refers to them. Read at its branch with `?ref=change-sets/<id>` to see what its modules show. Only its author: 403 for another reader of drafts, 404 `not-found` for anyone else and for an ID that names no change set (as for an unknown ref).',
    },
  )
  @ApiOperation({
    summary: 'List images and attachments',
    description:
      'The files a module the reader may see shows as an image or attaches at `?ref=`, each with its type, size, dimensions (images) and file name (attachments) and, in `meta.usedIn`, the modules the reader may see that use it (`meta.usedAs`: how). `filter[q]` finds files by their alt text, title, attachment name, description and file name and the modules using them. Ordered by the ID of the first such module; with `filter[changeSet]`, the files uploaded into that change set come first (last uploaded first). Content outside the reader’s scope is never listed nor counted: an image only such modules show is not there, and `meta.page.total` counts only what is listed. The ETag is a hash of the answer (uploads and the blob store change it too), so it is never `immutable`.',
  })
  @ApiPermission('content.read')
  @ApiForbiddenResponse({
    description:
      '`forbidden`: `filter[changeSet]` names another author’s change set (to a reader of drafts); `filter[unused]=true` without `content.read.draft` and `content.edit`, each in a role whose scope restricts nothing.',
    standardSchema: ErrorDocument,
  })
  @ApiOkResponse({
    standardSchema: AssetPageDocument,
    headers: CONTENT_HEADERS,
  })
  async list(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @PageParams() page: PageRequest,
    @Query('filter[q]', { schema: AssetQuery.optional() })
    query: z.infer<typeof AssetQuery> | undefined,
    @Query('filter[type]', { schema: MediaTypeFilter.optional() })
    type?: z.infer<typeof MediaTypeFilter>,
    @Query('filter[changeSet]', { schema: ChangeSetFilter.optional() })
    changeSetId?: z.infer<typeof ChangeSetFilter>,
    @Query('filter[lang]', { schema: params.lang.optional() })
    lang?: string,
    @Query('filter[unused]', { schema: UnusedFilter.optional() })
    unused?: boolean,
  ): Promise<z.infer<typeof AssetPageDocument>> {
    const result = await this.listAssets.handle({
      actor,
      snapshot,
      type,
      query,
      changeSetId,
      lang,
      unused,
      page,
    });
    return toPagedDocument(req, page, result, toAssetResource);
  }
}
