import { createFromSource } from 'fumadocs-core/search/server';
import { source } from '@/lib/source';
import { pagesOf } from '@/lib/tree';

/** The search index, exported at build time and searched in the browser (`components/search.tsx`). */
export const revalidate = false;

// Only the pages each language's routes make: German has no operation pages of its own (its
// sidebar links to the English ones), so its index must not offer `/de/api/…` addresses.
const built: typeof source = Object.assign(Object.create(source), {
  getPages: () => [...pagesOf('en'), ...pagesOf('de')],
});

export const { staticGET: GET } = createFromSource(built);
