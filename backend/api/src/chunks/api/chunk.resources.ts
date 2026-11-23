import {
  BlockId,
  LanguageTag,
  ModuleId,
  ModuleMeta,
} from '@openfolia/content-model';
import { z } from 'zod';
import {
  PageLinks,
  PageMeta,
  resourceObject,
} from '../../base/api/json-api.js';
import type { ModuleStatus } from '../../modules/core/actions/get-module-statuses.action.js';
import type { ListedChunk } from '../core/actions/list-chunks.action.js';

const Sha256 = z
  .string()
  .regex(/^[0-9a-f]{64}$/, '64 lowercase hex characters');

export const ChunkResource = resourceObject('Chunk', {
  attributes: z.object({
    moduleId: ModuleId,
    lang: LanguageTag,
    title: ModuleMeta.shape.title,
    moduleType: ModuleMeta.shape.type.describe(
      'One of the configured module types, e.g. `procedure`.',
    ),
    audience: ModuleMeta.shape.audience.describe(
      'The module’s audience level; absent: the most restricted level. Text from a more restricted module is never in the chunk.',
    ),
    facets: ModuleMeta.shape.facets,
    keywords: z
      .array(z.string())
      .describe(
        'Free-form keywords in the module’s language; empty when there are none.',
      ),
    manuals: z
      .array(ModuleId)
      .describe(
        'The manuals that include the module (their manifests name it, within their audience), as the reader may see them; sorted.',
      ),
    conditions: z
      .array(z.string())
      .describe(
        'The conditions of the variant blocks in the text, as `when` text (`model in (large)`), in document order, each once; on an FAQ entry’s chunk, those of the variant blocks it stands in first. Listed also when `filter[variant]` resolved them.',
      ),
    text: z
      .string()
      .describe(
        'The module as Markdown (CommonMark with GFM tables): the title as `#` heading, sections as headings, procedure steps numbered, tables as Markdown tables, safety messages and notes as quotes headed by their signal word, images as their alt text, attachments by name, referenced modules inlined. Without `filter[variant]` each variant block is a quote headed by `**when**` and its condition. Text attributes stay `{name}`. Markup characters in the content are backslash-escaped; no HTML but `<br>` between the lines of a table cell.',
      ),
    sourceHash: Sha256.describe(
      'SHA-256 of the module’s own source: of its translation units’ source hashes, or of its canonical AsciiDoc when it has none.',
    ),
    contentHash: Sha256.describe(
      'SHA-256 of `text` (UTF-8). Equal text, equal hash: re-embed only when it changes.',
    ),
    entry: z
      .object({
        blockId: BlockId.describe('The FAQ entry’s block ID in the module.'),
        question: z
          .string()
          .describe(
            'The question as plain text; a text attribute as `{name}`.',
          ),
      })
      .optional()
      .describe(
        'Only on an FAQ entry’s chunk: its `text` is that entry (the question as `#` heading, then its answer) and `sourceHash`, `conditions` and `meta.sources` are the entry’s; the other attributes stay the module’s. The module’s own chunk keeps its entries in its text too.',
      ),
  }),
  relationships: z.object({
    module: z.object({
      data: z.object({ type: z.literal('Module'), id: z.string() }),
      links: z.object({
        related: z
          .string()
          .describe('The module in the API, at the commit read.'),
      }),
    }),
  }),
  meta: z.object({
    ref: z.string().describe('The ref the chunk was read at (`?ref=`).'),
    commit: z.string().describe('The commit the chunk was read at.'),
    sources: z
      .array(z.object({ moduleId: ModuleId, lang: LanguageTag }))
      .describe(
        'The module files the text was made from: the module first, then each module it includes, in the language read.',
      ),
    release: z
      .object({
        tag: z.string().describe('The release tag.'),
        commit: z.string().describe('A commit ID.'),
        same: z
          .boolean()
          .describe('Whether the module there is exactly the one read.'),
      })
      .nullable()
      .describe(
        'The module’s newest release (tag), as `meta.status.release` of `GET /modules/{lang}/{id}`: the product revision a pipeline filters by. Null when none of the 50 newest holds it.',
      ),
  }),
})
  .describe(
    '`id` is `<lang>/<moduleId>`: one chunk per module and language; and `<lang>/<moduleId>/<blockId>` for each FAQ entry in it, which has a chunk of its own (`attributes.entry`).',
  )
  .meta({ id: 'ChunkResource' });

/** A module left out of the chunks (#688). */
export const LeftOutModule = z
  .object({
    moduleId: ModuleId,
    lang: LanguageTag,
    reason: z
      .enum(['size', 'depth'])
      .describe(
        '`size`: once its module references are included it holds more than 500,000 content nodes, 12,000,000 characters or 1,000,000 table cells (rows × columns) (a module referred to over several paths counts once per path); `depth`: its blocks and references nest more than 100 deep.',
      ),
  })
  .meta({ id: 'LeftOutModule' });

export const ChunkPageDocument = z
  .object({
    data: z.array(ChunkResource),
    meta: z.object({
      page: PageMeta,
      leftOut: z
        .array(LeftOutModule)
        .optional()
        .describe(
          'The modules the filters ask for (all but `filter[changedSince]`) that have no chunk because they are too large to cut (#688), in module ID, then language order; absent when there is none. Every other module is chunked as usual, and these are not counted in `meta.page.total`; with `filter[variant]`, a module too large for that variant alone is left out of the page holding it, named there, and still counted. Only modules you may read are named. The module’s checks report it as `expansion-too-large`.',
        ),
    }),
    links: PageLinks,
  })
  .meta({ id: 'ChunkPageDocument' });

export function toChunkResource(
  chunk: ListedChunk,
  read: { ref: string; commit: string },
  status: ModuleStatus | undefined,
): z.infer<typeof ChunkResource> {
  const moduleId = `${chunk.lang}/${chunk.moduleId}`;
  return {
    type: 'Chunk',
    id: chunk.entry ? `${moduleId}/${chunk.entry.blockId}` : moduleId,
    attributes: {
      moduleId: chunk.moduleId,
      lang: chunk.lang,
      title: chunk.title,
      moduleType: chunk.moduleType,
      ...(chunk.audience !== undefined && { audience: chunk.audience }),
      facets: chunk.facets,
      keywords: chunk.keywords,
      manuals: chunk.manuals,
      conditions: chunk.conditions,
      text: chunk.text,
      sourceHash: chunk.sourceHash,
      contentHash: chunk.contentHash,
      ...(chunk.entry && {
        entry: {
          blockId: chunk.entry.blockId,
          question: chunk.entry.question,
        },
      }),
    },
    relationships: {
      module: {
        data: { type: 'Module', id: moduleId },
        links: {
          related: `/modules/${encodeURIComponent(chunk.lang)}/${encodeURIComponent(chunk.moduleId)}?ref=${read.commit}`,
        },
      },
    },
    meta: {
      ref: read.ref,
      commit: read.commit,
      sources: chunk.sources,
      release: status?.release ?? null,
    },
  };
}
