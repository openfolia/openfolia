import { z } from 'zod';
import {
  Paged,
  parseAnswer,
  segments,
  ToolError,
  type ContentApi,
  type Query,
} from '../api-client.js';
import { RefArgument } from '../released.js';
import {
  apiUrl,
  ConfigKey,
  defineTool,
  Facets,
  Id,
  Keywords,
  Lang,
  nextPage,
  PageCursor,
  pageOf,
  sliceText,
  TextCursor,
  VariantSlug,
} from './tool.js';

/** Chunks per `get_chunks` page. */
export const CHUNKS_PAGE_SIZE = 10;
/** The most characters of one chunk's text `get_chunks` gives (`truncated` past it). */
export const CHUNK_TEXT_LIMIT = 20_000;
/** The most characters of a module's text one `read_module` call gives. */
export const MODULE_TEXT_LIMIT = 100_000;

export const Chunk = z.looseObject({
  id: z.string(),
  attributes: z.looseObject({
    moduleId: z.string(),
    lang: z.string(),
    title: z.string(),
    moduleType: z.string(),
    audience: z.string().optional(),
    facets: z.record(z.string(), z.array(z.string())),
    keywords: z.array(z.string()),
    manuals: z.array(z.string()),
    conditions: z.array(z.string()),
    text: z.string(),
    contentHash: z.string(),
    entry: z
      .looseObject({ blockId: z.string(), question: z.string() })
      .optional(),
  }),
  meta: z.looseObject({
    release: z
      .looseObject({ tag: z.string(), same: z.boolean() })
      .nullable()
      .optional(),
  }),
});
export type Chunk = z.infer<typeof Chunk>;

/** A module the API left out of the chunks (#688): too large to cut once its references are included. */
export const LeftOutModule = z.looseObject({
  moduleId: z.string(),
  lang: z.string(),
  reason: z.enum(['size', 'depth']),
});
export type LeftOutModule = z.infer<typeof LeftOutModule>;

export const ChunkPage = Paged.extend({
  data: z.array(Chunk),
  meta: Paged.shape.meta.extend({
    leftOut: z.array(LeftOutModule).optional(),
  }),
});

/** Why a module has no chunk, for an agent (#688). */
export function leftOutReason(module: LeftOutModule): string {
  return module.reason === 'depth'
    ? 'its blocks and the modules it refers to nest more than 100 levels deep'
    : 'once the modules it refers to are included it holds more than 500,000 content nodes, 12,000,000 characters or 1,000,000 table cells (rows × columns) (a module referred to over several paths counts once per path)';
}

/** What `get_chunks` and `read_manual` say of a module left out. */
export function leftOutOf(module: LeftOutModule) {
  return {
    moduleId: module.moduleId,
    lang: module.lang,
    reason: module.reason,
    detail: `The module "${module.moduleId}" (${module.lang}) has no chunk: it is too large to cut, as ${leftOutReason(module)}. Its writers can refer to fewer modules, over fewer paths, or nest them less deeply.`,
  };
}

/** `GET /chunks` with `query`. */
export function getChunks(api: ContentApi, query: Query, signal?: AbortSignal) {
  return api.get('/chunks', query, signal);
}

/** A chunk's metadata, as the tools give it (without its text). */
export function chunkMetadata(chunk: Chunk, api: ContentApi, ref: string) {
  const a = chunk.attributes;
  return {
    moduleId: a.moduleId,
    lang: a.lang,
    title: a.title,
    moduleType: a.moduleType,
    audience: a.audience ?? null,
    facets: a.facets,
    keywords: a.keywords,
    manuals: a.manuals,
    conditions: a.conditions,
    contentHash: a.contentHash,
    release: chunk.meta.release
      ? { tag: chunk.meta.release.tag, same: chunk.meta.release.same }
      : null,
    url: apiUrl(api, segments('modules', a.lang, a.moduleId), ref),
  };
}

