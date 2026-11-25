import {
  BUILTIN_PAGE_DESIGN_ID,
  Block,
  Manifest,
  ManifestEntry,
  PageDesignId,
  type ResolveIssue as ResolveIssueValue,
} from '@openfolia/content-model';
import { PAGE_WIDTH } from '@openfolia/render-typst';
import { z } from 'zod';
import {
  pagedDocument,
  resourceObject,
  singleDocument,
  toOne,
} from '../../base/api/json-api.js';
import { Issue, ResolveIssue } from '../../base/api/schemas.js';
import type { ManualResolution } from '../../content/core/content.repository.js';
import type { DesignInUse as DesignInUseValue } from '../../content/core/design-in-use.js';
import type { ManualIssue } from '../../content/core/readable-content.js';
import type { ManualListEntry } from '../core/actions/list-manuals.action.js';
import type { VariantSummary as VariantSummaryValue } from '../core/variants.js';
import type { DesignLayoutWarning } from '../core/pdf-renderer.js';

const VariantValues = z
  .record(z.string(), z.string())
  .describe('Variant attribute ID → value, e.g. `{ "model": "large" }`.');

export const VariantSummary = z
  .object({
    slug: z
      .string()
      .describe(
        'Use in `/manuals/{id}/variants/{variant}/…`, e.g. `model=large`.',
      ),
    label: z.string().describe('For people, e.g. "Large · Software 2.3".'),
    values: VariantValues,
  })
  .meta({ id: 'VariantSummary' });

/** The manifest; its `attributes` (text attribute values) are `textAttributes` here. */
export const ManualAttributes = z
  .object({
    schemaVersion: Manifest.shape.schemaVersion,
    kind: Manifest.shape.kind.describe(
      '`derived` (#451): its entries are gathered from another manual by `rule`, never written by hand. `update-guide` (#906): its entries are its `guide`’s steps. Absent: an assembled manual.',
    ),
    title: Manifest.shape.title,
    audience: Manifest.shape.audience,
    deprecated: Manifest.shape.deprecated.describe(
      'Withdrawn or superseded (#266): why, and the manual to use instead. Absent when it is not deprecated.',
    ),
    variants: Manifest.shape.variants,
    textAttributes: Manifest.shape.attributes,
    coverImage: Manifest.shape.coverImage.describe(
      'The cover image its page design shows (#394): `default`, the manual’s, and `variants`, a variant’s own by its exact values, which wins. Absent: the design’s.',
    ),
    rule: Manifest.shape.rule.describe(
      'A derived manual’s rule (#451): `source`, the manual it gathers from; `moduleTypes`, the types it gathers (absent: the configured safety types); `exclude`, modules left out; `front` and `back`, its own modules before and after. Absent for an assembled manual.',
    ),
    guide: Manifest.shape.guide.describe(
      'An update guide’s own part (#906): `attribute`, the version attribute it follows; `versions`, the versions a reader picks from, oldest first; `steps`, each a `module` with the `version` that needs it, its `phase` (`before`, `during`, `after`) and optionally a `level` (an audience ID) and a `when` condition on the reader’s options. Only the steps whose module the reader may see. Absent for other kinds.',
    ),
    entries: z
      .array(ManifestEntry)
      .describe(
        'Only the modules the reader may see (groups left empty go too), so it can be empty. A derived manual’s are the ones its rule gathers, front matter first, back matter last; an update guide’s one per step, by version and phase.',
      ),
  })
  .meta({ id: 'ManualAttributes' });

/** The page design a manual is printed with (#589): `meta.design` of a manual and of a release's output. */
export const DesignInUse = z
  .object({
    id: z
      .string()
      .describe(
        `The design's ID (\`design/<id>.yaml\`); \`${BUILTIN_PAGE_DESIGN_ID}\` for the built-in design.`,
      ),
    name: z
      .string()
      .nullable()
      .describe(
        'The design’s name; null for the built-in design and for a design that is not there.',
      ),
    source: z
      .enum(['manual', 'project', 'builtin'])
      .describe(
        '`manual`: the manifest’s own `design`; `project`: the project’s default (`pdf.design` in the configuration); `builtin`: neither names one.',
      ),
    missing: z
      .boolean()
      .describe(
        'The design named is not in the content (or its file is no design): the PDF uses the built-in design, and the manual’s checks report `unknown-page-design`.',
      ),
  })
  .meta({ id: 'DesignInUse' });

