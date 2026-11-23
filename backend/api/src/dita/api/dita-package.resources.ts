import { LanguageTag, ModuleId } from '@openfolia/content-model';
import { DITA_EXPORT_WARNINGS, MAX_EXPORT_WARNINGS } from '@openfolia/dita';
import { z } from 'zod';
import {
  pagedDocument,
  resourceObject,
  singleDocument,
} from '../../base/api/json-api.js';
import type { ReleaseOutput } from '../../releases/core/release-output.js';
import type { Release } from '../../releases/core/release.js';
import type { DitaPackage } from '../core/actions/dita-packages.action.js';
import {
  DITA_LANGUAGES,
  DITA_REFERENCES,
  ditaFileName,
  type DitaOptions,
} from '../core/dita-package.js';

const attributes = z.object({
  manual: z.string().describe('The manual’s ID.'),
  variant: z
    .string()
    .describe(
      'The variant’s slug, e.g. `model=large` (the manifest’s): the one its DITAVAL file filters for.',
    ),
  lang: z.string().describe('The output’s language, a language tag.'),
  fileName: z
    .string()
    .describe(
      'The name it downloads as: `<manual>_<variant>_<lang>_<revision>-dita.zip` (`all` for the language with `languages=all`).',
    ),
});

const links = z.object({
  self: z.string(),
  file: z.string().describe('The package itself (`GET …/file`).'),
});

export const DitaPackageResource = resourceObject('DitaPackage', {
  attributes,
  links,
})
  .describe(
    'The DITA 1.3 package of one release output (its `id` is the output’s): the manual as a map and topics, made at the release’s tag as the manual’s audience reads it, with a DITAVAL file for the output’s variant.',
  )
  .meta({ id: 'DitaPackageResource' });

export const DitaPackagePageDocument = pagedDocument(DitaPackageResource).meta({
  id: 'DitaPackagePageDocument',
});

export const DitaExportWarningSchema = z
  .object({
    code: z
      .enum(DITA_EXPORT_WARNINGS)
      .describe(
        'Stable: what the export could not say in DITA, wrote in another form, or left out (`docs/dita-export.md` lists each).',
      ),
    module: z
      .string()
      .optional()
      .describe('The module (or the manual) it is about.'),
    block: z.string().optional().describe('The block it is about, in it.'),
    lang: z.string().optional().describe('The language folder it is about.'),
    detail: z.string(),
    count: z
      .number()
      .int()
      .describe('How many times it came up in that module and language.'),
  })
  .meta({ id: 'DitaExportWarning' });

export const DitaPackageDocument = singleDocument(
  DitaPackageResource.extend({
    meta: z.object({
      size: z.number().int().describe('The package’s size in bytes.'),
      languages: z
        .array(z.string())
        .describe('The languages it holds, each a folder of the package.'),
      references: z
        .enum(DITA_REFERENCES)
        .describe('How module references are written (`references`).'),
      topics: z
        .number()
        .int()
        .describe('How many topics it holds (each module once per language).'),
      media: z
        .number()
        .int()
        .describe(
          'How many media files (images, attached files, safety symbols) it holds.',
        ),
      warnings: z
        .array(DitaExportWarningSchema)
        .describe(
          `What the export wrote in another form or left out, once per code, module and language (at most ${MAX_EXPORT_WARNINGS}).`,
        ),
      warningsDropped: z
        .number()
        .int()
        .describe(
          `How many warnings past the first ${MAX_EXPORT_WARNINGS} are not listed.`,
        ),
    }),
  }).describe(
    'The DITA package, made: its size, what it holds and its warnings.',
  ),
).meta({ id: 'DitaPackageDocument' });

/** Filter parameters of `GET /releases/:releaseId/dita-packages`, validated before any query. */
export const ditaPackageFilters = { manual: ModuleId, lang: LanguageTag };

/** The options of `GET …/dita-packages/:id` and its `file`. */
export const ditaOptionParams = {
  languages: z.enum(DITA_LANGUAGES, {
    error: 'Give `languages` as `output` or `all`.',
  }),
  references: z.enum(DITA_REFERENCES, {
    error: 'Give `references` as `conref` or `resolved`.',
  }),
};

export const DITA_OPTION_QUERIES = [
  {
    name: 'languages',
    required: false,
    description:
      '`output` (the default): the output’s language only; `all`: every configured language you may read the whole manual in, each a folder.',
    schema: { type: 'string', enum: [...DITA_LANGUAGES] },
  },
  {
    name: 'references',
    required: false,
    description:
      '`conref` (the default): a module reference is a content reference (`@conref`, `@conrefend`) where DITA can say one, else its content; `resolved`: always its content.',
    schema: { type: 'string', enum: [...DITA_REFERENCES] },
  },
] as const;

/** The query that asks for these options, the defaults left out. */
function optionQuery(options: DitaOptions | undefined): string {
  if (!options) return '';
  const params = new URLSearchParams();
  if (options.languages !== 'output')
    params.set('languages', options.languages);
  if (options.references !== 'conref')
    params.set('references', options.references);
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

export function toDitaPackageResource(
  release: Pick<Release, 'id' | 'revision'>,
  output: ReleaseOutput,
  options?: DitaOptions,
): z.infer<typeof DitaPackageResource> {
  const self = `/releases/${release.id}/dita-packages/${output.id}`;
  const query = optionQuery(options);
  return {
    type: 'DitaPackage',
    id: output.id,
    attributes: {
      manual: output.manualId,
      variant: output.variant,
      lang: output.lang,
      fileName: ditaFileName(
        output,
        release.revision,
        options?.languages ?? 'output',
      ),
    },
    links: { self: `${self}${query}`, file: `${self}/file${query}` },
  };
}

export function toDitaPackageDocument(
  made: DitaPackage,
): z.infer<typeof DitaPackageDocument> {
  return {
    data: {
      ...toDitaPackageResource(made.release, made.output, made.options),
      meta: {
        size: made.size,
        languages: [...made.plan.languages],
        references: made.options.references,
        topics: made.plan.topics,
        media: made.plan.media,
        warnings: made.plan.warnings.map((w) => ({ ...w })),
        warningsDropped: made.plan.warningsDropped,
      },
    },
  };
}