export const readModuleTool = defineTool({
  name: 'read_module',
  title: 'Read a module',
  description:
    'One released module in one language as Markdown (its retrieval chunk, `GET /chunks`): the title as `#` heading, sections, numbered steps, tables, safety messages and notes as quotes headed by their signal word, referenced modules inlined. With `variant`, variant blocks are resolved for it; without, each is a quote headed by `**when**` and its condition. Text attributes stay `{name}`. Returns `text` (at most 100,000 characters per call; `nextCursor` continues, null at the end) and the module’s metadata: `moduleId`, `lang`, `title`, `moduleType`, `audience`, `facets`, `keywords`, `manuals` (those including it), `conditions`, `release` (its newest release tag) and the API `url`. A module this server’s service account may not read is `not-found`, exactly like one that does not exist. A module too large to cut once the modules it refers to are included is `expansion-too-large`, saying why; released content whose modules together are too large to cut (many each including a lot) is `chunk-set-too-large`, for every module of that release.',
  inputSchema: {
    id: Id.describe('The module ID, e.g. as `search` gives it.'),
    lang: Lang.describe('The language to read it in.'),
    variant: VariantSlug.optional(),
    ref: RefArgument.optional(),
    cursor: TextCursor.optional(),
  },
  async run({ api, refs, signal }, args) {
    const ref = await refs.resolve(args.ref, signal);
    const { body, commit } = await getChunks(api, {
      ref,
      'filter[module]': args.id,
      'filter[lang]': args.lang,
      'filter[variant]': args.variant,
      'page[size]': '1',
    });
    const page = parseAnswer(ChunkPage, body);
    const chunk = page.data[0];
    const leftOut = page.meta.leftOut?.[0];
    if (!chunk && leftOut) {
      throw new ToolError(
        'expansion-too-large',
        'The module is too large to cut into chunks',
        `${leftOutOf(leftOut).detail} Until then it cannot be read here; every other module can.`,
        422,
      );
    }
    if (!chunk) {
      throw new ToolError(
        'not-found',
        'No such module',
        'No module of that ID in that language at that ref.',
        404,
      );
    }
    const slice = sliceText(
      chunk.attributes.text,
      args.cursor,
      MODULE_TEXT_LIMIT,
    );
    return {
      text: slice.text,
      structured: {
        ...chunkMetadata(chunk, api, ref),
        ref,
        commit: commit ?? null,
        variant: args.variant ?? null,
        text: slice.text,
        length: slice.total,
        nextCursor: slice.nextCursor,
      },
    };
  },
});

export const getChunksTool = defineTool({
  name: 'get_chunks',
  title: 'List retrieval chunks',
  description:
    'Released modules as retrieval chunks (`GET /chunks`): one per module and language, ordered by module ID, then language, each followed by one per FAQ entry in it (`entry`: its `blockId` and `question`; its `text` the entry alone), each with its Markdown `text` (at most 20,000 characters each; `truncated` says when cut, `read_module` gives all of it), `contentHash` and the metadata to filter on (`moduleType`, `audience`, `facets`, `keywords`, `manuals`, `conditions`, `release`). Up to 10 per call; `total` counts the matches, `nextCursor` gives the next page (null after the last). Filters (every one given has to hold) run before paging. `changedSince` (a commit a previous answer gave in `commit`) lists only what may have changed since. Only what this server’s service account may read is listed or counted. `leftOut` names the modules matching the filters that have no chunk because they are too large to cut once the modules they refer to are included (`moduleId`, `lang`, `reason` `size` or `depth`, and a `detail`); every other module is listed as usual. Released content whose modules together are too large to cut (many each including a lot) is `chunk-set-too-large`: nothing of that release is listed.',
  inputSchema: {
    lang: Lang.optional().describe('Only chunks in this language.'),
    moduleType: ConfigKey.optional().describe(
      'Only modules of this module type.',
    ),
    audience: ConfigKey.optional().describe(
      'Only modules that count as this audience level: their own, or the last, most restricted level for a module naming none.',
    ),
    facets: Facets.optional(),
    keywords: Keywords.optional(),
    manual: Id.optional().describe('Only the modules this manual includes.'),
    variant: VariantSlug.optional().describe(
      'Resolve variant blocks for this variant (with `manual`: only the entries it includes for it).',
    ),
    changedSince: z
      .string()
      .regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, 'a full commit ID')
      .optional()
      .describe(
        'Only chunks that may have changed since this commit (the `commit` of an earlier answer).',
      ),
    ref: RefArgument.optional(),
    cursor: PageCursor.optional(),
  },
  async run({ api, refs, signal }, args) {
    const ref = await refs.resolve(args.ref, signal);
    const { body, commit } = await getChunks(api, {
      ref,
      'filter[lang]': args.lang,
      'filter[type]': args.moduleType,
      'filter[audience]': args.audience,
      'filter[facet]': args.facets,
      'filter[keyword]': args.keywords,
      'filter[manual]': args.manual,
      'filter[variant]': args.variant,
      'filter[changedSince]': args.changedSince,
      'page[number]': String(pageOf(args.cursor)),
      'page[size]': String(CHUNKS_PAGE_SIZE),
    });
    const page = parseAnswer(ChunkPage, body);
    return {
      structured: {
        ref,
        commit: commit ?? null,
        total: page.meta.page.total,
        nextCursor: nextPage(page.meta.page),
        leftOut: (page.meta.leftOut ?? []).map(leftOutOf),
        chunks: page.data.map((chunk) => {
          const slice = sliceText(
            chunk.attributes.text,
            undefined,
            CHUNK_TEXT_LIMIT,
          );
          const { entry } = chunk.attributes;
          return {
            id: chunk.id,
            ...chunkMetadata(chunk, api, ref),
            entry: entry
              ? { blockId: entry.blockId, question: entry.question }
              : null,
            text: slice.text,
            truncated: slice.nextCursor !== null,
          };
        }),
      },
    };
  },
});
