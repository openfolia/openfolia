import { z } from 'zod';
import { Paged, parseAnswer, segments } from '../api-client.js';
import {
  ConfigKey,
  defineTool,
  Lang,
  nextPage,
  PageCursor,
  pageOf,
} from './tool.js';

/** Items per page of `list_downloads` and `list_download_versions`. */
export const DOWNLOADS_PAGE_SIZE = 50;

/** The release a download's file comes from (#139). */
const DownloadRelease = z.looseObject({
  tag: z.string(),
  revision: z.string(),
  publishedAt: z.string(),
});

const releaseOf = (r: z.infer<typeof DownloadRelease>) => ({
  tag: r.tag,
  revision: r.revision,
  publishedAt: r.publishedAt,
});

const DownloadsPage = Paged.extend({
  data: z.array(
    z.looseObject({
      id: z.string(),
      attributes: z.looseObject({
        kind: z.string(),
        product: z.string(),
        lang: z.string(),
        name: z.string(),
        description: z.string().nullable(),
        fileName: z.string(),
        mediaType: z.string(),
        size: z.number(),
        sha256: z.string(),
        moduleId: z.string().nullable(),
        manualId: z.string().nullable(),
        variant: z.string().nullable(),
        release: DownloadRelease,
      }),
    }),
  ),
});

export const listDownloadsTool = defineTool({
  name: 'list_downloads',
  title: 'List the downloads',
  description:
    'The download centre (`GET /downloads`): every downloadable file of each product at its latest release, up to 50 per call. Each has its `id` (for `list_download_versions`), `kind` (`attachment`: a file attached in a module; `manual`: a manual’s PDF), `product`, `lang`, `name`, `description`, `fileName`, `mediaType`, `size`, `sha256` (its checksum), the module or the manual and variant it belongs to, and the `release` (`tag`, `revision`, `publishedAt`) that holds it. Only what the server’s account may read; the files themselves are not given here. `nextCursor` gives the next page (null after the last).',
  inputSchema: {
    product: ConfigKey.optional().describe(
      'Only files of this product (a value of the product facet).',
    ),
    lang: Lang.optional().describe('Only files in this language.'),
    kind: z
      .enum(['attachment', 'manual'])
      .optional()
      .describe('Only attachments, or only manuals’ PDFs.'),
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'Words each found in the name, description, file name or module title.',
      ),
    cursor: PageCursor.optional(),
  },
  async run({ api, signal }, args) {
    const { body } = await api.get(
      '/downloads',
      {
        'filter[product]': args.product,
        'filter[lang]': args.lang,
        'filter[kind]': args.kind,
        'filter[q]': args.query,
        'page[number]': String(pageOf(args.cursor)),
        'page[size]': String(DOWNLOADS_PAGE_SIZE),
      },
      signal,
    );
    const page = parseAnswer(DownloadsPage, body);
    return {
      structured: {
        total: page.meta.page.total,
        nextCursor: nextPage(page.meta.page),
        downloads: page.data.map(({ id, attributes: a }) => ({
          id,
          kind: a.kind,
          product: a.product,
          lang: a.lang,
          name: a.name,
          description: a.description,
          fileName: a.fileName,
          mediaType: a.mediaType,
          size: a.size,
          sha256: a.sha256,
          moduleId: a.moduleId,
          manualId: a.manualId,
          variant: a.variant,
          release: releaseOf(a.release),
        })),
      },
    };
  },
});

const VersionsPage = Paged.extend({
  data: z.array(
    z.looseObject({
      attributes: z.looseObject({
        state: z.string(),
        sha256: z.string(),
        size: z.number(),
        fileName: z.string(),
        release: DownloadRelease,
        changeNote: z.looseObject({
          notes: z.string().nullable(),
          description: z.string().nullable(),
        }),
      }),
    }),
  ),
});

/** A download's ID as `list_downloads` gives it, checked for its form only (the API judges it). */
const DownloadId = z
  .string()
  .max(1_400)
  .regex(/^(?:attachment|manual):[^/]+$/, 'a download ID `list_downloads` gave')
  .describe('The download’s `id`, as `list_downloads` gives it.');

export const listDownloadVersionsTool = defineTool({
  name: 'list_download_versions',
  title: 'List a download’s versions',
  description:
    'One download’s versions across its product’s releases (`GET /downloads/{id}/versions`), newest first, up to 50 per call: a version where the file’s checksum changed, each with its `state` (`current`, `superseded` or `withdrawn`), `sha256`, `size`, `fileName`, the `release` it first appeared in (`tag`, `revision`, `publishedAt`) and its change note (`notes`: that release’s notes; `description`: the attachment’s). `nextCursor` gives the next page (null after the last).',
  inputSchema: {
    id: DownloadId,
    cursor: PageCursor.optional(),
  },
  async run({ api, signal }, args) {
    const { body } = await api.get(
      segments('downloads', args.id, 'versions'),
      {
        'page[number]': String(pageOf(args.cursor)),
        'page[size]': String(DOWNLOADS_PAGE_SIZE),
      },
      signal,
    );
    const page = parseAnswer(VersionsPage, body);
    return {
      structured: {
        id: args.id,
        total: page.meta.page.total,
        nextCursor: nextPage(page.meta.page),
        versions: page.data.map(({ attributes: a }) => ({
          state: a.state,
          sha256: a.sha256,
          size: a.size,
          fileName: a.fileName,
          release: releaseOf(a.release),
          notes: a.changeNote.notes,
          description: a.changeNote.description,
        })),
      },
    };
  },
});
