import {
  PageDesign,
  type PageDesign as PageDesignValue,
  type PageDesignIssue as PageDesignIssueValue,
} from '@openfolia/content-model';
import { z } from 'zod';
import {
  pagedDocument,
  resourceObject,
  singleDocument,
} from '../../base/api/json-api.js';
import type { PageDesignEntry } from '../core/actions/list-page-designs.action.js';

export const PageDesignIssue = z
  .object({
    severity: z.enum(['error', 'warning']),
    code: z
      .string()
      .describe(
        'Stable machine-readable code, e.g. `low-contrast`, `unknown-placeholder`, `missing-asset`.',
      ),
    message: z.string(),
    at: z
      .string()
      .optional()
      .describe(
        'Where in the design, as a dotted path (`regions.footer.en`, `colours.primary`); absent for the design as a whole.',
      ),
    block: z
      .string()
      .optional()
      .describe('The block of a region’s text the problem is in, by ID.'),
  })
  .meta({ id: 'PageDesignIssue' });

/** Every setting of a design as its file holds it (defaults filled in), without its ID. */
export const PageDesignAttributes = PageDesign.omit({ id: true });

export const PageDesignResource = resourceObject('PageDesign', {
  attributes: PageDesignAttributes,
  meta: z.object({
    issues: z
      .array(PageDesignIssue)
      .describe(
        'Problems found checking it against the configuration (a placeholder, language or variant attribute it does not know, too little contrast, fonts not confirmed for embedding, …). The list leaves out its assets; `GET /page-designs/:designId` checks them against the blob store (and the older `assets/<sha256>` layout) too.',
      ),
  }),
})
  .describe(
    '`id` is the design’s ID, its file name (`design/<id>.yaml`); a manual names it in `design`, the configuration as `pdf.design` for every manual naming none.',
  )
  .meta({ id: 'PageDesignResource' });

/** A file in `design/` that is no design; listed so it does not hide. */
export const UnreadablePageDesignResource = resourceObject('PageDesign', {
  attributes: z.object({}),
  meta: z.object({ error: z.string().describe('Why it cannot be read.') }),
}).meta({ id: 'UnreadablePageDesignResource' });

export const PageDesignDocument = singleDocument(PageDesignResource).meta({
  id: 'PageDesignDocument',
});

export const PageDesignPageDocument = pagedDocument(
  z.union([PageDesignResource, UnreadablePageDesignResource]),
).meta({ id: 'PageDesignPageDocument' });

export function toPageDesignResource(
  design: PageDesignValue,
  issues: readonly PageDesignIssueValue[],
): z.infer<typeof PageDesignResource> {
  const { id, ...attributes } = design;
  return {
    type: 'PageDesign',
    id,
    attributes,
    meta: { issues: issues.map((issue) => ({ ...issue })) },
  };
}

export function toPageDesignListResource(
  entry: PageDesignEntry,
):
  | z.infer<typeof PageDesignResource>
  | z.infer<typeof UnreadablePageDesignResource> {
  return 'error' in entry
    ? {
        type: 'PageDesign',
        id: entry.id,
        attributes: {},
        meta: { error: entry.error },
      }
    : toPageDesignResource(entry.design, entry.issues);
}