export const ManualResource = resourceObject('Manual', {
  attributes: ManualAttributes,
  meta: z.object({
    variants: z
      .array(VariantSummary)
      .describe('The published variants, with the slugs other routes take.'),
    issues: z.array(Issue),
    /** The page design the manual is printed with at the ref (#589). */
    design: DesignInUse,
    deleted: z
      .object({
        commit: z.string().describe('The commit that deleted it.'),
        committedAt: z.string().describe('When (ISO 8601).'),
      })
      .optional()
      .describe(
        'Set for a manual deleted on the ref’s first-parent line (`filter[status]`, #321): its newest deletion. The rest is then its last manifest the reader may see.',
      ),
  }),
}).meta({ id: 'ManualResource' });

/** A manifest as `ManualAttributes`. */
export function toManualAttributes(
  manifest: Manifest,
): z.infer<typeof ManualAttributes> {
  return {
    schemaVersion: manifest.schemaVersion,
    ...(manifest.kind === undefined ? {} : { kind: manifest.kind }),
    title: manifest.title,
    ...(manifest.audience === undefined ? {} : { audience: manifest.audience }),
    ...(manifest.deprecated === undefined
      ? {}
      : { deprecated: manifest.deprecated }),
    variants: manifest.variants,
    textAttributes: manifest.attributes,
    ...(manifest.coverImage === undefined
      ? {}
      : { coverImage: manifest.coverImage }),
    ...(manifest.rule === undefined ? {} : { rule: manifest.rule }),
    ...(manifest.guide === undefined ? {} : { guide: manifest.guide }),
    entries: manifest.entries,
  };
}

/** A manifest that cannot be read; listed so it does not hide the others. */
export const UnreadableManualResource = resourceObject('Manual', {
  meta: z.object({ error: z.string().describe('Why it cannot be read.') }),
}).meta({ id: 'UnreadableManualResource' });

export const ManualDocument = singleDocument(ManualResource).meta({
  id: 'ManualDocument',
});

export const ManualPageDocument = pagedDocument(
  z.union([ManualResource, UnreadableManualResource]),
).meta({ id: 'ManualPageDocument' });

export function toManualResource(entry: {
  id: string;
  manifest: Manifest;
  variants: VariantSummaryValue[];
  issues: ManualIssue[];
  design: DesignInUseValue;
  deleted?: { commit: string; committedAt: string } | undefined;
}): z.infer<typeof ManualResource> {
  return {
    type: 'Manual',
    id: entry.id,
    attributes: toManualAttributes(entry.manifest),
    meta: {
      variants: entry.variants,
      issues: entry.issues,
      design: { ...entry.design },
      ...(entry.deleted && { deleted: { ...entry.deleted } }),
    },
  };
}

export function toManualListResource(
  entry: ManualListEntry,
): z.infer<typeof ManualPageDocument>['data'][number] {
  if ('error' in entry) {
    return { type: 'Manual', id: entry.id, meta: { error: entry.error } };
  }
  return toManualResource(entry);
}

type ResolvedEntry =
  | {
      kind: 'module';
      module: string;
      title: string;
      lang: string;
      blocks: Block[];
    }
  | { kind: 'group'; title: string; entries: ResolvedEntry[] };

export const ResolvedEntry: z.ZodType<ResolvedEntry> = z
  .lazy(() =>
    z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('module'),
        module: z.string(),
        title: z.string(),
        lang: z
          .string()
          .describe('Differs from the manual when a translation is missing.'),
        blocks: z.array(Block),
      }),
      z.object({
        kind: z.literal('group'),
        title: z.string(),
        entries: z.array(ResolvedEntry),
      }),
    ]),
  )
  .meta({ id: 'ResolvedEntry' });
