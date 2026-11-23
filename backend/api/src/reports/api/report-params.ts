import { ConfigKey } from '@openfolia/content-model';
import { z } from 'zod';
import { params } from '../../base/api/schemas.js';
import {
  USAGE_SORT_FIELDS,
  type UsageSort,
  type UsageSortField,
} from '../core/module-usage-report.js';

/** Who may read the reports, for the OpenAPI descriptions. */
export const REPORT_PERMISSION_NOTE =
  'Needs `content.read.draft` (in any scope), on top of reading content (`content.read`); what it names and counts is limited by the reader’s scope, its languages included.';

export const BooleanFilter = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

export const ManualFilter = params.manualId;
export const LangFilter = params.lang;
export const TypeFilter = ConfigKey;

const SORT_FIELD = new RegExp(`^-?(${USAGE_SORT_FIELDS.join('|')})$`);

/** `sort`: comma-separated fields, each ascending or (`-`) descending, each once. */
export const UsageSortParam = z
  .string()
  .transform((v) => v.split(','))
  .pipe(
    z
      .array(
        z
          .string()
          .regex(
            SORT_FIELD,
            `a field (${USAGE_SORT_FIELDS.join(', ')}), \`-\` before it for descending`,
          ),
      )
      .min(1)
      .max(
        USAGE_SORT_FIELDS.length,
        `At most ${USAGE_SORT_FIELDS.length} fields.`,
      )
      .refine(
        (fields) =>
          new Set(fields.map((f) => f.replace(/^-/, ''))).size ===
          fields.length,
        'Each field at most once.',
      ),
  )
  .transform((fields): UsageSort[] =>
    fields.map((f) => ({
      field: f.replace(/^-/, '') as UsageSortField,
      descending: f.startsWith('-'),
    })),
  );

export const SORT_DESCRIPTION = `Comma-separated fields (\`${USAGE_SORT_FIELDS.join('`, `')}\`; \`manuals\` and \`modules\` are the use counts, \`usage\` their sum), each \`-\`-prefixed for descending, each at most once; ties by title, then ID. Default: \`title\`.`;

export const COVERAGE_FILTERS = [
  {
    name: 'manual',
    description:
      'Only this manual; one the reader may not see (or that does not exist) matches nothing.',
  },
  {
    name: 'lang',
    description:
      'Only this target language; one that is not a target language matches nothing.',
  },
];

export const USAGE_FILTERS = [
  {
    name: 'unused',
    description:
      '`true`: only modules no manual includes, directly or through module references (a module only other modules refer to is unused if none of them is in a manual); `false`: only modules some manual includes.',
  },
  {
    name: 'type',
    description:
      'Only modules of this module type; one the configuration does not know matches nothing.',
  },
];

export const COVERAGE_DESCRIPTION = `One \`TranslationCoverage\` per manual the reader may see and target language they may read it in, at \`?ref=\`: how many of the modules it includes (also through module references) are up to date, outdated, at a provider or missing in that language, and how many of their blocks. A module counts exactly where \`GET /translations/status\` lists it (so \`filter[manual]\`, \`filter[lang]\` and \`filter[kind]=module\` there list the modules counted here; beside them, \`meta.design\`, \`meta.cover\` and \`meta.labels\` count the units of the manual's page design's region text (#656), of its own text (its title, its groups' titles, #731, and its cover images' alternative text, #656) and of the project labels (#731), as the status lists them with \`filter[kind]=design\`, \`filter[kind]=manual\` and \`filter[kind]=config\`); nothing outside the reader’s scope is named or counted. Ordered by the manual’s title, its ID and the configured order of target languages; a manifest that cannot be read is left out.`;

export const USAGE_DESCRIPTION = `One \`ModuleUsage\` per module the reader may see in some language, at \`?ref=\`, from the module index: how many manuals include it (directly or through module references) and how many modules refer to it, with \`meta.usedIn\`. Only manuals and modules the reader may see are named or counted, and a manual counts through module references only where the reader may see every module on the way. A module file that cannot be read is left out.`;
