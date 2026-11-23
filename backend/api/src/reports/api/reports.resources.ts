import { ConfigKey, LanguageTag, ModuleId } from '@openfolia/content-model';
import { z } from 'zod';
import { pagedDocument, resourceObject } from '../../base/api/json-api.js';
import { ModuleUse } from '../../modules/api/module.resources.js';
import { MAX_USED_IN } from '../../modules/core/readable-module-index.js';
import type { ModuleUsageRow } from '../core/module-usage-report.js';
import type {
  CoverageCounts,
  TranslationCoverage,
} from '../core/translation-coverage.js';

const count = z.int().min(0);

export const CoverageCountsSchema = z
  .object({
    total: count,
    upToDate: count,
    outdated: count.describe(
      'The source changed since, a block was never translated, or the translation has no record.',
    ),
    atProvider: count.describe('Sent to a translation provider, not back yet.'),
    missing: count.describe('No file in that language.'),
  })
  .describe(
    'How many stand in each translation state (`TranslationState`); the four add up to `total`.',
  )
  .meta({ id: 'CoverageCounts' });

export const TranslationCoverageResource = resourceObject(
  'TranslationCoverage',
  {
    attributes: z
      .object({
        manualId: ModuleId,
        lang: LanguageTag.describe('The target language.'),
      })
      .meta({ id: 'TranslationCoverageAttributes' }),
    meta: z.object({
      title: z.string().describe('The manual’s title.'),
      deprecated: z.boolean().describe('The manual is deprecated (#266).'),
      modules: CoverageCountsSchema.describe(
        'The modules the manual includes (also through module references) that the reader sees in the source language and would see a translation of in this language, each once, by its state in `GET /translations/status`.',
      ),
      blocks: CoverageCountsSchema.describe(
        'The translatable blocks of those modules, by their state.',
      ),
      design: CoverageCountsSchema.describe(
        'The units of the region text of the page design the manual is laid out with (#656), by their state in `GET /translations/status` (`kind` `design`); all 0 for the built-in design or one without region text.',
      ),
      cover: CoverageCountsSchema.describe(
        'The units of the manual’s own text, by their state in `GET /translations/status` (`kind` `manual`): its title and its groups’ titles (#731), and its cover images’ alternative text (#656).',
      ),
      labels: CoverageCountsSchema.describe(
        'The units of the project labels (#731: the labels in `openfolia.yaml`, which the manual’s title page and metadata show), by their state in `GET /translations/status` (`kind` `config`); all 0 without labels. The same for every manual in a language.',
      ),
    }),
  },
)
  .describe('`id` is `<manualId>/<lang>`: one manual in one target language.')
  .meta({ id: 'TranslationCoverageResource' });

export const TranslationCoveragePageDocument = pagedDocument(
  TranslationCoverageResource,
).meta({ id: 'TranslationCoveragePageDocument' });

export const ModuleUsageResource = resourceObject('ModuleUsage', {
  attributes: z
    .object({
      moduleId: ModuleId,
      title: z
        .string()
        .describe(
          'Its source-language file’s title, else its first file’s the reader sees.',
        ),
      type: ConfigKey.describe('Its module type, from the same file.'),
      deprecated: z.boolean().describe('Deprecated (#266), by the same file.'),
    })
    .meta({ id: 'ModuleUsageAttributes' }),
  meta: z.object({
    languages: z
      .array(LanguageTag)
      .describe(
        'The languages the reader sees it in, in the configured order.',
      ),
    usage: z
      .object({
        manuals: count.describe(
          'The manuals including it, directly or through module references.',
        ),
        modules: count.describe(
          'The modules whose module reference blocks name it.',
        ),
      })
      .meta({ id: 'ModuleUsageCounts' }),
    usedIn: z
      .array(ModuleUse)
      .max(MAX_USED_IN)
      .describe(
        `Where it is used: manuals first, then modules, each by title; at most ${MAX_USED_IN} (\`usage\` counts them all). Only manuals and modules the reader may see are named or counted.`,
      ),
  }),
})
  .describe('`id` is the module ID: the module in any language.')
  .meta({ id: 'ModuleUsageResource' });

export const ModuleUsagePageDocument = pagedDocument(ModuleUsageResource).meta({
  id: 'ModuleUsagePageDocument',
});

const counts = (c: CoverageCounts): CoverageCounts => ({
  total: c.total,
  upToDate: c.upToDate,
  outdated: c.outdated,
  atProvider: c.atProvider,
  missing: c.missing,
});

export function toTranslationCoverageResource(
  row: TranslationCoverage,
): z.infer<typeof TranslationCoverageResource> {
  return {
    type: 'TranslationCoverage',
    id: `${row.manualId}/${row.lang}`,
    attributes: { manualId: row.manualId, lang: row.lang },
    meta: {
      title: row.title,
      deprecated: row.deprecated,
      modules: counts(row.modules),
      blocks: counts(row.blocks),
      design: counts(row.design),
      cover: counts(row.cover),
      labels: counts(row.labels),
    },
  };
}

export function toModuleUsageResource(
  row: ModuleUsageRow,
): z.infer<typeof ModuleUsageResource> {
  return {
    type: 'ModuleUsage',
    id: row.moduleId,
    attributes: {
      moduleId: row.moduleId,
      title: row.title,
      type: row.type,
      deprecated: row.deprecated,
    },
    meta: {
      languages: [...row.languages],
      usage: { manuals: row.manuals, modules: row.modules },
      usedIn: row.uses.slice(0, MAX_USED_IN).map((use) => ({ ...use })),
    },
  };
}