export const ResolvedManualResource = resourceObject('ResolvedManual', {
  attributes: z.object({
    title: z.string(),
    lang: z.string(),
    variant: VariantValues,
    entries: z.array(ResolvedEntry),
    origins: z
      .record(z.string(), z.object({ module: z.string(), block: z.string() }))
      .describe('Output block ID → the module and block it came from.'),
    anchors: z
      .record(z.string(), z.string())
      .describe('`module` or `module#block` → the output block ID to link to.'),
    callouts: z
      .record(z.string(), z.record(z.string(), z.number().int().min(1)))
      .optional()
      .describe(
        'Output image block ID → callout ID → its number in this variant (#498): what a `calloutRef` reads as. Absent without callouts.',
      ),
    xrefTitles: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Module ID → title, in the manual’s language or its fallback, of each module a cross-reference links to that is no entry of the manual (#796): what a cross-reference without its own text reads as. Only modules the reader may see and the manual’s audience allows.',
      ),
  }),
  relationships: z.object({ manual: toOne('Manual') }),
  meta: z.object({ issues: z.array(ResolveIssue) }),
})
  .describe('`id` is `<manual>/<variant>/<lang>`, as in the URL.')
  .meta({ id: 'ResolvedManualResource' });

export const ResolvedManualDocument = singleDocument(
  ResolvedManualResource,
).meta({ id: 'ResolvedManualDocument' });

export function toResolvedManualResource(
  variant: string,
  { manual, issues }: ManualResolution,
): z.infer<typeof ResolvedManualResource> {
  // An update guide's steps (#906) are their own route's, and hold the entries again.
  const { id, updateSteps: _steps, ...attributes } = manual;
  return {
    type: 'ResolvedManual',
    id: `${id}/${variant}/${manual.lang}`,
    attributes,
    relationships: { manual: { data: { type: 'Manual', id } } },
    meta: { issues: issues satisfies ResolveIssueValue[] },
  };
}

/** Pages past this are never thumbnails; a larger number is refused before rendering. */
export const MAX_PAGE = 9999;
/** The width of a page image (`…/pdf/pages/:page.png`) when none is asked for. */
export const DEFAULT_PAGE_WIDTH = 480;

/** The page image route's page and `width`, validated before rendering. */
export const pageImageParams = {
  page: z
    .string()
    .regex(/^[1-9][0-9]{0,3}$/, `a page number from 1 to ${MAX_PAGE}`)
    .transform(Number),
  width: z
    .string()
    .regex(/^[0-9]{1,4}$/, 'a whole number of pixels')
    .transform(Number)
    .refine(
      (w) => w >= PAGE_WIDTH.min && w <= PAGE_WIDTH.max,
      `from ${PAGE_WIDTH.min} to ${PAGE_WIDTH.max} pixels`,
    )
    .optional(),
};

/**
 * `?design=`: lay the manual out with this page design in place of its own (#392, the design
 * screen's preview), by ID; `builtin` for the built-in design.
 */
export const DesignQuery = z
  .union([z.literal(BUILTIN_PAGE_DESIGN_ID), PageDesignId])
  .optional();

export const DESIGN_QUERY_DESCRIPTION = `For the design screen: lay the manual out with this page design (\`design/<id>.yaml\`, read at \`ref\`, and its working copy with \`workingCopy=true\`) in place of the manual's own; \`${BUILTIN_PAGE_DESIGN_ID}\` for the built-in design. A design that is not there gives the built-in design, as for a manual naming one. Default: the manual's own (its manifest's \`design\`, else \`pdf.design\`).`;

export const LayoutWarningResource = resourceObject('LayoutWarning', {
  attributes: z.object({
    code: z
      .enum(['page-design-overflow', 'running-head-truncated'])
      .describe(
        '`page-design-overflow`: a title or back page region does not fit its place and is cut off; `running-head-truncated`: a running header or footer is shortened with an ellipsis.',
      ),
    at: z
      .string()
      .describe(
        'Where in the page design, as a dotted path (`regions.footer`, `header.default.left`).',
      ),
    page: z.number().int().describe('The first page it happens on.'),
    pages: z.number().int().describe('On how many pages it happens.'),
    text: z
      .string()
      .optional()
      .describe('A shortened running head’s whole text.'),
  }),
})
  .describe('`id` is `<code>:<at>`.')
  .meta({ id: 'LayoutWarningResource' });

export const LayoutWarningPageDocument = pagedDocument(
  LayoutWarningResource,
).meta({ id: 'LayoutWarningPageDocument' });

export function toLayoutWarningResource(
  warning: DesignLayoutWarning,
): z.infer<typeof LayoutWarningResource> {
  return {
    type: 'LayoutWarning',
    id: `${warning.code}:${warning.at}`,
    attributes: {
      code: warning.code,
      at: warning.at,
      page: warning.page,
      pages: warning.pages,
      ...(warning.text !== undefined && { text: warning.text }),
    },
  };
}
