import { LanguageTag, ModuleId } from '@openfolia/content-model';
import { z } from 'zod';
import {
  pagedDocument,
  resourceObject,
  singleDocument,
} from '../../base/api/json-api.js';
import type { ReleaseOutput } from '../../releases/core/release-output.js';
import type { Release } from '../../releases/core/release.js';
import {
  holdsPdf,
  type IirdsPackage,
} from '../core/actions/iirds-packages.action.js';
import { iirdsFileName, type IirdsWarning } from '../core/iirds-package.js';

const WARNING_CODES = [
  'unmapped-module-type',
  'unmapped-audience',
  'unmapped-facet',
  'unmapped-variant-attribute',
  'unmapped-lifecycle-phase',
  'missing-asset',
  'pdf-not-included',
  'manual-empty',
] as const satisfies readonly IirdsWarning['code'][];

const attributes = z.object({
  manual: z.string().describe('The manual’s ID.'),
  variant: z
    .string()
    .describe('The variant’s slug, e.g. `model=large` (the manifest’s).'),
  lang: z.string().describe('The language, a language tag.'),
  fileName: z
    .string()
    .describe(
      'The name it downloads as: `<manual>_<variant>_<lang>_<revision>.iirds`.',
    ),
  pdf: z
    .boolean()
    .describe(
      'Whether it holds the manual’s PDF as a rendition of its document: once the release output is `done`.',
    ),
});

const links = z.object({
  self: z.string(),
  file: z.string().describe('The package itself (`GET …/file`).'),
});

export const IirdsPackageResource = resourceObject('IirdsPackage', {
  attributes,
  links,
})
  .describe(
    'The iiRDS package of one release output (its `id` is the output’s): the manual in one variant and language, made at the release’s tag as the manual’s audience reads it.',
  )
  .meta({ id: 'IirdsPackageResource' });

export const IirdsPackagePageDocument = pagedDocument(
  IirdsPackageResource,
).meta({ id: 'IirdsPackagePageDocument' });

export const IirdsWarningSchema = z
  .object({
    code: z
      .enum(WARNING_CODES)
      .describe(
        'Stable. `unmapped-*`: the configuration’s mapping (`iirds` in `openfolia.yaml`) names no iiRDS class for something the package holds, so that metadata is left out; `missing-asset`: a file a module refers to is not stored; `pdf-not-included`: the PDF is not done; `manual-empty`: the manual holds no module its audience reads in this variant, so the package holds its document alone, with no topic and no table of contents.',
      ),
    id: z
      .string()
      .describe(
        'What it is about: the module type, audience, facet, variant attribute, `<facet>/<value>`, asset (`sha256:…`) or output.',
      ),
    detail: z.string(),
  })
  .meta({ id: 'IirdsWarning' });

export const IirdsPackageDocument = singleDocument(
  IirdsPackageResource.extend({
    meta: z.object({
      size: z.number().int().describe('The package’s size in bytes.'),
      topics: z
        .number()
        .int()
        .describe('How many topics (the manual’s modules, as HTML) it holds.'),
      media: z
        .number()
        .int()
        .describe(
          'How many media files (images, attached files, safety symbols) it holds.',
        ),
      warnings: z
        .array(IirdsWarningSchema)
        .describe(
          'What it left out or could not map, each once. Bounded by the configuration and the manual (at most one per module type, audience, facet value, variant attribute and file).',
        ),
    }),
  }).describe(
    'The iiRDS package, made: its size, what it holds and its warnings.',
  ),
).meta({ id: 'IirdsPackageDocument' });

/** Filter parameters of `GET /releases/:releaseId/iirds-packages`, validated before any query. */
export const iirdsPackageFilters = { manual: ModuleId, lang: LanguageTag };

export function toIirdsPackageResource(
  release: Pick<Release, 'id' | 'revision'>,
  output: ReleaseOutput,
): z.infer<typeof IirdsPackageResource> {
  const self = `/releases/${release.id}/iirds-packages/${output.id}`;
  return {
    type: 'IirdsPackage',
    id: output.id,
    attributes: {
      manual: output.manualId,
      variant: output.variant,
      lang: output.lang,
      fileName: iirdsFileName(output, release.revision),
      pdf: holdsPdf(output),
    },
    links: { self, file: `${self}/file` },
  };
}

export function toIirdsPackageDocument(
  made: IirdsPackage,
): z.infer<typeof IirdsPackageDocument> {
  const resource = toIirdsPackageResource(made.release, made.output);
  return {
    data: {
      ...resource,
      attributes: { ...resource.attributes, pdf: made.plan.pdf },
      meta: {
        size: made.size,
        topics: made.plan.topics,
        media: made.plan.media,
        warnings: made.plan.warnings.map((w) => ({ ...w })),
      },
    },
  };
}
