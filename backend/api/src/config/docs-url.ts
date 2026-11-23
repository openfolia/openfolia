import { z } from 'zod';
import { sourceUrl } from './source-url.js';

/** The public documentation site, the default of `CCMS_DOCS_URL`. */
export const DEFAULT_DOCS_URL = 'https://docs.openfolia.com/';

/**
 * `CCMS_DOCS_URL` (#471, #221): where the user guide is, for the editor's
 * "Learn more" and help links (`GET /about`, `docsUrl`); a page is found
 * under it by its path (`guide/change-sets/base-rewritten`, after `de/` in
 * German). An `http://` or `https://` URL without credentials, as
 * `CCMS_SOURCE_URL` is (the editor links to it), always ending in `/`;
 * `off` turns the links off (null), for an instance with no way out.
 */
export const docsUrl = z.union([
  z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.literal('off'))
    .transform(() => null),
  sourceUrl.transform((href) => (href.endsWith('/') ? href : `${href}/`)),
]);
