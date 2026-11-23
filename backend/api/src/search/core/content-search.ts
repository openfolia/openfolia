import type { PageRequest, Paginated } from '../../base/core/paging.js';
import type { ModuleFilter } from '../../content/core/module-filter.js';
import type { ReadableContent } from '../../content/core/readable-content.js';

/** The longest `filter[q]` accepted, in characters. */
export const MAX_QUERY_LENGTH = 200;

/** Only this many words of a query are used (every word has to match). */
export const MAX_QUERY_WORDS = 8;

/** A match in a hit's `excerpt`: UTF-16 offsets, `start` inclusive, `end` exclusive. */
export interface MatchRange {
  start: number;
  end: number;
}

/**
 * One thing found: a module in one language (`id` is `<lang>/<moduleId>`, as
 * in the URL), a manual (`id` is its ID, with no language) or a term in one
 * language (`id` is its ID, `lang` the language).
 */
export interface SearchHit {
  type: 'module' | 'manual' | 'term';
  id: string;
  lang?: string;
  title: string;
  /**
   * The block (or list item, procedure step) the text matched in, or the
   * FAQ entry whose question matched; absent unless a module's text or
   * question matched.
   */
  blockId?: string;
  /**
   * Plain text, never markup: the title (a title match, or no query), the
   * matching keywords separated by `, ` (a keyword match), the matching
   * question, or a stretch of the matching block's text.
   */
  excerpt: string;
  /** Where the query's words are in `excerpt`, in order, not overlapping. */
  matches: MatchRange[];
  /**
   * `question`: an FAQ entry's question. `filter`: no query was given, the
   * filters alone found it. `meaning`: only its meaning matched (semantic
   * search, with an embedder): no word of the query is in it, so
   * `matches` is empty and `excerpt` is the closest block's text.
   */
  matchedOn: 'title' | 'keyword' | 'question' | 'text' | 'meaning' | 'filter';
  /** A deprecated module (its source-language file's) or manual (#266); a term never (it has its own status). */
  deprecated: boolean;
}

/**
 * What a search is narrowed to. The module parts (type, audience, facets,
 * keywords) leave manuals and terms out; `lang` leaves manuals out: a
 * manual has none of them.
 */
export interface SearchFilter extends ModuleFilter {
  readonly lang?: string | undefined;
  readonly resourceType?: SearchHit['type'] | undefined;
  /** The configuration's audience levels, least to most restricted, for `audience` (#699). */
  readonly audiences: readonly string[];
}

/** A search's filter as asked for: an adapter adds the audience levels of the content's configuration. */
export type AskedSearchFilter = Omit<SearchFilter, 'audiences'>;

/**
 * Finds content by words: modules by title, keywords, FAQ questions and text, manuals by
 * title, terms by their preferred variant (the title), their other
 * variants (as keywords) and their definition (as text). Case and
 * diacritics do not matter; title matches come before keyword matches,
 * and those before text matches. The filters run first, before paging.
 * Works only on what `content` lets its actor read, so a hit never names
 * anything outside the scope, and the total counts nothing outside it.
 *
 * Two adapters: `InMemoryContentSearch` (every word of the query is in
 * the field, anywhere in a word) and `PostgresContentSearch` (#54: word
 * forms by language, typos in titles and keywords, and, with an
 * `Embedder`, meaning), chosen by `CCMS_SEARCH_ADAPTER`; both pass the
 * same contract (`tests/content-search-contract.ts`).
 */
export abstract class ContentSearch {
  /**
   * One page of the hits for `query` (`total` counts all), best first, ties
   * by title, then type, language and ID: a stable order for paging. `query`
   * is non-empty and at most `MAX_QUERY_LENGTH` long, or undefined when the
   * filters restrict the modules (the route checks both): then everything
   * the filters let through is a hit, ordered by title.
   */
  abstract search(
    content: ReadableContent,
    query: string | undefined,
    filter: AskedSearchFilter,
    page: PageRequest,
  ): Promise<Paginated<SearchHit>>;
}

/** The search's limits per reader, from the settings (`CCMS_SEARCH_PER_MINUTE`, #539). */
export abstract class SearchLimits {
  /** Searches one reader (a person or a service account) may ask for per minute, on this server. */
  abstract readonly perMinute: number;
}
