import { z } from 'zod';
import { pagedDocument, resourceObject } from '../../base/api/json-api.js';
import type { SearchHit } from '../core/content-search.js';

export const SearchMatch = z
  .object({
    start: z.number().int().min(0).describe('First UTF-16 unit of the match.'),
    end: z
      .number()
      .int()
      .min(0)
      .describe('One past the last UTF-16 unit of the match.'),
  })
  .meta({ id: 'SearchMatch' });

export const SearchResultResource = resourceObject('SearchResult', {
  attributes: z.object({
    resourceType: z
      .enum(['Module', 'Manual', 'Term'])
      .describe(
        'What was found: a `Module` (one language), a `Manual` or a `Term` (one language).',
      ),
    resourceId: z
      .string()
      .describe(
        'Its ID as in the URL: `<lang>/<moduleId>` for a module, the manual ID, the term ID.',
      ),
    lang: z
      .string()
      .optional()
      .describe(
        'The language of a module, or the one a term was found in; a manual has none.',
      ),
    title: z
      .string()
      .describe('The title; for a term, its preferred variant in `lang`.'),
    blockId: z
      .string()
      .optional()
      .describe(
        'The block, list item or step the text matched in, or the FAQ entry whose question matched. Absent unless a module’s text or question matched.',
      ),
  }),
  relationships: z.object({
    resource: z.object({
      data: z.object({
        type: z.enum(['Module', 'Manual', 'Term']),
        id: z.string(),
      }),
    }),
  }),
  meta: z.object({
    matchedOn: z
      .enum(['title', 'keyword', 'question', 'text', 'meaning', 'filter'])
      .describe(
        'What matched `filter[q]`: the title, a keyword, an FAQ entry’s question (its block in `blockId`), or the text (for a term: its preferred variant, one of its allowed or forbidden variants, or its definition); `meaning` when only its meaning matched (semantic search, with an embedder configured: `matches` is empty, `blockId` names the closest block); `filter` when no query was given and the filters alone found it.',
      ),
    excerpt: z
      .string()
      .describe(
        'Plain text, never markup: the title (a title match, or no query), the matching keywords separated by `, ` (a keyword match), the matching question, or a stretch of the matching (or, for `meaning`, the closest) block. Show it as text.',
      ),
    matches: z
      .array(SearchMatch)
      .describe(
        'Where the query’s words are in `excerpt`, in order, not overlapping: offsets in UTF-16 units (JavaScript string indexes).',
      ),
    deprecated: z
      .boolean()
      .describe(
        'A deprecated module (by its source-language file) or manual (#266), for a badge. A term is never: its status is its own (`GET /terms`).',
      ),
  }),
})
  .describe(
    '`id` is `<type>:<resourceId>` (`term:<lang>/<termId>` for a term); one result per module and language, manual, or term and language.',
  )
  .meta({ id: 'SearchResultResource' });

export const SearchPageDocument = pagedDocument(SearchResultResource).meta({
  id: 'SearchPageDocument',
});

const RESOURCE_TYPES = {
  module: 'Module',
  manual: 'Manual',
  term: 'Term',
} as const satisfies Record<SearchHit['type'], string>;

export function toSearchResource(
  hit: SearchHit,
): z.infer<typeof SearchResultResource> {
  const resourceType = RESOURCE_TYPES[hit.type];
  return {
    type: 'SearchResult',
    id:
      hit.type === 'term'
        ? `term:${hit.lang ?? ''}/${hit.id}`
        : `${hit.type}:${hit.id}`,
    attributes: {
      resourceType,
      resourceId: hit.id,
      ...(hit.lang === undefined ? {} : { lang: hit.lang }),
      title: hit.title,
      ...(hit.blockId === undefined ? {} : { blockId: hit.blockId }),
    },
    relationships: { resource: { data: { type: resourceType, id: hit.id } } },
    meta: {
      matchedOn: hit.matchedOn,
      excerpt: hit.excerpt,
      matches: hit.matches,
      deprecated: hit.deprecated,
    },
  };
}
