import { Injectable } from '@nestjs/common';
import { DEFAULT_SEARCH_INDEXES } from '../../config/env.js';
import {
  paginate,
  type PageRequest,
  type Paginated,
} from '../../base/core/paging.js';
import { filtersModules } from '../../content/core/module-filter.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import { Recent } from '../../base/core/recent.js';
import {
  ContentSearch,
  MAX_QUERY_WORDS,
  type AskedSearchFilter,
  type SearchFilter,
  type SearchHit,
} from '../core/content-search.js';
import {
  buildEntries,
  byTitle,
  foldText,
  hitOf,
  indexKey,
  passesFilter,
  type IndexedBlock,
  type IndexedEntry,
  withAudiences,
} from './search-entries.js';

/** Indexes kept by default, most recently used first out; each holds about twice the readable text, shared where modules are the same. */
export const INDEXES_KEPT = DEFAULT_SEARCH_INDEXES;

/** Recent searches whose ranked hits are kept per index (`InMemoryContentSearch.#ranked`). */
const RANKINGS_PER_INDEX = 8;

/** Index builds running at once. */
const MAX_BUILDS = 2;

/** Runs at most `max` tasks at a time; the others wait their turn, first come first served. A failing task frees its slot like any other. */
export class Limit {
  #running = 0;
  readonly #waiting: (() => void)[] = [];
  constructor(readonly max: number) {}

  /** A finished task hands its slot straight to the next waiter, so no newcomer can slip in between and exceed `max`. */
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#running < this.max) this.#running++;
    else await new Promise<void>((resolve) => this.#waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#running--;
    }
  }
}

const isWordCharacter = (character: string | undefined) =>
  character !== undefined && /[\p{L}\p{N}]/u.test(character);

/** Whether `word` occurs in `folded` at the start of a word. */
function startsAWord(folded: string, word: string): boolean {
  for (
    let at = folded.indexOf(word);
    at >= 0;
    at = folded.indexOf(word, at + 1)
  ) {
    if (!isWordCharacter(folded[at - 1])) return true;
  }
  return false;
}

/**
 * Lower is better: the title equals the query, starts with it, has a word
 * starting with it, contains it; then an FAQ entry's question, then text
 * (each a word starting with it first). Keyword matches (4 and 5) rank
 * between the title and the questions.
 */
function tier(
  where: 'title' | 'question' | 'text',
  folded: string,
  whole: string,
  words: readonly string[],
): number {
  const atWordStart = words.every((word) => startsAWord(folded, word));
  if (where === 'question') return atWordStart ? 6 : 7;
  if (where === 'text') return atWordStart ? 8 : 9;
  if (folded === whole) return 0;
  if (folded.startsWith(whole)) return 1;
  return atWordStart ? 2 : 3;
}

/**
 * Searches the content in memory: an index of the titles and text the actor
 * may read, built on first use for a commit and a reading scope and kept
 * (at most `INDEXES_KEPT`, least recently used dropped). The index is made
 * from `ReadableContent`, so it holds only what its actor may read, and the
 * key includes the reading key, so two readers share one only when they see
 * the same. A word matches anywhere in a title or in one block's text (every
 * word of the query in the same block); a module whose title matches is
 * found by title, else by its keywords (every word in one of them), else
 * by its first block that matches. The filters run before any of that, so
 * the total counts only what they let through.
 */
@Injectable()
export class InMemoryContentSearch extends ContentSearch {
  /** `indexesKept`: how many indexes are kept (`CCMS_SEARCH_INDEXES`). */
  constructor(private readonly indexesKept: number = INDEXES_KEPT) {
    super();
  }

  readonly #indexes = new Map<string, Promise<IndexedEntry[]>>();
  /** Builds read every file of a commit: only a few at a time, the rest wait. */
  readonly #builds = new Limit(MAX_BUILDS);

  /**
   * The ranked hits of recent searches per index (`#index`'s key), by words
   * and filter: paging through one search, or many readers asking the same,
   * ranks it once. Dropped with their index, so `indexesKept` bounds them
   * too.
   */
  readonly #ranked = new Map<string, Recent<readonly Ranked[]>>();

  async search(
    content: ReadableContent,
    query: string | undefined,
    asked: AskedSearchFilter,
    page: PageRequest,
  ): Promise<Paginated<SearchHit>> {
    const filter = await withAudiences(asked, content);
    const words = queryWords(query ?? '');
    const modulesOnly = filtersModules(filter);
    // Nothing to look for: a query of only spaces, or neither query nor filters.
    if (words.length === 0 && (query !== undefined || !modulesOnly)) {
      return { items: [], total: 0 };
    }
    const key = indexKey(content);
    const index = this.#index(content);
    let rankings = this.#ranked.get(key);
    if (!rankings) {
      rankings = new Recent<readonly Ranked[]>(RANKINGS_PER_INDEX);
      this.#ranked.set(key, rankings);
    }
    const ranked = await rankings.get(
      JSON.stringify([words, filter]),
      async () => rank(await index, words, filter),
    );
    // Excerpts only for the page asked for: a short query matches nearly
    // everything, and folding every matching block would cost the most.
    const { items, total } = paginate(ranked, page);
    return { items: items.map((hit) => hitFor(hit, words)), total };
  }

