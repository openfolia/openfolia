import { z } from 'zod';
import { resourceObject, singleDocument } from '../../base/api/json-api.js';

/** The core's licence (`LICENSE`), as an SPDX identifier, and where its text is published. */
export const LICENSE = 'AGPL-3.0-only';
export const LICENSE_URL = 'https://www.gnu.org/licenses/agpl-3.0.html';

export const AboutResource = resourceObject('About', {
  attributes: z.object({
    license: z
      .literal(LICENSE)
      .describe('The software’s licence, as an SPDX identifier.'),
    licenseUrl: z.url().describe('Where the licence’s text is published.'),
    sourceUrl: z
      .url()
      .nullable()
      .describe(
        'Where this deployment’s source code is (`CCMS_SOURCE_URL`), as AGPL-3.0 section 13 asks a network service to offer it. Null when the operator has not set it.',
      ),
    docsUrl: z
      .url()
      .nullable()
      .describe(
        'Where the user guide is (`CCMS_DOCS_URL`, default `https://docs.openfolia.com/`), ending in `/`: a client links to a page by its path under it (`guide/change-sets/base-rewritten`), after `de/` for German. Null when the operator turned the links off.',
      ),
  }),
})
  .describe('`id` is always `about`.')
  .meta({ id: 'AboutResource' });

export const AboutDocument = singleDocument(AboutResource).meta({
  id: 'AboutDocument',
});
