import { firstValueFrom } from 'rxjs';

import {
  compileWritingRules,
  type ProjectConfig,
  type Term,
  type WritingRules,
} from '@openfolia/content-model/core';

import { pageQuery, type ApiClient } from '../api';
import { TermHints } from '../doc-editor/writing/term-hints';
import type { WritingAids } from '../doc-editor/writing/writing-aids';
import { contentOf, isReadable } from '../terminology/terms-model';

/** Terms read per page (the API's largest page). */
export const TERM_PAGE = 200;
/**
 * At most this many pages: 10,000 terms, the size the writing checks are measured at (#55). Past
 * that, the first terms by ID are checked and offered.
 */
export const TERM_PAGES = 50;

/** The writing aids for a document, and whether every term was read. */
export interface LoadedWritingAids extends WritingAids {
  readonly complete: boolean;
}

/**
 * The writing aids for a document in `lang` (#247): every term holding that language
 * (`GET /terms` with `filter[lang]`, at the chosen change set's branch, as the person may read
 * them), compiled with the configuration's `styleRules` and `terminology` into the same checks
 * the API runs (`compileWritingRules`). Read once per editing session, branch head and save
 * point (the page's resource decides when). Rules the engine refuses check nothing (the API's
 * checks still say why).
 */
export async function loadWritingAids(
  api: ApiClient,
  config: ProjectConfig,
  lang: string,
  signal?: AbortSignal,
): Promise<LoadedWritingAids> {
  const terms: Term[] = [];
  let complete = false;
  for (let page = 1; page <= TERM_PAGES; page++) {
    // Superseded (another language, branch head or save point): no more pages read.
    signal?.throwIfAborted();
    const doc = await firstValueFrom(
      api.get('/terms', {
        query: {
          'filter[lang]': lang,
          ...pageQuery({ number: page, size: TERM_PAGE }),
        },
      }),
    );
    for (const item of doc.data) {
      if (isReadable(item)) terms.push(contentOf(item) as Term);
    }
    if (!doc.links.next) {
      complete = true;
      break;
    }
  }
  let rules: WritingRules | null;
  try {
    rules = compileWritingRules({
      terms,
      styleRules: config.styleRules,
      terminology: config.terminology,
      lang,
    });
  } catch {
    rules = null;
  }
  return { rules, terms: new TermHints(terms, lang), complete };
}