  #index(content: ReadableContent): Promise<IndexedEntry[]> {
    const key = indexKey(content);
    let found = this.#indexes.get(key);
    if (found) {
      // Most recently used last.
      this.#indexes.delete(key);
    } else {
      found = this.#builds.run(() => buildEntries(content));
      // A failure is not kept: the next search builds it again.
      found.catch(() => {
        if (this.#indexes.get(key) === found) {
          this.#indexes.delete(key);
          this.#ranked.delete(key);
        }
      });
    }
    this.#indexes.set(key, found);
    while (this.#indexes.size > this.indexesKept) {
      const oldest = this.#indexes.keys().next().value;
      if (oldest === undefined) break;
      this.#indexes.delete(oldest);
      this.#ranked.delete(oldest);
    }
    return found;
  }
}

/** A query's words as this search matches them: folded, split at whitespace, each once, at most `MAX_QUERY_WORDS`. */
export function queryWords(query: string): string[] {
  return [
    ...new Set(
      foldText(query)
        .split(/\s+/)
        .filter((word) => word !== ''),
    ),
  ].slice(0, MAX_QUERY_WORDS);
}

export interface Ranked {
  readonly tier: number;
  readonly entry: IndexedEntry;
  readonly matchedOn: SearchHit['matchedOn'];
  /** The text the excerpt comes from; the block or question it is in. */
  readonly text: string;
  readonly block?: IndexedBlock;
}

/** Whether every word is in `folded`. */
function hasEvery(folded: string, words: readonly string[]): boolean {
  for (const word of words) if (!folded.includes(word)) return false;
  return true;
}

/** The first of `blocks` holding every word. */
function blockWithEvery(
  blocks: readonly IndexedBlock[],
  words: readonly string[],
): IndexedBlock | undefined {
  for (const block of blocks) if (hasEvery(block.folded, words)) return block;
  return undefined;
}

/**
 * Every entry of `index` the filter lets through that matches `words`
 * (all of them: none, only the filter), ranked: by tier, then title, then
 * type, language and ID. A module whose title matches is found by title,
 * else by its keywords, else by an FAQ question, else by its first block
 * holding every word.
 */
export function rank(
  index: readonly IndexedEntry[],
  words: readonly string[],
  filter: SearchFilter,
): Ranked[] {
  const modulesOnly = filtersModules(filter);
  const whole = words.join(' ');
  const ranked: Ranked[] = [];
  for (const entry of index) {
    if (!passesFilter(entry, filter, modulesOnly)) continue;
    if (words.length === 0) {
      ranked.push({ tier: 0, entry, matchedOn: 'filter', text: entry.title });
      continue;
    }
    if (hasEvery(entry.titleFolded, words)) {
      ranked.push({
        tier: tier('title', entry.titleFolded, whole, words),
        entry,
        matchedOn: 'title',
        text: entry.title,
      });
      continue;
    }
    if (
      words.every((word) => entry.keywordsFolded.some((k) => k.includes(word)))
    ) {
      const matched = entry.keywords.filter((_, i) =>
        words.some((word) => entry.keywordsFolded[i]?.includes(word)),
      );
      ranked.push({
        // A keyword that is the query itself first.
        tier: entry.keywordsFolded.includes(whole) ? 4 : 5,
        entry,
        matchedOn: 'keyword',
        text: matched.join(', '),
      });
      continue;
    }
    const question = blockWithEvery(entry.questions, words);
    if (question) {
      ranked.push({
        tier: tier('question', question.folded, whole, words),
        entry,
        matchedOn: 'question',
        text: question.text,
        block: question,
      });
      continue;
    }
    const block = blockWithEvery(entry.blocks, words);
    if (block) {
      ranked.push({
        tier: tier('text', block.folded, whole, words),
        entry,
        matchedOn: 'text',
        text: block.text,
        // A term's definition is no block.
        ...(entry.type !== 'term' && { block }),
      });
    }
  }
  return ranked.sort((a, b) => a.tier - b.tier || byTitle(a.entry, b.entry));
}

/** The hit a ranked match makes, with its excerpt. */
export function hitFor(hit: Ranked, words: readonly string[]): SearchHit {
  return hitOf(
    hit.entry,
    hit.text,
    hit.matchedOn === 'filter' ? [] : words,
    hit.matchedOn,
    hit.block?.id,
  );
}
