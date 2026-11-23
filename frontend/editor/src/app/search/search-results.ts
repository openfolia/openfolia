import type { TextRange } from '@openfolia/ui/highlighted-text';

import { isRecent, type RecentItem } from './recent-items';
import type { SearchResult } from './palette-search';

/** A row of the palette that opens a module or a manual: a search result or a recent item. */
export interface OpenableRow {
  /** The option's value, unique in the palette. */
  readonly key: string;
  readonly item: RecentItem;
  /** The block the text matched in, for the module's address. */
  readonly blockId?: string;
  /** Offsets of the matches in the title (a title match). */
  readonly titleMatches: readonly TextRange[];
  /** The second line: the matching text (a text match), the matching keywords (a keyword match), the matching FAQ question (a question match) or the ID. */
  readonly detail: string;
  readonly detailMatches: readonly TextRange[];
  readonly textMatch: boolean;
  /** Found by its keywords, not by its title or text. */
  readonly keywordMatch: boolean;
  /** Found by one of its FAQ entries' questions (the entry is `blockId`). */
  readonly questionMatch: boolean;
  /** The module or manual is deprecated (#266); a recent item does not know. */
  readonly deprecated?: boolean;
}

/** A search result as a palette row; null for one the palette cannot open (a term, a malformed ID). */
export function resultRow(result: SearchResult): OpenableRow | null {
  const { attributes, meta } = result;
  let item: RecentItem;
  if (attributes.resourceType === 'Module') {
    const lang = attributes.lang;
    const prefix = `${lang ?? ''}/`;
    if (!lang || !attributes.resourceId.startsWith(prefix)) return null;
    item = {
      kind: 'module',
      id: attributes.resourceId.slice(prefix.length),
      lang,
      title: attributes.title,
    };
  } else if (attributes.resourceType === 'Manual') {
    item = {
      kind: 'manual',
      id: attributes.resourceId,
      title: attributes.title,
    };
  } else {
    // A term: the palette opens modules and manuals only, until terms have a screen (#246).
    return null;
  }
  // Only an ID the palette can open and remember (a slug, a language tag) makes a row.
  if (!isRecent(item)) return null;
  // A match by meaning alone (#54) shows its closest block's text, like a text match.
  const textMatch = meta.matchedOn === 'text' || meta.matchedOn === 'meaning';
  const keywordMatch = meta.matchedOn === 'keyword';
  const questionMatch = meta.matchedOn === 'question';
  const inDetail = textMatch || keywordMatch || questionMatch;
  return {
    key: `result:${result.id}`,
    item,
    blockId: attributes.blockId,
    // A title match's excerpt is the title; anything else is not highlighted in the title.
    titleMatches:
      meta.matchedOn === 'title' && meta.excerpt === attributes.title
        ? meta.matches
        : [],
    detail: inDetail ? meta.excerpt : item.id,
    detailMatches: inDetail ? meta.matches : [],
    textMatch,
    keywordMatch,
    questionMatch,
    deprecated: meta.deprecated,
  };
}

/** A recent item as a palette row. */
export function recentRow(item: RecentItem): OpenableRow {
  return {
    key: `recent:${item.kind}:${item.lang ?? ''}:${item.id}`,
    item,
    titleMatches: [],
    detail: item.id,
    detailMatches: [],
    textMatch: false,
    keywordMatch: false,
    questionMatch: false,
  };
}

/** The address a row opens: a module's (`/content/<lang>/<id>`) or a manual's (`/manuals/<id>`). */
export function rowLink(item: RecentItem): string[] {
  return item.kind === 'module'
    ? ['/content', item.lang ?? '', item.id]
    : ['/manuals', item.id];
}
