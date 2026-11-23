import {
  paginate,
  type PageRequest,
  type Paginated,
} from '../../src/base/core/paging.js';
import type { ReadableContent } from '../../src/content/core/readable-content.js';
import {
  ContentSearch,
  type AskedSearchFilter,
  type SearchHit,
} from '../../src/search/core/content-search.js';

/** A search that answers with the hits it was given, and remembers what it was asked. */
export class FakeContentSearch extends ContentSearch {
  readonly asked: {
    content: ReadableContent;
    query: string | undefined;
    filter: AskedSearchFilter;
  }[] = [];

  constructor(private readonly hits: SearchHit[] = []) {
    super();
  }

  search(
    content: ReadableContent,
    query: string | undefined,
    filter: AskedSearchFilter,
    page: PageRequest,
  ): Promise<Paginated<SearchHit>> {
    this.asked.push({ content, query, filter });
    return Promise.resolve(paginate(this.hits, page));
  }
}

export const hit = (id: string, extra: Partial<SearchHit> = {}): SearchHit => ({
  type: 'module',
  id: `en/${id}`,
  lang: 'en',
  title: `Title of ${id}`,
  excerpt: `Title of ${id}`,
  matches: [],
  matchedOn: 'title',
  deprecated: false,
  ...extra,
});
