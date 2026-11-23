import { firstValueFrom } from 'rxjs';

import { pageQuery, type ApiClient } from '../api';
import type { SnippetSuggestion } from '../doc-editor/snippets/snippet-match';

/** Snippets read per page. */
const PAGE_SIZE = 100;
/** At most this many pages are read: past that, the first snippets by title are suggested. */
const MAX_PAGES = 10;

/**
 * The snippets to suggest in a document in `lang`: `GET /module-summaries` with
 * `filter[snippet]=true` in that language (at the chosen change set's branch), so only those the
 * person may read, each with the start of its text (`meta.text`). Paged, ordered by title, at
 * most `PAGE_SIZE × MAX_PAGES`.
 */
export async function loadSnippets(
  api: ApiClient,
  lang: string,
): Promise<SnippetSuggestion[]> {
  const found: SnippetSuggestion[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const doc = await firstValueFrom(
      api.get('/module-summaries', {
        query: {
          'filter[snippet]': 'true',
          'filter[lang]': lang,
          ...pageQuery({ number: page, size: PAGE_SIZE }),
        },
      }),
    );
    for (const s of doc.data) {
      // Only snippets in the document's language: never another language's wording.
      if (s.attributes.titleLang !== lang || !s.meta.text) continue;
      found.push({ id: s.id, title: s.attributes.title, text: s.meta.text });
    }
    if (!doc.links.next) break;
  }
  return found;
}
