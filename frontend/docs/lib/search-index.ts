import { createFromSource } from 'fumadocs-core/search/server';
import { source } from '@/lib/source';
import { pagesOf } from '@/lib/tree';
import type { Lang } from '@/lib/i18n';

/**
 * One language's search index, exported at build time (`/search-<lang>.json`) and searched in the
 * browser (`components/search.tsx`), so a reader downloads only their own language (#949).
 *
 * - Only the pages that language's routes make: German has no operation pages of its own (its
 *   sidebar links to the English ones), so its index must not offer `/de/api/…` addresses.
 * - No `i18n` flag: the file holds one language, so no locale field is indexed or filtered.
 * - Only what the search uses is indexed: the text (`content`) and the page it groups by
 *   (`page_id`). Fumadocs' default schema also indexes the URL, the type, the breadcrumbs, the
 *   tags and a 512-number vector per entry, and builds sort tables the search never uses.
 *
 * The built file's size is held by `scripts/check-search-budget.mjs`.
 */
export function searchIndexOf(lang: Lang) {
  const built: typeof source = Object.assign(Object.create(source), {
    getPages: () => pagesOf(lang),
    _i18n: undefined,
  });
  // shortcut: the typed options omit `schema`, which the index builder passes on to the database
  // (it replaces the default); upgrade when Fumadocs types it.
  const options = {
    schema: { content: 'string', page_id: 'string' },
    sort: { enabled: false },
  };
  return createFromSource(built, options).staticGET;
}
