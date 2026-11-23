import { z } from 'zod';
import { Paged, parseAnswer, segments } from '../api-client.js';
import { RefArgument } from '../released.js';
import {
  apiUrl,
  ConfigKey,
  defineTool,
  Facets,
  Keywords,
  Lang,
  nextPage,
  PageCursor,
  pageOf,
} from './tool.js';

/** Results per page. */
export const SEARCH_PAGE_SIZE = 20;

const SearchPage = Paged.extend({
  data: z.array(
    z.looseObject({
      attributes: z.looseObject({
        resourceType: z.enum(['Module', 'Manual', 'Term']),
        resourceId: z.string(),
        lang: z.string().optional(),
        title: z.string(),
        blockId: z.string().optional(),
      }),
      meta: z.looseObject({
        matchedOn: z.string(),
        excerpt: z.string(),
      }),
    }),
  ),
});

export const searchTool = defineTool({
  name: 'search',
  title: 'Search the released documentation',
  description:
    'Searches the released documentation (`GET /search`): modules by title, keywords and text, manuals by title, terms by their variants and definition. Every word of `query` has to match, in any of its forms (`starting` finds `starts`) and with typos in titles and keywords; case and diacritics do not matter; where the server has semantic search, a result may match by meaning alone. Returns up to 20 results per call, each with `resourceType` (`Module`, `Manual` or `Term`), its `id` (a module’s ID, a manual’s or a term’s), `lang`, `title`, a plain-text `excerpt` around the match, `matchedOn` (`title`, `keyword`, `question` for an FAQ entry’s question, with its `blockId`, `text`, or `meaning` for a match by meaning alone, its excerpt the closest block) and the API `url`; `total` counts the matches, `nextCursor` gives the next page (null after the last). Read a module found with `read_module`, a manual with `read_manual`. Only what this server’s service account may read is found or counted.',
  inputSchema: {
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe('What to search for, 1 to 200 characters.'),
    lang: Lang.optional().describe('Only modules and terms in this language.'),
    resourceType: z
      .enum(['Module', 'Manual', 'Term'])
      .optional()
      .describe('Only results of this kind.'),
    moduleType: ConfigKey.optional().describe(
      'Only modules of this configured module type (leaves manuals and terms out).',
    ),
    audience: ConfigKey.optional().describe(
      'Only modules that count as this audience level: their own, or the last, most restricted level for a module naming none (leaves manuals and terms out).',
    ),
    facets: Facets.optional(),
    keywords: Keywords.optional(),
    ref: RefArgument.optional(),
    cursor: PageCursor.optional(),
  },
  async run({ api, refs, signal }, args) {
    const ref = await refs.resolve(args.ref, signal);
    const { body, commit } = await api.get('/search', {
      ref,
      'filter[q]': args.query,
      'filter[lang]': args.lang,
      // `filter[type]=module|manual` alone is the API's old resource-type
      // filter: with a module type of that name, the resource type is set too.
      'filter[resourceType]':
        args.resourceType ??
        (args.moduleType === 'module' || args.moduleType === 'manual'
          ? 'Module'
          : undefined),
      'filter[type]': args.moduleType,
      'filter[audience]': args.audience,
      'filter[facet]': args.facets,
      'filter[keyword]': args.keywords,
      'page[number]': String(pageOf(args.cursor)),
      'page[size]': String(SEARCH_PAGE_SIZE),
    });
    const page = parseAnswer(SearchPage, body);
    return {
      structured: {
        ref,
        commit: commit ?? null,
        total: page.meta.page.total,
        nextCursor: nextPage(page.meta.page),
        results: page.data.map(({ attributes: a, meta }) => {
          const { id, path } = locate(a.resourceType, a.resourceId);
          return {
            resourceType: a.resourceType,
            id,
            ...(a.lang !== undefined && { lang: a.lang }),
            title: a.title,
            excerpt: meta.excerpt,
            matchedOn: meta.matchedOn,
            ...(a.blockId !== undefined && { blockId: a.blockId }),
            url: apiUrl(api, path, ref),
          };
        }),
      },
    };
  },
});

/** A result's own ID and its API path: a module's `resourceId` is `<lang>/<id>`. */
function locate(
  type: 'Module' | 'Manual' | 'Term',
  resourceId: string,
): { id: string; path: string } {
  if (type === 'Module') {
    const [lang = '', id = ''] = resourceId.split('/');
    return { id, path: segments('modules', lang, id) };
  }
  return {
    id: resourceId,
    path: segments(type === 'Manual' ? 'manuals' : 'terms', resourceId),
  };
}
